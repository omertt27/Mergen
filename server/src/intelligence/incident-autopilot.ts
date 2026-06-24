/**
 * incident-autopilot.ts — Background autonomous triage, triggered by PagerDuty webhook.
 *
 * Unlike the `triage_incident` MCP tool (which requires an AI IDE to call it),
 * this module fires automatically when PagerDuty sends `incident.triggered`.
 *
 * Flow:
 *   1. Wait a brief buffer-fill delay for browser events to arrive.
 *   2. Pull recent errors and network failures from the ring buffer.
 *   3. Run causal analysis (buildCausalChain).
 *   4. If top hypothesis confidence >= AUTO_EXECUTE_THRESHOLD AND
 *      MERGEN_AUTOPILOT=true, execute the fix and validate.
 *   5. Post all progress as Slack thread replies to the incident thread.
 *
 * Safety gates:
 *   - Requires MERGEN_AUTOPILOT=true (opt-in — off by default).
 *   - Inherits all BLOCKED_PATTERNS from autonomy.ts.
 *   - Only acts at >= 85% confidence.
 *   - Full audit log via executeRemediation().
 */

import { store } from '../sensor/buffer.js';
import { getRunbookForTag } from '../routes/runbooks.js';
import { buildCausalChain, fixActionToCommand } from './causal.js';
import type { CausalChain, Hypothesis } from './causal.js';
import { getRecords, recordVerdict, classifyVerdict, recordRemediationVerdict, isCorpusSeeded, getRealVerdictCount } from './calibration.js';
import { executeRemediation, extractCommand } from './autonomy.js';
import { postThreadReply, postApprovalRequest, fetchIncidentChannelContext, postSimpleWebhookNotification } from './slack.js';
import { requestApproval } from './execution-gate.js';
import { approvalEvents } from './approval-events.js';
import { deriveRollback, executeRollback } from './rollback.js';
import { captureSnapshot } from './incident-replay.js';
import { computeBlastRadius } from './blast-radius.js';
import { getExecutionThreshold } from './threshold-optimizer.js';
import { isAutopilotEnabled, isShadowMode } from './execution-mode.js';
import { incidentStore } from '../sensor/incident-store.js';
import { getActiveIncident } from '../datadog/incident-state.js';
import { fetchErrorCountSince, isConfigured as isDatadogConfigured } from '../datadog/client.js';
import { normalizeRuntimeFactMarkdown, normalizeProcessExits, normalizeSlackContext } from '../sensor/infra-normalizer.js';
import { getK8sEvents } from '../sensor/k8s-events.js';
import { hasRecentOverride, dominantOverrideReason } from './override-corpus.js';
import { cacheIncidentResult, getCachedIncidentResult } from './incident-result-cache.js';
import { recordShadow, type ShadowEntry } from './shadow-log.js';
import { getAutopilotLevel, autopilotLevelPermits, classifyCommandRisk, autopilotLevelDescription } from './action-risk.js';
import { recordBlunder } from '../sensor/agent-blunder-store.js';
import { getStatsForTag } from './calibration.js';
import { runAgentPipeline } from './agent-pipeline.js';
import { planningGate } from './planning-gate.js';
import { plattScale } from './platt-scaling.js';
import { formatValidatedFactsForLLM } from './llm-spokesperson.js';
import { serviceGraph } from '../sensor/service-graph.js';
import { routeReachability } from '../sensor/route-reachability.js';
import { updateRunbookFromPostmortem } from './runbook-updater.js';
import { generatePostmortem } from './postmortem-store.js';
import logger from '../sensor/logger.js';

// Forward approval expiry events to the Slack thread without coupling
// execution-gate.ts → slack.ts directly.
approvalEvents.on('approval:expired', (pid: string, text: string) => {
  postThreadReply(pid, text).catch((err) => logger.error({ err, pid }, 'approval:expired: slack reply failed'));
});

/** Wrapper that logs an error when a Slack reply fails instead of silently dropping it. */
async function replyToThread(pid: string, text: string): Promise<void> {
  const ok = await postThreadReply(pid, text);
  if (!ok) logger.error({ pid }, 'incident-autopilot: Slack reply failed — engineer may not see this update');
}

const ANALYSIS_TIMEOUT_MS = 30_000;

// Dedup: prevent re-triaging the same incident fingerprint within this window.
// PagerDuty may re-fire (reassigned, re-triggered) for the same root cause.
const DEDUP_TTL_MS = 30 * 60 * 1_000; // 30 min
const _recentlyTriaged = new Map<string, number>();

// Concurrency cap: at most N simultaneous LLM inference calls.
// Prevents cost spikes when many services page at the same time.
const MAX_CONCURRENT_AUTOPILOT = 3;
let _activeCalls = 0;

// Periodic cleanup of the dedup map so it doesn't grow unbounded when many
// unique incident fingerprints arrive. Without this the map only shrinks when
// size > 200 AND a new incident triggers the inline cleanup check.
setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [k, v] of _recentlyTriaged) if (v < cutoff) _recentlyTriaged.delete(k);
}, DEDUP_TTL_MS).unref();

// Observability counters — exposed via getCostGuardStats().
const _stats = {
  dedupHits:           0,
  corpusFastPathHits:  0,
  executedFastPathHits: 0,
  concurrencyBlocked:  0,
  tokenBudgetTruncations: 0,
  concurrentPeak:      0,
};

/** Returns live cost-guard metrics for the health endpoint and dashboards. */
export function getCostGuardStats() {
  return { ..._stats, concurrentActive: _activeCalls };
}
export function _resetTriagedForTesting(): void { _recentlyTriaged.clear(); }

// Threshold is derived from the calibration corpus at runtime (ROC analysis).
// Falls back to 0.85 if fewer than 20 verdicts exist. Recomputed every 10 min.
// Provisional bump (+5pp) when the local corpus has <10 real verdicts: the
// published accuracy is from built-in priors, not from this environment's history.
// Composes with planning-gate blast-risk adjustments (independent, additive).
const getAutoExecuteThreshold = () => {
  const base = getExecutionThreshold();
  const provisional = isCorpusSeeded() || getRealVerdictCount() < 10;
  return provisional ? Math.min(0.95, base + 0.05) : base;
};

// Read env flags lazily so tests can set process.env in beforeEach without
// needing vi.hoisted() to front-run module-level evaluation.
// isAutopilotEnabled / isShadowMode are imported from execution-mode.ts.

// Base URL for one-click verdict links embedded in shadow mode Slack messages.
// Defaults to localhost — set MERGEN_BASE_URL for remote/cloud deployments.
const getBaseUrl = () => (process.env.MERGEN_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

function buildVerdictLinks(entry: ShadowEntry): string {
  const base = getBaseUrl();
  const approve  = `${base}/shadow-report/${entry.id}/verdict?v=approve`;
  const override = `${base}/shadow-report/${entry.id}/verdict?v=override&reason=on-call-discretion`;
  return `\n<${approve}|✅ Approve>  ·  <${override}|✋ Override>`;
}

// Wait for telemetry to arrive after a PagerDuty trigger.
// Polls the buffer at 250ms intervals — returns as soon as MIN_EVENTS arrive,
// or after MAX_WAIT_MS regardless (avoids indefinite stalls for infra-only incidents
// that produce no browser telemetry).
const TELEMETRY_WAIT_MAX_MS   = 10_000;
const TELEMETRY_POLL_INTERVAL = 250;
const TELEMETRY_MIN_EVENTS    = 3;

async function waitForTelemetry(firedAt: number, tenantId?: string): Promise<void> {
  const deadline = Date.now() + TELEMETRY_WAIT_MAX_MS;
  while (Date.now() < deadline) {
    const logs = store.getLogs(TELEMETRY_MIN_EVENTS, undefined, firedAt, tenantId);
    const net  = store.getNetwork(TELEMETRY_MIN_EVENTS, undefined, firedAt, tenantId);
    if (logs.length + net.length >= TELEMETRY_MIN_EVENTS) return;
    await new Promise((r) => setTimeout(r, TELEMETRY_POLL_INTERVAL));
  }
  // Deadline reached — proceed with whatever is in the buffer
}

export interface AutopilotOpts {
  service: string;
  pid: string;
  firedAt: number;
  cwd?: string;
  /** Cloud mode: restrict buffer reads to this tenant's events only. */
  tenantId?: string;
}

export async function runIncidentAutopilot(opts: AutopilotOpts): Promise<void> {
  if (!isAutopilotEnabled() && !isShadowMode()) {
    logger.debug({ service: opts.service }, 'incident-autopilot: disabled (set MERGEN_AUTOPILOT=true or MERGEN_SHADOW_MODE=true)');
    return;
  }

  const { service, pid, firedAt, cwd } = opts;
  logger.info({ service, pid }, 'incident-autopilot: starting');

  // ── Dedup guard (autopilot only — shadow mode re-analyzes freely) ────────
  // PagerDuty re-fires for reassigned/re-triggered incidents. Prevent paying
  // for a second LLM call when the root cause hasn't changed.
  // Shadow mode is diagnostic: skipping dedup preserves the calibration track record.
  if (!isShadowMode()) {
    const lastTriaged = _recentlyTriaged.get(pid);
    if (lastTriaged && Date.now() - lastTriaged < DEDUP_TTL_MS) {
      _stats.dedupHits++;
      logger.info({ service, pid }, 'incident-autopilot: duplicate fingerprint within 30min — skipping re-analysis');
      await replyToThread(pid, '_Mergen: same incident fingerprint already triaged within 30 min — skipping re-analysis._');
      return;
    }
    _recentlyTriaged.set(pid, Date.now());
    if (_recentlyTriaged.size > 200) {
      const cutoff = Date.now() - DEDUP_TTL_MS;
      for (const [k, v] of _recentlyTriaged) if (v < cutoff) _recentlyTriaged.delete(k);
    }
  }

  // ── Result cache fast-paths (autopilot only) ─────────────────────────────
  // Shadow mode always runs full analysis for calibration accuracy.
  if (!isShadowMode()) {
    const cached = getCachedIncidentResult(pid);
    if (cached?.corpusBlocked) {
      _stats.corpusFastPathHits++;
      logger.info({ service, pid, tag: cached.incidentTag }, 'incident-autopilot: corpus fast-path — skipping LLM inference');
      await replyToThread(
        pid,
        `⚠️ _Autopilot: corpus fast-path — incident pattern \`${cached.incidentTag}\` was previously blocked by the override corpus for \`${service}\`. Awaiting manual action._`,
      );
      return;
    }
    if (cached?.executedCommand) {
      _stats.executedFastPathHits++;
      const agoMin = Math.round((Date.now() - cached.cachedAt) / 60_000);
      logger.info({ service, pid, cmd: cached.executedCommand }, 'incident-autopilot: executed fast-path — fix already applied');
      await replyToThread(
        pid,
        `_Mergen: fix \`${cached.executedCommand}\` was applied for this incident ${agoMin} min ago — skipping re-analysis. If the issue persists, override the cache via POST /overrides._`,
      );
      return;
    }
  }

  // ── Concurrency gate ──────────────────────────────────────────────────────
  // Cap simultaneous LLM calls to avoid cost spikes when many services page at once.
  if (_activeCalls >= MAX_CONCURRENT_AUTOPILOT) {
    const deadline = Date.now() + 2 * 60_000;
    while (_activeCalls >= MAX_CONCURRENT_AUTOPILOT && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (_activeCalls >= MAX_CONCURRENT_AUTOPILOT) {
      _stats.concurrencyBlocked++;
      logger.warn({ service, pid, active: _activeCalls }, 'incident-autopilot: concurrency cap reached — aborting');
      await replyToThread(pid, '_Mergen: too many concurrent analyses in progress — retry in a few minutes or investigate manually._');
      return;
    }
  }

  _activeCalls++;
  if (_activeCalls > _stats.concurrentPeak) _stats.concurrentPeak = _activeCalls;

  return _runAutopilotCore(service, pid, firedAt, cwd, opts.tenantId).finally(() => {
    _activeCalls--;
  });
}

// ── Core analysis (runs with concurrency slot held) ───────────────────────────
// Extracted so runIncidentAutopilot can manage the concurrency counter with
// try/finally semantics without restructuring every return path.
async function _runAutopilotCore(service: string, pid: string, firedAt: number, cwd: string | undefined, tenantId: string | undefined): Promise<void> {

  // Wait for telemetry to accumulate (event-driven, capped at 10s)
  await waitForTelemetry(firedAt, tenantId);

  const logs         = store.getLogs(200, undefined, firedAt, tenantId);
  const network      = store.getNetwork(200, undefined, firedAt, tenantId);
  const contexts     = store.getContext(20, firedAt, tenantId);
  const terminal     = store.getTerminalOutput(100, undefined, firedAt, tenantId);
  const processExits = store.getProcessExits(20, undefined, firedAt, tenantId);
  const ciEvents     = store.getCIEvents(20, undefined, firedAt, tenantId);
  const deployments  = store.getDeployments(10, undefined, firedAt, tenantId);

  // ── Token budget ────────────────────────────────────────────────────────
  // Cap telemetry arrays sent to buildCausalChain. A noisy buffer (200 logs +
  // 200 network events) inflates LLM costs with low-signal data. Strategy:
  // prioritise errors and network failures, keep the most recent of each tier.
  const MAX_BUDGET_LOGS    = 60;
  const MAX_BUDGET_NETWORK = 60;
  const errorLogs   = logs.filter((e) => e.level === 'error').slice(-MAX_BUDGET_LOGS);
  const fillerLogs  = logs.filter((e) => e.level !== 'error').slice(-(MAX_BUDGET_LOGS - errorLogs.length));
  const netFails    = network.filter((n) => n.status >= 400 || !!n.error).slice(-MAX_BUDGET_NETWORK);
  const netOk       = network.filter((n) => n.status < 400 && !n.error).slice(-(MAX_BUDGET_NETWORK - netFails.length));
  const budgetedLogs    = [...fillerLogs, ...errorLogs];  // errors last = most prominent
  const budgetedNetwork = [...netOk, ...netFails];
  if (logs.length > MAX_BUDGET_LOGS || network.length > MAX_BUDGET_NETWORK) {
    _stats.tokenBudgetTruncations++;
    logger.info(
      { service, pid, originalLogs: logs.length, budgetedLogs: budgetedLogs.length, originalNetwork: network.length, budgetedNetwork: budgetedNetwork.length },
      'incident-autopilot: token budget truncated telemetry',
    );
  }

  const errorCount = logs.filter((e) => e.level === 'error').length;
  const netErrors  = network.filter((n) => n.status >= 400 || !!n.error).length;

  // Fetch Slack channel context concurrently with the evidence assembly above.
  // This pulls on-call conversation from the incident channel for the 25-minute
  // window around firedAt. Null when BOT_TOKEN or SLACK_CHANNEL is not configured.
  const slackContextText = await fetchIncidentChannelContext(firedAt).catch(() => null);

  // Build infra signals: Datadog RuntimeFact is the primary source; process exits
  // and Slack context are secondary sources. This lets the autopilot diagnose infra
  // incidents that produce no browser events at all (DB pool exhaustion, OOM kills, etc.)
  // and incorporate on-call discussion as structured causal evidence.
  const activeIncident = getActiveIncident();
  const runtimeFactMarkdown = activeIncident?.runtimeFact ?? null;
  const infraEvents = [
    ...(runtimeFactMarkdown
      ? normalizeRuntimeFactMarkdown(runtimeFactMarkdown, service, firedAt)
      : []),
    ...normalizeProcessExits(processExits),
    ...getK8sEvents(firedAt),
    ...(slackContextText ? normalizeSlackContext(slackContextText, service, firedAt) : []),
  ];
  if (slackContextText) {
    logger.info({ service, pid, chars: slackContextText.length }, 'incident-autopilot: slack channel context added to evidence');
  }

  const hasAnySignal = errorCount > 0 || netErrors > 0 || infraEvents.length > 0;

  if (!hasAnySignal) {
    logger.info({ service, pid }, 'incident-autopilot: no signals found — skipping');
    await replyToThread(pid, '_Mergen autopilot: no errors or infra signals found in buffer — manual investigation required._');
    return;
  }

  // Post the Datadog RuntimeFact to Slack immediately as the incident context
  // block, before causal analysis completes. Engineers see what's broken while
  // Mergen reasons about the fix.
  if (runtimeFactMarkdown) {
    const ageMin = Math.round((Date.now() - firedAt) / 60_000);
    await replyToThread(
      pid,
      [
        `📡 *Mergen Autopilot — Incident Context* (${ageMin}m after alert)`,
        '',
        runtimeFactMarkdown,
      ].join('\n'),
    );
  }

  // ── Graceful degradation: wrap analysis in a timeout ─────────────────────
  let causal: CausalChain | null = null;
  try {
    causal = await Promise.race([
      buildCausalChain(budgetedLogs, budgetedNetwork, contexts, firedAt, terminal, processExits, ciEvents, deployments, infraEvents),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('analysis timeout')), ANALYSIS_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    logger.warn({ err, service, pid }, 'incident-autopilot: causal analysis failed — posting raw telemetry');
    const topErrors   = logs.filter((e) => e.level === 'error').slice(0, 5);
    const topNetFails = network.filter((n) => n.status >= 400 || !!n.error).slice(0, 5);
    await replyToThread(pid, [
      `⚡ *Mergen — Raw Telemetry Snapshot* (analysis unavailable)`,
      `*${errorCount} console errors, ${netErrors} network failures* in window`,
      topErrors.length > 0
        ? `*Top errors:*\n${topErrors.map((e) => `• ${String(e.args?.[0] ?? '').slice(0, 120)}`).join('\n')}`
        : '',
      topNetFails.length > 0
        ? `*Network failures:*\n${topNetFails.map((n) => `• ${n.method} ${n.url} → ${n.status}`).join('\n')}`
        : '',
      `_Manual investigation required — AI analysis unavailable._`,
    ].filter(Boolean).join('\n'));
    return;
  }

  // ── Topology hard filter ────────────────────────────────────────────────────
  // If the service graph has been populated from real OTLP spans, use it as a
  // structural prior. Hypotheses whose implied service has no topological
  // connection to the incident service get a confidence penalty.
  // This eliminates text-hallucinated correlations (LeCun: topology > embeddings).
  if (serviceGraph.size > 0) {
    const callers  = new Set(serviceGraph.getCallers(service));
    const callees  = new Set(serviceGraph.getCallees(service));
    const graphNeighbours = new Set([...callers, ...callees, service]);

    for (const hyp of causal.hypotheses) {
      // Hypotheses that mention upstream cascade patterns get boosted when
      // the graph confirms callers exist; penalised when no callers are known.
      const isUpstream = /upstream|cascade|spike|flood|overload/i.test(hyp.summary);
      if (isUpstream && callers.size === 0) {
        hyp.confidenceScore = Math.max(0, hyp.confidenceScore * 0.7);
      } else if (isUpstream && callers.size > 0) {
        hyp.confidenceScore = Math.min(1, hyp.confidenceScore * 1.1);
      }

      // Hypotheses about DB/cache issues get boosted if graph shows outbound
      // edges to db services; penalised when the service makes no outbound calls.
      const isExternal = /database|db|cache|redis|postgres|mysql|mongo|timeout/i.test(hyp.summary);
      if (isExternal && callees.size === 0) {
        hyp.confidenceScore = Math.max(0, hyp.confidenceScore * 0.75);
      }

      // Route reachability filter: if the hypothesis names a specific HTTP
      // route or endpoint and that route has never appeared in live OTLP
      // SERVER spans, penalise it. This suppresses hypotheses about dead-code
      // paths that a static scanner or LLM may hallucinate as exploitable.
      const routeMatch = hyp.summary.match(/\/(api|v\d|webhooks|auth|admin|internal)[^\s"')>]*/i);
      if (routeMatch && routeReachability.size > 0 && !routeReachability.isReachable(routeMatch[0])) {
        hyp.confidenceScore = Math.max(0, hyp.confidenceScore * 0.7);
      }
    }
    logger.debug(
      { service, callers: callers.size, callees: callees.size, routes: routeReachability.size, hypotheses: causal.hypotheses.length },
      'incident-autopilot: topology filter applied',
    );
  }

  // ── Platt-scale confidence scores ──────────────────────────────────────────
  // Apply calibration at the DISPLAY layer only — raw scores are preserved for
  // classifier input so the model's training domain isn't corrupted.
  // "85% should mean 85 out of 100 past predictions were correct."
  const plattAdjusted = new Map<Hypothesis, number>();
  for (const hyp of causal.hypotheses) {
    const { calibrated, source } = plattScale(hyp.confidenceScore, hyp.tag);
    if (source !== 'raw') plattAdjusted.set(hyp, calibrated);
  }
  // Re-sort by calibrated score without mutating the original (planning gate uses raw)
  causal.hypotheses.sort((a, b) => {
    const aScore = plattAdjusted.get(a) ?? a.confidenceScore;
    const bScore = plattAdjusted.get(b) ?? b.confidenceScore;
    return bScore - aScore;
  });

  // topHyp must be read AFTER the Platt sort so the planning gate, Slack messages,
  // and verdict recording all operate on the calibrated top hypothesis.
  const topHyp = causal.hypotheses[0];

  // Persist telemetry snapshot for deterministic replay and regression testing.
  captureSnapshot({
    pid, capturedAt: Date.now(), firedAt,
    logs, network, contexts, terminal, processExits, ciEvents, deployments, infraEvents,
    originalTag:             topHyp?.tag ?? null,
    originalConfidenceScore: topHyp?.confidenceScore ?? null,
    originalFixHint:         topHyp?.fixHint ?? null,
  });

  // Enrich fixHint with the specific file:line from the Datadog RuntimeFact.
  // The compactor resolved this from the stack trace; use it to make the hint actionable.
  if (topHyp && activeIncident?.implicatedFile && topHyp.fixHint) {
    const loc = activeIncident.implicatedLine
      ? `${activeIncident.implicatedFile}:${activeIncident.implicatedLine}`
      : activeIncident.implicatedFile;
    if (!topHyp.fixHint.includes(activeIncident.implicatedFile)) {
      topHyp.fixHint = `${topHyp.fixHint}\nFailing location: \`${loc}\``;
    }
  }

  if (!topHyp) {
    logger.info({ service, pid }, 'incident-autopilot: no hypothesis generated');
    await replyToThread(pid, `_Mergen autopilot: analyzed ${errorCount} console errors and ${netErrors} network errors — no actionable root cause identified._`);
    return;
  }

  const rawScore      = topHyp.confidenceScore ?? 0;
  const calibratedScore = plattAdjusted.get(topHyp) ?? rawScore;
  const pct = Math.round(calibratedScore * 100);
  const calStats = getStatsForTag(topHyp.tag);
  const calibrationLabel = calStats?.isEmpirical
    ? `calibrated — ${calStats.verdicts} verdicts`
    : 'estimated — self-calibrates with use';
  // ── Multi-agent governance pipeline (Validator → Planner → Critic → Guard) ─
  const now = new Date();
  const pipeline = runAgentPipeline(causal, {
    service,
    executionThreshold: getAutoExecuteThreshold(),
    service_time: { dayOfWeek: now.getUTCDay(), hourOfDay: now.getUTCHours() },
  });

  const pipelineLine = (isAutopilotEnabled() || isShadowMode())
    ? `*Pipeline:* ${pipeline.stages.map((s) => {
        const icon = s.status === 'pass' ? '✅' : s.status === 'warn' ? '⚠️' : '🚫';
        return `${icon} ${s.name}`;
      }).join(' · ')}`
    : '';

  const diagMsg = [
    `🔍 *Mergen Autopilot — Root Cause Analysis*`,
    `*Hypothesis:* ${topHyp.summary}`,
    `*Confidence:* ${topHyp.confidence} (${pct}%) [${calibrationLabel}]`,
    topHyp.causalPath.length > 0
      ? `*Causal path:*\n${topHyp.causalPath.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '',
    topHyp.evidence.length > 0
      ? `*Evidence:*\n${topHyp.evidence.map((e) => `• ${e}`).join('\n')}`
      : '',
    topHyp.fixHint ? `*Fix:* ${topHyp.fixHint}` : '',
    pipelineLine,
  ].filter(Boolean).join('\n');

  await replyToThread(pid, diagMsg);
  logger.info({ service, pid, confidence: pct, hypothesis: topHyp.tag }, 'incident-autopilot: diagnosis posted');

  const webhookMsg = `📢 *Triage complete* for *${service}*. Hypothesis: *${topHyp.summary}* (${pct}% confidence). View unified timeline in Cursor/Claude Code.`;
  void postSimpleWebhookNotification(service, webhookMsg);

  // Check for a pre-approved runbook matching this incident tag before
  // falling back to LLM-generated commands — runbooks are human-reviewed.
  const approvedRunbook = getRunbookForTag(topHyp.tag);
  const runbookCommand = approvedRunbook ? approvedRunbook.steps.join(' && ') : null;
  if (approvedRunbook) {
    logger.info({ id: approvedRunbook.id, name: approvedRunbook.name, tag: topHyp.tag }, 'incident-autopilot: using pre-approved runbook');
  }

  // Prefer pre-approved runbook, then pipeline plan, then direct fixAction extraction
  const command = runbookCommand
    ?? pipeline.plan?.command
    ?? (topHyp.fixAction ? fixActionToCommand(topHyp.fixAction) : null)
    ?? (topHyp.fixHint ? extractCommand(topHyp.fixHint) : null);
  const execConfidence = topHyp.remediationConfidence ?? topHyp.confidenceScore ?? 0;
  const execPct = Math.round(execConfidence * 100);

  // ── Planning gate: deterministic execute/skip decision ─────────────────────
  // The decision to act is made by a deterministic model (classifier + blast risk
  // + historical success). The LLM-as-spokesperson brief is assembled AFTER the
  // gate approves, so the LLM only describes what the deterministic layer decided.
  const gate = planningGate(topHyp, service, getAutoExecuteThreshold());
  const gateDenied = !gate.execute;

  // Build the validated facts brief (LLM-as-spokesperson pattern)
  const runtimeFact = activeIncident?.runtimeFact ?? null;
  const brief = formatValidatedFactsForLLM(topHyp, service, gate, errorCount, runtimeFact, calibratedScore);
  logger.debug({ service, pid, tokens: brief.estimatedTokens }, 'incident-autopilot: LLM brief assembled');

  if (gate.adjustedConfidence !== execConfidence) {
    logger.info(
      { service, pid, raw: execPct, adjusted: Math.round(gate.adjustedConfidence * 100), blastRisk: gate.signals.blastRisk, classifier: gate.signals.classifierScore },
      'incident-autopilot: planning gate adjusted confidence',
    );
  }

  // ── Determine skip reason (pipeline verdict is authoritative) ────────────
  const corpusBlocked = pipeline.critique?.corpusConflict ?? false;
  const levelBlocked  = pipeline.critique?.levelConflict  ?? false;
  const pipelineBlocked = pipeline.verdict === 'block';
  const pipelineReview  = pipeline.verdict === 'review';

  if (!command || pipelineBlocked || corpusBlocked || isShadowMode() || gateDenied ||
      (!pipelineReview && execConfidence < getAutoExecuteThreshold())) {
    let skipReason: 'no-command' | 'confidence-below-threshold' | 'remediation-below-threshold' | 'override-corpus' | 'autopilot-disabled' | 'level-restricted' | 'pipeline-block' | 'planning-gate';
    let slackReason: string;

    if (isShadowMode()) {
      skipReason = 'autopilot-disabled';
      slackReason = `shadow mode — would execute \`${command ?? 'no command'}\` (remediation: ${execPct}%)`;
    } else if (!command) {
      skipReason = 'no-command';
      slackReason = 'no executable command in fixHint';
    } else if (pipelineBlocked) {
      skipReason = pipeline.critique?.levelConflict ? 'level-restricted'
        : pipeline.critique?.corpusConflict ? 'override-corpus'
        : 'pipeline-block';
      slackReason = pipeline.blockReason ?? 'Governance pipeline blocked execution';
    } else if (corpusBlocked) {
      skipReason = 'override-corpus';
      const corpusReason = dominantOverrideReason(topHyp.tag, service);
      slackReason = `override corpus: this action has been overridden before for \`${service}\` (reason: ${corpusReason ?? 'unknown'})`;
    } else if (gateDenied) {
      skipReason = 'planning-gate';
      slackReason = `planning gate: ${gate.reason}`;
    } else if (levelBlocked) {
      skipReason = 'level-restricted';
      const commandTier = classifyCommandRisk(command);
      const autopilotLevel = getAutopilotLevel();
      slackReason = `autopilot level \`${autopilotLevel}\` permits ${autopilotLevelDescription(autopilotLevel)} — this command is \`${commandTier}\` tier. Set MERGEN_AUTOPILOT_LEVEL=full to enable.`;
    } else if (topHyp.remediationConfidence !== undefined && topHyp.remediationConfidence < getAutoExecuteThreshold()) {
      skipReason = 'remediation-below-threshold';
      slackReason = `remediation confidence ${execPct}% below 85% threshold (diagnosis: ${pct}%)`;
    } else {
      skipReason = 'confidence-below-threshold';
      slackReason = `confidence ${execPct}% below 85% threshold`;
    }

    // Log a shadow entry so the track record is visible in /shadow-report
    let shadowEntry: ShadowEntry | undefined;
    if (topHyp.pid) {
      shadowEntry = recordShadow({
        pid: topHyp.pid,
        incidentTag: topHyp.tag,
        service,
        command,
        diagnosisConfidence: topHyp.confidenceScore ?? 0,
        remediationConfidence: execConfidence,
        wouldHaveExecuted: !!command && execConfidence >= getAutoExecuteThreshold() && !corpusBlocked,
        skipReason: skipReason === 'pipeline-block' ? 'confidence-below-threshold' : skipReason,
        firedAt,
      });
    }

    logger.info({ service, pid, skipReason, diagPct: pct, execPct, pipelineVerdict: pipeline.verdict }, 'incident-autopilot: skipping auto-execute');

    // Record blunders only for active blocks (not low-confidence or shadow-mode skips)
    if (skipReason === 'override-corpus') {
      recordBlunder({ blunderType: 'override_corpus_block', command, blockReason: slackReason, service, tag: topHyp.tag, actor: 'autopilot', pid: topHyp.pid ?? pid, confidenceScore: execConfidence });
      // Cache the block so the next trigger for the same fingerprint skips LLM inference.
      cacheIncidentResult({ fingerprint: pid, service, incidentTag: topHyp.tag, corpusBlocked: true, blockReason: slackReason, executedCommand: null });
    } else if (skipReason === 'pipeline-block' || skipReason === 'level-restricted') {
      recordBlunder({ blunderType: 'pipeline_block', command, blockReason: slackReason, service, tag: topHyp.tag, actor: 'autopilot', pid: topHyp.pid ?? pid, confidenceScore: execConfidence });
    } else if (skipReason === 'planning-gate') {
      recordBlunder({ blunderType: 'planning_gate_block', command, blockReason: slackReason, service, tag: topHyp.tag, actor: 'autopilot', pid: topHyp.pid ?? pid, confidenceScore: execConfidence });
    }

    const icon = isShadowMode() ? '👁️' : '⚠️';
    // In shadow mode, append one-click verdict links so the on-call SRE can
    // annotate the entry directly from Slack without navigating to the dashboard.
    const verdictLinks = (isShadowMode() && shadowEntry) ? buildVerdictLinks(shadowEntry) : '';
    await replyToThread(pid, `${icon} _Autopilot: ${slackReason}. Awaiting manual action._${verdictLinks}`);
    return;
  }

  // ── Approval gate: deploy/full-tier commands require a Slack Approve/Deny ──
  const commandTier = classifyCommandRisk(command);
  const blastRadius = computeBlastRadius(command, { service });
  if (commandTier !== 'restart' && getAutopilotLevel() !== 'full') {
    logger.info({ service, pid, command, commandTier, blastScope: blastRadius.scope }, 'incident-autopilot: routing through approval gate');
    const approvalPosted = await postApprovalRequest(pid, command, commandTier, execConfidence, blastRadius);
    if (!approvalPosted) {
      // Slack is down — we cannot post the approval block, so the engineer has no
      // way to click Approve. Abort rather than leaving an unresolvable pending approval.
      logger.error({ service, pid, command }, 'incident-autopilot: aborting approval gate — Slack notification failed, engineer cannot approve');
      recordBlunder({ blunderType: 'pipeline_block', command, blockReason: 'Slack unavailable — approval block could not be delivered', service, tag: topHyp.tag, actor: 'autopilot', pid: topHyp.pid ?? pid, confidenceScore: execConfidence });
      return;
    }
    requestApproval({ pid, command, tier: commandTier, service, remediationConfidence: execConfidence, cwd, blastRadius });
    recordShadow({
      pid: topHyp.pid ?? pid,
      incidentTag: topHyp.tag,
      service,
      command,
      diagnosisConfidence: topHyp.confidenceScore ?? 0,
      remediationConfidence: execConfidence,
      wouldHaveExecuted: true,
      skipReason: 'level-restricted',
      firedAt,
    });
    return;
  }

  logger.info({ service, pid, command }, 'incident-autopilot: executing fix');

  const execResult = await executeRemediation(command, { cwd, actor: 'autopilot' });

  if (execResult.blocked) {
    logger.warn({ service, pid, reason: execResult.blockReason }, 'incident-autopilot: fix blocked by safety filter');
    await replyToThread(pid, `🚫 *Fix blocked by safety filter*: ${execResult.blockReason}\nApply manually.`);
    const execBlunderType = typeof execResult.blockReason === 'string' && /inject/i.test(execResult.blockReason) ? 'injection_attempt' : 'allowlist_block';
    recordBlunder({ blunderType: execBlunderType, command, blockReason: execResult.blockReason ?? '', service, tag: topHyp.tag, actor: 'autopilot', pid: topHyp.pid ?? pid, confidenceScore: execConfidence });
    recordShadow({
      pid: topHyp.pid ?? pid,
      incidentTag: topHyp.tag,
      service,
      command,
      diagnosisConfidence: topHyp.confidenceScore ?? 0,
      remediationConfidence: execConfidence,
      wouldHaveExecuted: true,
      skipReason: 'blocked-by-safety-filter',
      firedAt,
    });
    return;
  }

  if (!execResult.ok) {
    logger.warn({ service, pid, exitCode: execResult.exitCode }, 'incident-autopilot: fix command failed');
    await replyToThread(pid, `❌ *Fix command failed* (exit ${execResult.exitCode})\n${execResult.stderr.slice(0, 500)}`);
    recordShadow({
      pid: topHyp.pid ?? pid,
      incidentTag: topHyp.tag,
      service,
      command,
      diagnosisConfidence: topHyp.confidenceScore ?? 0,
      remediationConfidence: execConfidence,
      wouldHaveExecuted: true,
      skipReason: 'executed-failure',
      firedAt,
    });
    return;
  }

  // Record the moment the fix was applied so post-fix validation only counts
  // errors that arrived AFTER the fix, not the historical errors from during
  // the incident (which remain in the ring buffer with timestamps >= firedAt).
  const fixAppliedAt = Date.now();

  await replyToThread(pid, `⚙️ \`${command}\` executed (${execResult.durationMs}ms) — validating…`);

  recordShadow({
    pid: topHyp.pid ?? pid,
    incidentTag: topHyp.tag,
    service,
    command,
    diagnosisConfidence: topHyp.confidenceScore ?? 0,
    remediationConfidence: execConfidence,
    wouldHaveExecuted: true,
    skipReason: 'executed',
    firedAt,
    ...(approvedRunbook ? { runbookId: approvedRunbook.id } : {}),
  });

  // Cache successful execution so re-triggers within 1hr fast-path without LLM.
  cacheIncidentResult({ fingerprint: pid, service, incidentTag: topHyp.tag, corpusBlocked: false, blockReason: null, executedCommand: command });

  // Wait for propagation then validate
  await new Promise((r) => setTimeout(r, 5_000));

  // Prefer Datadog for validation — it reflects real production error rates.
  // Fall back to the ring buffer when Datadog is not configured.
  let afterCount: number;
  const beforeCount = errorCount + netErrors;

  const ddErrorCount = isDatadogConfigured()
    ? await fetchErrorCountSince(service, 2)
    : null;

  if (ddErrorCount !== null) {
    afterCount = ddErrorCount;
    logger.info({ service, pid, ddErrorCount }, 'incident-autopilot: validation via Datadog');
  } else {
    // Use fixAppliedAt (not firedAt) so we count only errors that arrived after
    // the fix was applied. Using firedAt would include the original incident errors
    // still sitting in the ring buffer, making every successful fix look UNRESOLVED.
    const logsAfter = store.getLogs(200, 'error', fixAppliedAt, tenantId);
    const netAfter  = store.getNetwork(200, undefined, fixAppliedAt, tenantId).filter((n) => n.status >= 400 || !!n.error);
    afterCount = logsAfter.length + netAfter.length;
  }

  const verdict = classifyVerdict(beforeCount, afterCount);

  if (topHyp.pid) {
    const existing = getRecords().find((r) => r.pid === topHyp.pid);
    if (existing && !existing.verdict) recordVerdict(topHyp.pid, verdict);
    recordRemediationVerdict(topHyp.pid, verdict);

    const resolvedAt = Date.now();

    if (verdict === 'correct') {
      incidentStore.upsert(topHyp.pid, {
        status: 'resolved',
        resolvedAt,
        resolvedAutonomously: true,
        causallyCorrect: true,   // error rate dropped AND diagnosis confirmed
      });
    } else {
      incidentStore.upsert(topHyp.pid, {
        status: 'resolved',
        resolvedAt,
        resolvedAutonomously: true,
        causallyCorrect: false,
      });
    }

    // Write a postmortem and update the runbook for this failure mode.
    // The postmortem records the fix, MTTR, and git context so the next
    // engineer to see this failure has a verified history to work from.
    try {
      // firedAt is the authoritative incident start: it is the PagerDuty trigger
      // timestamp, set before any telemetry is collected. chain[0].ts is the
      // first buffered event, which may predate the incident by seconds or
      // minutes (DOM state snapshots, background network calls). Using firedAt
      // gives an honest MTTR from the moment the alert fired.
      const mttrMs = resolvedAt - firedAt;
      const pm = generatePostmortem({
        pid:      topHyp.pid,
        tag:      topHyp.tag,
        service,
        rootCause: topHyp.summary,
        fixCommand: command,
        confidence: topHyp.confidenceScore ?? 0,
        mttrMs,
        resolvedAutonomously: true,
        causallyCorrect: verdict === 'correct',
        evidence: topHyp.evidence,
        fixHint:  topHyp.fixHint ?? null,
      });
      // Non-blocking runbook update — failure here must never interrupt the
      // incident resolution flow.
      setImmediate(() => updateRunbookFromPostmortem(pm));
    } catch (err) {
      logger.warn({ err, pid: topHyp.pid }, 'incident-autopilot: postmortem generation failed');
    }
  }

  const statusLabel = afterCount === 0 ? 'RESOLVED' : afterCount < beforeCount ? 'PARTIAL' : afterCount > beforeCount ? 'REGRESSED' : 'UNRESOLVED';
  const statusIcon  = afterCount === 0 ? '✅' : afterCount < beforeCount ? '⚠️' : '❌';

  await replyToThread(
    pid,
    `${statusIcon} *${statusLabel}* — ${afterCount} errors after fix (was ${beforeCount})`,
  );

  // ── Auto-rollback on REGRESSED ────────────────────────────────────────────
  if (statusLabel === 'REGRESSED') {
    const rollback = deriveRollback(command, execResult.stdout);
    if (rollback.type === 'command') {
      await replyToThread(pid, `↩️ _REGRESSED detected — attempting auto-rollback…_`);
      const rb = await executeRollback(rollback, { cwd, actor: 'autopilot-rollback' });
      await replyToThread(
        pid,
        rb.ok
          ? `↩️ *Rollback succeeded:* \`${rb.message}\``
          : `🔴 *Rollback failed:* ${rb.message} — manual intervention required`,
      );
    } else {
      await replyToThread(pid, `⚠️ _Auto-rollback not available: ${rollback.reason}. Manual revert required._`);
    }
  }

  logger.info({ service, pid, statusLabel, afterCount, beforeCount }, 'incident-autopilot: complete');
}
