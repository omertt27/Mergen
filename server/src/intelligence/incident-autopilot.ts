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
import { buildCausalChain, fixActionToCommand } from './causal.js';
import type { CausalChain, Hypothesis } from './causal.js';
import { getRecords, recordVerdict } from './calibration.js';
import { executeRemediation, extractCommand } from './autonomy.js';
import { postThreadReply, postApprovalRequest, fetchIncidentChannelContext } from './slack.js';
import { requestApproval } from './execution-gate.js';
import { approvalEvents } from './approval-events.js';
import { deriveRollback, executeRollback } from './rollback.js';
import { captureSnapshot } from './incident-replay.js';
import { computeBlastRadius } from './blast-radius.js';
import { getExecutionThreshold } from './threshold-optimizer.js';
import { incidentStore } from '../sensor/incident-store.js';
import { getActiveIncident } from '../datadog/incident-state.js';
import { fetchErrorCountSince, isConfigured as isDatadogConfigured } from '../datadog/client.js';
import { normalizeRuntimeFactMarkdown, normalizeProcessExits, normalizeSlackContext } from '../sensor/infra-normalizer.js';
import { getK8sEvents } from '../sensor/k8s-events.js';
import { hasRecentOverride, dominantOverrideReason } from './override-corpus.js';
import { recordShadow } from './shadow-log.js';
import { getAutopilotLevel, autopilotLevelPermits, classifyCommandRisk, autopilotLevelDescription } from './action-risk.js';
import { recordBlunder } from '../sensor/agent-blunder-store.js';
import { getStatsForTag } from './calibration.js';
import { runAgentPipeline, renderPipelineStages } from './agent-pipeline.js';
import { planningGate } from './planning-gate.js';
import { plattScale } from './platt-scaling.js';
import { formatValidatedFactsForLLM } from './llm-spokesperson.js';
import { serviceGraph } from '../sensor/service-graph.js';
import { routeReachability } from '../sensor/route-reachability.js';
import logger from '../sensor/logger.js';

// Forward approval expiry events to the Slack thread without coupling
// execution-gate.ts → slack.ts directly.
approvalEvents.on('approval:expired', (pid: string, text: string) => {
  void postThreadReply(pid, text);
});

const ANALYSIS_TIMEOUT_MS = 30_000;

// Threshold is derived from the calibration corpus at runtime (ROC analysis).
// Falls back to 0.85 if fewer than 20 verdicts exist. Recomputed every 10 min.
const getAutoExecuteThreshold = () => getExecutionThreshold();
const AUTOPILOT_ENABLED = process.env.MERGEN_AUTOPILOT === 'true';
// Shadow mode: run full analysis and Slack reporting but never execute.
// Enables the design partner track-record workflow without autonomous action.
const SHADOW_MODE = !AUTOPILOT_ENABLED && process.env.MERGEN_SHADOW_MODE === 'true';
const AUTOPILOT_LEVEL = getAutopilotLevel();

// Wait for telemetry to arrive after a PagerDuty trigger.
// Polls the buffer at 250ms intervals — returns as soon as MIN_EVENTS arrive,
// or after MAX_WAIT_MS regardless (avoids indefinite stalls for infra-only incidents
// that produce no browser telemetry).
const TELEMETRY_WAIT_MAX_MS   = 10_000;
const TELEMETRY_POLL_INTERVAL = 250;
const TELEMETRY_MIN_EVENTS    = 3;

async function waitForTelemetry(firedAt: number): Promise<void> {
  const deadline = Date.now() + TELEMETRY_WAIT_MAX_MS;
  while (Date.now() < deadline) {
    const logs = store.getLogs(TELEMETRY_MIN_EVENTS, undefined, firedAt);
    const net  = store.getNetwork(TELEMETRY_MIN_EVENTS, undefined, firedAt);
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
}

export async function runIncidentAutopilot(opts: AutopilotOpts): Promise<void> {
  if (!AUTOPILOT_ENABLED && !SHADOW_MODE) {
    logger.debug({ service: opts.service }, 'incident-autopilot: disabled (set MERGEN_AUTOPILOT=true or MERGEN_SHADOW_MODE=true)');
    return;
  }

  const { service, pid, firedAt, cwd } = opts;
  logger.info({ service, pid }, 'incident-autopilot: starting');

  // Wait for telemetry to accumulate (event-driven, capped at 10s)
  await waitForTelemetry(firedAt);

  const logs         = store.getLogs(200, undefined, firedAt);
  const network      = store.getNetwork(200, undefined, firedAt);
  const contexts     = store.getContext(20, firedAt);
  const terminal     = store.getTerminalOutput(100, undefined, firedAt);
  const processExits = store.getProcessExits(20, undefined, firedAt);
  const ciEvents     = store.getCIEvents(20, undefined, firedAt);
  const deployments  = store.getDeployments(10, undefined, firedAt);

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
    void postThreadReply(pid, '_Mergen autopilot: no errors or infra signals found in buffer — manual investigation required._');
    return;
  }

  // Post the Datadog RuntimeFact to Slack immediately as the incident context
  // block, before causal analysis completes. Engineers see what's broken while
  // Mergen reasons about the fix.
  if (runtimeFactMarkdown) {
    const ageMin = Math.round((Date.now() - firedAt) / 60_000);
    void postThreadReply(
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
      buildCausalChain(logs, network, contexts, firedAt, terminal, processExits, ciEvents, deployments, infraEvents),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('analysis timeout')), ANALYSIS_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    logger.warn({ err, service, pid }, 'incident-autopilot: causal analysis failed — posting raw telemetry');
    const topErrors   = logs.filter((e) => e.level === 'error').slice(0, 5);
    const topNetFails = network.filter((n) => n.status >= 400 || !!n.error).slice(0, 5);
    void postThreadReply(pid, [
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

  const topHyp  = causal.hypotheses[0];

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
    void postThreadReply(pid, `_Mergen autopilot: analyzed ${errorCount} console errors and ${netErrors} network errors — no actionable root cause identified._`);
    return;
  }

  const rawScore      = topHyp.confidenceScore ?? 0;
  const calibratedScore = plattAdjusted.get(topHyp) ?? rawScore;
  const pct = Math.round(calibratedScore * 100);
  const calStats = getStatsForTag(topHyp.tag);
  const calibrationLabel = calStats?.isEmpirical
    ? `calibrated — ${calStats.verdicts} verdicts`
    : 'estimated — self-calibrates with use';
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
  ].filter(Boolean).join('\n');

  void postThreadReply(pid, diagMsg);
  logger.info({ service, pid, confidence: pct, hypothesis: topHyp.tag }, 'incident-autopilot: diagnosis posted');

  // ── Multi-agent governance pipeline (Validator → Planner → Critic → Guard) ─
  const now = new Date();
  const pipeline = runAgentPipeline(causal, {
    service,
    executionThreshold: getAutoExecuteThreshold(),
    service_time: { dayOfWeek: now.getUTCDay(), hourOfDay: now.getUTCHours() },
  });

  // Post pipeline stage summary to Slack (gives on-call visibility into reasoning)
  if (AUTOPILOT_ENABLED || SHADOW_MODE) {
    void postThreadReply(pid, renderPipelineStages(pipeline.stages));
  }

  // Prefer pipeline-derived plan over direct fixAction extraction
  const command = pipeline.plan?.command
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

  if (!command || pipelineBlocked || SHADOW_MODE || gateDenied ||
      (!pipelineReview && execConfidence < getAutoExecuteThreshold())) {
    let skipReason: 'no-command' | 'confidence-below-threshold' | 'remediation-below-threshold' | 'override-corpus' | 'autopilot-disabled' | 'level-restricted' | 'pipeline-block' | 'planning-gate';
    let slackReason: string;

    if (SHADOW_MODE) {
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
    } else if (gateDenied) {
      skipReason = 'planning-gate';
      slackReason = `planning gate: ${gate.reason}`;
    } else if (levelBlocked) {
      skipReason = 'level-restricted';
      const commandTier = classifyCommandRisk(command);
      slackReason = `autopilot level \`${AUTOPILOT_LEVEL}\` permits ${autopilotLevelDescription(AUTOPILOT_LEVEL)} — this command is \`${commandTier}\` tier. Set MERGEN_AUTOPILOT_LEVEL=full to enable.`;
    } else if (corpusBlocked) {
      skipReason = 'override-corpus';
      const corpusReason = dominantOverrideReason(topHyp.tag, service);
      slackReason = `override corpus: this action has been overridden before for \`${service}\` (reason: ${corpusReason ?? 'unknown'})`;
    } else if (topHyp.remediationConfidence !== undefined && topHyp.remediationConfidence < getAutoExecuteThreshold()) {
      skipReason = 'remediation-below-threshold';
      slackReason = `remediation confidence ${execPct}% below 85% threshold (diagnosis: ${pct}%)`;
    } else {
      skipReason = 'confidence-below-threshold';
      slackReason = `confidence ${pct}% below 85% threshold`;
    }

    // Log a shadow entry so the track record is visible in /shadow-report
    if (topHyp.pid) {
      recordShadow({
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
    } else if (skipReason === 'pipeline-block' || skipReason === 'level-restricted') {
      recordBlunder({ blunderType: 'pipeline_block', command, blockReason: slackReason, service, tag: topHyp.tag, actor: 'autopilot', pid: topHyp.pid ?? pid, confidenceScore: execConfidence });
    } else if (skipReason === 'planning-gate') {
      recordBlunder({ blunderType: 'planning_gate_block', command, blockReason: slackReason, service, tag: topHyp.tag, actor: 'autopilot', pid: topHyp.pid ?? pid, confidenceScore: execConfidence });
    }

    const icon = SHADOW_MODE ? '👁️' : '⚠️';
    void postThreadReply(pid, `${icon} _Autopilot: ${slackReason}. Awaiting manual action._`);
    return;
  }

  // ── Approval gate: deploy/full-tier commands require a Slack Approve/Deny ──
  const commandTier = classifyCommandRisk(command);
  const blastRadius = computeBlastRadius(command, { service });
  if (commandTier !== 'restart' && AUTOPILOT_LEVEL !== 'full') {
    logger.info({ service, pid, command, commandTier, blastScope: blastRadius.scope }, 'incident-autopilot: routing through approval gate');
    await postApprovalRequest(pid, command, commandTier, execConfidence, blastRadius);
    requestApproval({ pid, command, tier: commandTier, service, remediationConfidence: execConfidence, cwd, blastRadius });
    return;
  }

  void postThreadReply(pid, `⚙️ *Autopilot executing fix*\n\`${command}\``);
  logger.info({ service, pid, command }, 'incident-autopilot: executing fix');

  const execResult = await executeRemediation(command, { cwd, actor: 'autopilot' });

  if (execResult.blocked) {
    logger.warn({ service, pid, reason: execResult.blockReason }, 'incident-autopilot: fix blocked by safety filter');
    void postThreadReply(pid, `🚫 *Fix blocked by safety filter*: ${execResult.blockReason}\nApply manually.`);
    const execBlunderType = typeof execResult.blockReason === 'string' && /inject/i.test(execResult.blockReason) ? 'injection_attempt' : 'allowlist_block';
    recordBlunder({ blunderType: execBlunderType, command, blockReason: execResult.blockReason ?? '', service, tag: topHyp.tag, actor: 'autopilot', pid: topHyp.pid ?? pid, confidenceScore: execConfidence });
    return;
  }

  if (!execResult.ok) {
    logger.warn({ service, pid, exitCode: execResult.exitCode }, 'incident-autopilot: fix command failed');
    void postThreadReply(pid, `❌ *Fix command failed* (exit ${execResult.exitCode})\n${execResult.stderr.slice(0, 500)}`);
    return;
  }

  void postThreadReply(pid, `✅ *Fix executed* (${execResult.durationMs}ms) — validating…`);

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
    const logsAfter = store.getLogs(200, 'error', firedAt);
    const netAfter  = store.getNetwork(200, undefined, firedAt).filter((n) => n.status >= 400 || !!n.error);
    afterCount = logsAfter.length + netAfter.length;
  }

  let verdict: 'correct' | 'partial' | 'wrong';
  if (afterCount === 0 && beforeCount > 0)                           { verdict = 'correct'; }
  else if (beforeCount > 0 && afterCount < beforeCount * 0.5)       { verdict = 'partial'; }
  else                                                               { verdict = 'wrong'; }

  if (topHyp.pid) {
    const existing = getRecords().find((r) => r.pid === topHyp.pid);
    if (existing && !existing.verdict) recordVerdict(topHyp.pid, verdict);
    if (verdict === 'correct') {
      incidentStore.upsert(topHyp.pid, {
        status: 'resolved',
        resolvedAt: Date.now(),
        resolvedAutonomously: true,
        causallyCorrect: true,   // error rate dropped AND diagnosis confirmed
      });
    } else {
      incidentStore.upsert(topHyp.pid, {
        status: 'resolved',
        resolvedAt: Date.now(),
        resolvedAutonomously: true,
        causallyCorrect: false,
      });
    }
  }

  const statusLabel = afterCount === 0 ? 'RESOLVED' : afterCount < beforeCount ? 'PARTIAL' : afterCount > beforeCount ? 'REGRESSED' : 'UNRESOLVED';
  const statusIcon  = afterCount === 0 ? '✅' : afterCount < beforeCount ? '⚠️' : '❌';

  void postThreadReply(
    pid,
    `${statusIcon} *${statusLabel}* — ${afterCount} errors after fix (was ${beforeCount})`,
  );

  // ── Auto-rollback on REGRESSED ────────────────────────────────────────────
  if (statusLabel === 'REGRESSED') {
    const rollback = deriveRollback(command, execResult.stdout);
    if (rollback.type === 'command') {
      void postThreadReply(pid, `↩️ _REGRESSED detected — attempting auto-rollback…_`);
      const rb = await executeRollback(rollback, { cwd, actor: 'autopilot-rollback' });
      void postThreadReply(
        pid,
        rb.ok
          ? `↩️ *Rollback succeeded:* \`${rb.message}\``
          : `🔴 *Rollback failed:* ${rb.message} — manual intervention required`,
      );
    } else {
      void postThreadReply(pid, `⚠️ _Auto-rollback not available: ${rollback.reason}. Manual revert required._`);
    }
  }

  logger.info({ service, pid, statusLabel, afterCount, beforeCount }, 'incident-autopilot: complete');
}
