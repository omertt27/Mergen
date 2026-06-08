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
import type { CausalChain } from './causal.js';
import { getRecords, recordVerdict } from './calibration.js';
import { executeRemediation, extractCommand } from './autonomy.js';
import { postThreadReply, postApprovalRequest } from './slack.js';
import { requestApproval, setApprovalReplyFn } from './execution-gate.js';
import { deriveRollback, executeRollback } from './rollback.js';
import { captureSnapshot } from './incident-replay.js';
import { computeBlastRadius } from './blast-radius.js';
import { getExecutionThreshold } from './threshold-optimizer.js';
import { incidentStore } from '../sensor/incident-store.js';
import { getActiveIncident } from '../datadog/incident-state.js';
import { fetchErrorCountSince, isConfigured as isDatadogConfigured } from '../datadog/client.js';
import { normalizeRuntimeFactMarkdown, normalizeProcessExits } from '../sensor/infra-normalizer.js';
import { getK8sEvents } from '../sensor/k8s-events.js';
import { hasRecentOverride, dominantOverrideReason } from './override-corpus.js';
import { recordShadow } from './shadow-log.js';
import { getAutopilotLevel, autopilotLevelPermits, classifyCommandRisk, autopilotLevelDescription } from './action-risk.js';
import { getStatsForTag } from './calibration.js';
import { runAgentPipeline, renderPipelineStages } from './agent-pipeline.js';
import logger from '../sensor/logger.js';

// Wire the expiry-reply callback so execution-gate.ts can post to Slack threads
// without importing slack.ts (which would create a circular dependency).
setApprovalReplyFn((pid, text) => { void postThreadReply(pid, text); });

const ANALYSIS_TIMEOUT_MS = 30_000;

// Threshold is derived from the calibration corpus at runtime (ROC analysis).
// Falls back to 0.85 if fewer than 20 verdicts exist. Recomputed every 10 min.
const getAutoExecuteThreshold = () => getExecutionThreshold();
const AUTOPILOT_ENABLED = process.env.MERGEN_AUTOPILOT === 'true';
// Shadow mode: run full analysis and Slack reporting but never execute.
// Enables the design partner track-record workflow without autonomous action.
const SHADOW_MODE = !AUTOPILOT_ENABLED && process.env.MERGEN_SHADOW_MODE === 'true';
const AUTOPILOT_LEVEL = getAutopilotLevel();
// Brief pause to let browser events arrive after a PagerDuty trigger
const BUFFER_FILL_DELAY_MS = 5_000;

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

  // Let telemetry accumulate before analysis
  await new Promise((r) => setTimeout(r, BUFFER_FILL_DELAY_MS));

  const logs         = store.getLogs(200, undefined, firedAt);
  const network      = store.getNetwork(200, undefined, firedAt);
  const contexts     = store.getContext(20, firedAt);
  const terminal     = store.getTerminalOutput(100, undefined, firedAt);
  const processExits = store.getProcessExits(20, undefined, firedAt);
  const ciEvents     = store.getCIEvents(20, undefined, firedAt);
  const deployments  = store.getDeployments(10, undefined, firedAt);

  const errorCount = logs.filter((e) => e.level === 'error').length;
  const netErrors  = network.filter((n) => n.status >= 400 || !!n.error).length;

  // Build infra signals: Datadog RuntimeFact is the primary source; process exits
  // are a secondary source. This lets the autopilot diagnose infra incidents that
  // produce no browser events at all (DB pool exhaustion, OOM kills, etc.).
  const activeIncident = getActiveIncident();
  const runtimeFactMarkdown = activeIncident?.runtimeFact ?? null;
  const infraEvents = [
    ...(runtimeFactMarkdown
      ? normalizeRuntimeFactMarkdown(runtimeFactMarkdown, service, firedAt)
      : []),
    ...normalizeProcessExits(processExits),
    ...getK8sEvents(firedAt),
  ];

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

  const pct = Math.round((topHyp.confidenceScore ?? 0) * 100);
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

  // ── Determine skip reason (pipeline verdict is authoritative) ────────────
  const corpusBlocked = pipeline.critique?.corpusConflict ?? false;
  const levelBlocked  = pipeline.critique?.levelConflict  ?? false;
  const pipelineBlocked = pipeline.verdict === 'block';
  const pipelineReview  = pipeline.verdict === 'review';

  if (!command || pipelineBlocked || SHADOW_MODE ||
      (!pipelineReview && execConfidence < getAutoExecuteThreshold())) {
    let skipReason: 'no-command' | 'confidence-below-threshold' | 'remediation-below-threshold' | 'override-corpus' | 'autopilot-disabled' | 'level-restricted' | 'pipeline-block';
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
