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
import { buildCausalChain } from './causal.js';
import { getRecords, recordVerdict } from './calibration.js';
import { executeRemediation, extractCommand } from './autonomy.js';
import { postThreadReply } from './slack.js';
import { incidentStore } from '../sensor/incident-store.js';
import { getActiveIncident } from '../datadog/incident-state.js';
import { normalizeRuntimeFactMarkdown, normalizeProcessExits } from '../sensor/infra-normalizer.js';
import logger from '../sensor/logger.js';

const AUTO_EXECUTE_THRESHOLD = 0.85;
const AUTOPILOT_ENABLED = process.env.MERGEN_AUTOPILOT === 'true';
// Brief pause to let browser events arrive after a PagerDuty trigger
const BUFFER_FILL_DELAY_MS = 5_000;

export interface AutopilotOpts {
  service: string;
  pid: string;
  firedAt: number;
  cwd?: string;
}

export async function runIncidentAutopilot(opts: AutopilotOpts): Promise<void> {
  if (!AUTOPILOT_ENABLED) {
    logger.debug({ service: opts.service }, 'incident-autopilot: disabled (set MERGEN_AUTOPILOT=true to enable)');
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

  const causal = await buildCausalChain(
    logs, network, contexts, firedAt,
    terminal, processExits, ciEvents, deployments,
    infraEvents,
  );
  const topHyp  = causal.hypotheses[0];

  if (!topHyp) {
    logger.info({ service, pid }, 'incident-autopilot: no hypothesis generated');
    void postThreadReply(pid, `_Mergen autopilot: analyzed ${errorCount} console errors and ${netErrors} network errors — no actionable root cause identified._`);
    return;
  }

  const pct = Math.round((topHyp.confidenceScore ?? 0) * 100);
  const diagMsg = [
    `🔍 *Mergen Autopilot — Root Cause Analysis*`,
    `*Hypothesis:* ${topHyp.summary}`,
    `*Confidence:* ${topHyp.confidence} (${pct}%)`,
    topHyp.fixHint ? `*Fix:* ${topHyp.fixHint}` : '',
  ].filter(Boolean).join('\n');

  void postThreadReply(pid, diagMsg);
  logger.info({ service, pid, confidence: pct, hypothesis: topHyp.tag }, 'incident-autopilot: diagnosis posted');

  const command = topHyp.fixHint ? extractCommand(topHyp.fixHint) : null;
  if (!command || (topHyp.confidenceScore ?? 0) < AUTO_EXECUTE_THRESHOLD) {
    const reason = !command
      ? 'no executable command in fixHint'
      : `confidence ${pct}% below 85% threshold`;
    logger.info({ service, pid, reason }, 'incident-autopilot: skipping auto-execute');
    void postThreadReply(pid, `⚠️ _Autopilot skipped execution: ${reason}. Awaiting manual action._`);
    return;
  }

  void postThreadReply(pid, `⚙️ *Autopilot executing fix*\n\`${command}\``);
  logger.info({ service, pid, command }, 'incident-autopilot: executing fix');

  const execResult = await executeRemediation(command, { cwd });

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

  const logsAfter = store.getLogs(200, 'error', firedAt);
  const netAfter  = store.getNetwork(200, undefined, firedAt).filter((n) => n.status >= 400 || !!n.error);
  const afterCount  = logsAfter.length + netAfter.length;
  const beforeCount = errorCount + netErrors;

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

  logger.info({ service, pid, statusLabel, afterCount, beforeCount }, 'incident-autopilot: complete');
}
