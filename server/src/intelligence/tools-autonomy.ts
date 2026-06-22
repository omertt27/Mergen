/**
 * tools-autonomy.ts — MCP tools for autonomous incident triage.
 *
 * execute_fix:
 *   Given a prediction id (pid) from reconstruct_context, extracts the fixHint
 *   command and executes it. Requires confirm=true as an explicit safety gate
 *   — the AI must show the user what will be run before calling this.
 *   After execution, auto-runs validate_fix and returns the full verdict.
 *
 * triage_incident:
 *   Full autonomous loop for on-call engineers who aren't in the IDE.
 *   1. Pulls recent errors and network failures.
 *   2. Runs causal analysis (buildCausalChain).
 *   3. If auto_execute=true and confidence >= 0.85, runs the fix command.
 *   4. Validates the fix and returns a structured incident report.
 *
 * Safety gates enforced here (in addition to autonomy.ts blocklist):
 *   - execute_fix: requires confirm=true
 *   - triage_incident: auto_execute only triggers at confidenceScore >= 0.85
 *   - Both tools log to the audit trail via executeRemediation()
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store } from '../sensor/buffer.js';
import { buildCausalChain, fixActionToCommand } from './causal.js';
import { getRecords, recordVerdict, classifyVerdict, recordRemediationVerdict, isCorpusSeeded, getRealVerdictCount } from './calibration.js';
import { executeRemediation, extractCommand } from './autonomy.js';
import { deriveRollback, executeRollback } from './rollback.js';
import { getAutopilotLevel, autopilotLevelPermits, classifyCommandRisk, autopilotLevelDescription } from './action-risk.js';
import { hasRecentOverride } from './override-corpus.js';
import { getStatsForTag } from './calibration.js';
import { trackCall, withTierGate } from './tools-state.js';
import { getTierForTool } from './tool-manifest.js';
import { incidentStore } from '../sensor/incident-store.js';
import { captureSnapshot } from './incident-replay.js';
import { postThreadReply } from './slack.js';
import { consumeIncident } from './usage.js';
import { generatePostmortem } from './postmortem-store.js';
import { runAgentPipeline, renderPipelineStages } from './agent-pipeline.js';
import { planningGate } from './planning-gate.js';
import { isShadowMode, isAutopilotEnabled } from './execution-mode.js';
import { getExecutionThreshold } from './threshold-optimizer.js';
import { getActivePlanId } from './license.js';
import logger from '../sensor/logger.js';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const TEAM_UPGRADE_INCIDENT_THRESHOLD = 5;

// Same threshold logic as incident-autopilot — provisional bump when local
// verdict count is low (see incident-autopilot.ts for rationale).
const AUTO_EXECUTE_CONFIDENCE_THRESHOLD = () => {
  const base = getExecutionThreshold();
  const provisional = isCorpusSeeded() || getRealVerdictCount() < 10;
  return provisional ? Math.min(0.95, base + 0.05) : base;
};

const tracer = trace.getTracer('mergen-agent');

export function registerAutonomyTools(server: McpServer): void {
  // ── execute_fix ──────────────────────────────────────────────────────────────
  server.registerTool(
    'execute_fix',
    {
      description:
        'Execute the fix command embedded in a hypothesis fixHint. ' +
        'Requires confirm=true — always show the user what will be executed before calling this. ' +
        'After execution, automatically validates whether the fix resolved the issue. ' +
        'Returns: the command executed, stdout/stderr, exit code, and RESOLVED/PARTIAL/REGRESSED verdict. ' +
        'Only call this for HIGH-confidence diagnoses (confidence >= 0.85). ' +
        'Set dry_run=true to preview the command without running it.',
      inputSchema: {
        pid: z.string()
          .describe('Prediction id from reconstruct_context — identifies the hypothesis to fix'),
        confirm: z.boolean()
          .describe('Must be true to proceed. Set true only after showing the user what will be executed.'),
        since: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
          .describe('Unix ms timestamp from before the issue — used to validate the fix. If omitted, uses now - 60s.'),
        dry_run: z.enum(['true', 'false']).optional()
          .describe('Pass "true" to print the command that would be executed without running it.'),
        cwd: z.string().optional()
          .describe('Working directory for the command. Defaults to process cwd.'),
        actor: z.string().optional()
          .describe('Identity of the engineer executing the fix (email or username). Used for RBAC and audit log.'),
        service: z.string().optional()
          .describe('Service name (e.g. "api", "auth"). Used for override corpus lookup. If omitted, corpus check is skipped.'),
      },
    },
    withTierGate(getTierForTool('execute_fix'), async ({ pid, confirm, since, dry_run, cwd, actor, service }) => {
      trackCall('execute_fix');
      const isDryRun = dry_run === 'true';
      const isShadow = isShadowMode();

      if (isShadow && !isDryRun) {
        return {
          content: [{
            type: 'text',
            text: '👁️ **Shadow mode** — execute_fix is suppressed. No command was run. Pass `dry_run: "true"` to preview the command that would execute.',
          }],
        };
      }

      if (!confirm) {
        return {
          content: [{
            type: 'text',
            text: [
              '⚠️ **confirm required**',
              '',
              'You must pass `confirm: true` after showing the user what command will be run.',
              'Check the hypothesis fixHint for the command, then ask the user to confirm, then call again with confirm=true.',
            ].join('\n'),
          }],
        };
      }

      const records = getRecords();
      const prediction = records.find((r) => r.pid === pid);
      if (!prediction) {
        return {
          content: [{ type: 'text', text: `No prediction found for pid \`${pid}\`. Run reconstruct_context first.` }],
          isError: true,
        };
      }

      // We need the fixHint from the hypothesis — it's not in the calibration record.
      // The AI must pass it via the cwd field or we reconstruct from recent causal chain.
      // Workaround: re-run a lightweight causal pass to find the hypothesis by tag.
      const tenantId   = process.env.MERGEN_TENANT_ID;
      const logs       = store.getLogs(200, undefined, undefined, tenantId);
      const network    = store.getNetwork(200, undefined, undefined, tenantId);
      const contexts   = store.getContext(20, undefined, tenantId);
      const terminal   = store.getTerminalOutput(100, undefined, undefined, tenantId);
      const processExits = store.getProcessExits(20, undefined, undefined, tenantId);
      const causal     = await buildCausalChain(logs, network, contexts, undefined, terminal, processExits, [], []);
      const hyp        = causal.hypotheses.find((h) => h.tag === prediction.tag);
      const fixHint    = hyp?.fixHint ?? null;

      if (!fixHint) {
        return {
          content: [{
            type: 'text',
            text: [
              `No fixHint available for detector \`${prediction.tag}\`.`,
              '',
              'This hypothesis does not have an auto-executable fix — apply the fix manually and call `validate_fix` afterwards.',
            ].join('\n'),
          }],
        };
      }

      const command = hyp?.fixAction ? fixActionToCommand(hyp.fixAction) : extractCommand(fixHint);
      if (!command) {
        return {
          content: [{
            type: 'text',
            text: [
              `**Fix hint:** ${fixHint}`,
              '',
              'No executable command found in this fixHint — the fix must be applied manually.',
              'Apply the change, then call `validate_fix` to verify.',
            ].join('\n'),
          }],
        };
      }

      // ── Risk-tier gate ────────────────────────────────────────────────────────
      // Reject commands whose tier exceeds the configured autopilot level.
      // The human confirm=true gate covers intent, but the tier check ensures
      // deploy/full-tier commands cannot bypass the approval model that the
      // autopilot enforces via Slack.
      const commandTier = classifyCommandRisk(command);
      if (!isDryRun && !autopilotLevelPermits(command, getAutopilotLevel())) {
        return {
          content: [{
            type: 'text',
            text: `⚠️ **Command blocked** — tier \`${commandTier}\` exceeds MERGEN_AUTOPILOT_LEVEL=${getAutopilotLevel()}. Apply manually or raise the autopilot level.`,
          }],
          isError: true,
        };
      }

      // ── Override corpus check ─────────────────────────────────────────────────
      // Warn when the corpus has a recent override for this (tag, service, time-window).
      // The service parameter is required for a meaningful check — skip if absent.
      if (!isDryRun && service) {
        const now = new Date();
        if (hasRecentOverride(prediction.tag, service, now.getUTCDay(), now.getUTCHours())) {
          return {
            content: [{
              type: 'text',
              text: [
                `⚠️ **Override corpus match** — \`${prediction.tag}\` for service \`${service}\` has been overridden in a similar time window before.`,
                '',
                'Review the override history at `GET /override-corpus` before proceeding.',
                'If you still want to execute, omit the `service` parameter to bypass this check, or call `execute_fix` again.',
              ].join('\n'),
            }],
          };
        }
      }

      const resolvedActor = actor ?? process.env.MERGEN_MCP_ACTOR ?? 'mcp-client';
      const beforeTs = since ?? Date.now() - 60_000;
      const execResult = await executeRemediation(command, { cwd, dryRun: isDryRun, actor: resolvedActor });

      if (execResult.blocked) {
        return {
          content: [{
            type: 'text',
            text: [
              `🚫 **Command blocked by safety filter**`,
              '',
              `Command: \`${command}\``,
              `Reason: ${execResult.blockReason}`,
              '',
              'Apply this fix manually and call `validate_fix` afterwards.',
            ].join('\n'),
          }],
          isError: true,
        };
      }

      const lines = [
        dry_run ? `## Dry Run — would execute` : `## Fix Executed`,
        '',
        `**Command:** \`${command}\``,
        `**Exit code:** ${execResult.exitCode ?? 'killed'}`,
        `**Duration:** ${execResult.durationMs}ms`,
        execResult.timedOut ? '⚠️ Command timed out (60s limit)' : '',
        '',
      ].filter((l) => l !== undefined);

      if (execResult.stdout.trim()) {
        lines.push('**stdout:**', '```', execResult.stdout.trim().slice(0, 2000), '```', '');
      }
      if (execResult.stderr.trim()) {
        lines.push('**stderr:**', '```', execResult.stderr.trim().slice(0, 1000), '```', '');
      }

      if (isDryRun) {
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ── Auto-validate after execution ─────────────────────────────────────────
      if (execResult.ok) {
        // Brief wait for the fix to propagate before checking error counts.
        await new Promise((r) => setTimeout(r, 3000));

        const windowMs   = 60_000;
        const windowStart = beforeTs - windowMs;
        const logsBefore = store.getLogs(200, 'error', windowStart).filter((e) => e.timestamp < beforeTs);
        const netBefore  = store.getNetwork(200, undefined, windowStart).filter(
          (e) => e.timestamp < beforeTs && (e.status >= 400 || !!e.error),
        );
        const logsAfter = store.getLogs(200, 'error', beforeTs);
        const netAfter  = store.getNetwork(200, undefined, beforeTs).filter((e) => e.status >= 400 || !!e.error);

        const errsBefore = logsBefore.length + netBefore.length;
        const errsAfter  = logsAfter.length  + netAfter.length;

        let verdict: 'correct' | 'partial' | 'wrong';
        let status: string;
        if (errsAfter === 0 && errsBefore > 0)        { verdict = 'correct'; status = 'RESOLVED'; }
        else if (errsAfter === 0 && errsBefore === 0)  { verdict = 'correct'; status = 'CLEAN'; }
        else if (errsAfter < errsBefore)               { verdict = 'partial'; status = 'PARTIAL'; }
        else { verdict = 'wrong'; status = errsAfter > errsBefore ? 'REGRESSED' : 'UNRESOLVED'; }

        if (!prediction.verdict) recordVerdict(pid, verdict);

        lines.push(
          `## Validation — ${status}`,
          '',
          `| | Before | After |`,
          `|---|---|---|`,
          `| Console errors | ${logsBefore.length} | ${logsAfter.length} |`,
          `| Network errors | ${netBefore.length} | ${netAfter.length} |`,
          `| **Total** | **${errsBefore}** | **${errsAfter}** |`,
          '',
          verdict === 'correct'
            ? '✅ Fix confirmed — issue resolved.'
            : verdict === 'partial'
              ? '⚠️ Partial improvement — some errors remain.'
              : status === 'REGRESSED'
                ? '❌ REGRESSED — more errors after fix than before. Consider reverting.'
                : '❌ UNRESOLVED — errors persist. Review the fix and try again.',
        );

        if (status === 'REGRESSED') {
          const rollback = deriveRollback(command, execResult.stdout);
          if (rollback.type === 'command') {
            lines.push('', `**Auto-rollback:** attempting \`${rollback.command}\`…`);
            const rb = await executeRollback(rollback, { cwd, actor: resolvedActor });
            lines.push(rb.ok
              ? `↩️ Rollback succeeded: \`${rb.message}\``
              : `🔴 Rollback failed: ${rb.message} — manual intervention required`);
          } else {
            lines.push('', `**Rollback not available:** ${rollback.reason} — manual revert required.`);
          }
        }
      } else {
        lines.push('', `❌ Command failed (exit ${execResult.exitCode}). Fix was not applied — no validation run.`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }),
  );

  // ── triage_incident ──────────────────────────────────────────────────────────
  server.registerTool(
    'triage_incident',
    {
      description:
        'Full autonomous incident triage loop. ' +
        'Pulls recent errors, runs causal analysis, and — if auto_execute=true and confidence is HIGH (>=85%) — ' +
        'executes the fix command and validates the result. ' +
        'Returns a structured incident report suitable for a Slack war room or PagerDuty note. ' +
        'Use this for on-call triage when the engineer is not in the IDE. ' +
        'Set auto_execute=false (default) to get the diagnosis only, without running anything.',
      inputSchema: {
        service: z.string().optional()
          .describe('Service name to focus on (e.g. "api", "frontend"). If omitted, analyzes all recent events.'),
        since: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
          .describe('Unix ms — only look at events after this timestamp. Defaults to now - 5 minutes.'),
        auto_execute: z.enum(['true', 'false']).optional()
          .describe(
            'Pass "true" to automatically execute the fix command when confidence >= 0.85. ' +
            'Default omitted / "false" — diagnosis only, nothing executed.',
          ),
        cwd: z.string().optional()
          .describe('Working directory for any fix command. Defaults to process cwd.'),
        actor: z.string().optional()
          .describe('Identity of the engineer (email or username). Used for RBAC and audit log.'),
        tenant_id: z.string().optional()
          .describe('Cloud mode: restrict analysis to this tenant\'s events. Required when MERGEN_CLOUD_MODE=true.'),
      },
    },
    async ({ service, since, auto_execute, cwd, actor, tenant_id }) => {
      trackCall('triage_incident');
      const shouldAutoExecute = auto_execute === 'true';
      // Prefer the explicit parameter; fall back to the deployment-level env var
      // so cloud operators can set MERGEN_TENANT_ID once rather than relying on
      // the AI to pass tenant_id on every call.
      const tenantId = tenant_id ?? process.env.MERGEN_TENANT_ID;

      // Y2 hybrid billing: meter each incident triage against monthly quota
      const incidentResult = await consumeIncident();
      if (!incidentResult.allowed) {
        return {
          content: [{
            type: 'text',
            text: [
              `⛔ ${incidentResult.notice ?? 'Monthly incident limit reached.'}`,
              '',
              '→ https://mergen.dev/pricing',
            ].join('\n'),
          }],
          isError: true,
        };
      }

      const sinceTs = since ?? Date.now() - 5 * 60_000;
      logger.info({ service, sinceTs, auto_execute, tenantId }, 'triage_incident: starting');

      const span = tracer.startSpan('mergen.triage_incident', {
        attributes: {
          'mergen.service': service ?? 'all',
          'mergen.auto_execute': shouldAutoExecute,
          'mergen.tenant_id': tenantId ?? '',
        },
      });

      try {
        const logs       = store.getLogs(200, undefined, sinceTs, tenantId);
        const network    = store.getNetwork(200, undefined, sinceTs, tenantId);
        const contexts   = store.getContext(20, sinceTs, tenantId);
        const terminal   = store.getTerminalOutput(100, undefined, sinceTs, tenantId);
        const processExits = store.getProcessExits(20, undefined, sinceTs, tenantId);
        const ciEvents   = store.getCIEvents(20, undefined, sinceTs, tenantId);
        const deployments = store.getDeployments(10, undefined, sinceTs, tenantId);

        if (logs.length === 0 && network.filter((n) => n.status >= 400).length === 0) {
          span.setAttribute('mergen.status', 'clean_buffer');
          return {
            content: [{
              type: 'text',
              text: [
                '## Triage Report — No Issues Found',
                '',
                service ? `No errors found for service \`${service}\` in the last ${Math.round((Date.now() - sinceTs) / 60_000)} minutes.`
                        : `No errors found in the last ${Math.round((Date.now() - sinceTs) / 60_000)} minutes.`,
                '',
                'Buffer is clean. If you expected errors, verify the browser extension is connected and capturing events.',
              ].join('\n'),
            }],
          };
        }

        const causal = await buildCausalChain(logs, network, contexts, sinceTs, terminal, processExits, ciEvents, deployments);
        const topHyp = causal.hypotheses[0];
        const errorCount = logs.filter((e) => e.level === 'error').length;
        const netErrors  = network.filter((n) => n.status >= 400 || n.error).length;

        // Persist telemetry snapshot for replay corpus — same as autopilot path.
        // Every triage call (manual or automated) grows the replay dataset.
        if (topHyp) {
          span.setAttribute('mergen.incident_tag', topHyp.tag ?? '');
          span.setAttribute('mergen.confidence_score', topHyp.confidenceScore ?? 0);
          span.setAttribute('mergen.summary', topHyp.summary ?? '');
          if (topHyp.fixHint) {
            span.setAttribute('mergen.fix_hint', topHyp.fixHint);
          }
          captureSnapshot({
            pid: topHyp.pid ?? `mcp-${Date.now()}`,
            capturedAt: Date.now(),
            firedAt: sinceTs,
            logs, network, contexts, terminal, processExits, ciEvents, deployments,
            infraEvents: [],
            originalTag:             topHyp.tag ?? null,
            originalConfidenceScore: topHyp.confidenceScore ?? null,
            originalFixHint:         topHyp.fixHint ?? null,
          });
        }

        const lines: string[] = [
          `## Triage Report${service ? ` — ${service}` : ''}`,
          '',
          `**Window:** ${new Date(sinceTs).toISOString()} → now`,
          `**Console errors:** ${errorCount}  |  **Network errors:** ${netErrors}`,
          '',
        ];

        if (!topHyp) {
          span.setAttribute('mergen.status', 'no_hypothesis');
          lines.push('No hypothesis generated. Errors may be unrelated or below detector threshold.');
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        const pct = Math.round((topHyp.confidenceScore ?? 0) * 100);
        const calStats = getStatsForTag(topHyp.tag);
        const calibrationLabel = calStats?.isEmpirical
          ? `calibrated — ${calStats.verdicts} verdicts on this installation`
          : 'estimated — runs /feedback after resolution to calibrate';
        lines.push(
          `### Root Cause — ${topHyp.confidence} (${pct}%)`,
          `_Confidence source: ${calibrationLabel}_`,
          '',
          topHyp.summary,
          '',
        );

        if (topHyp.evidence?.length) {
          lines.push('**Evidence:**');
          topHyp.evidence.slice(0, 4).forEach((e) => lines.push(`- ${e}`));
          lines.push('');
        }

        if (topHyp.fixHint) {
          lines.push(`**Fix:** ${topHyp.fixHint}`, '');
        }

        // Run multi-agent governance pipeline (Validator → Planner → Critic → Guard)
        const pipeline = runAgentPipeline(causal, {
          service,
          executionThreshold: AUTO_EXECUTE_CONFIDENCE_THRESHOLD(),
        });
        lines.push('', renderPipelineStages(pipeline.stages), '');

        // Pipeline-derived command takes precedence over regex extraction
        const command = pipeline.plan?.command
          ?? (topHyp.fixAction ? fixActionToCommand(topHyp.fixAction) : null)
          ?? (topHyp.fixHint ? extractCommand(topHyp.fixHint) : null);
        const execConfidence = topHyp.remediationConfidence ?? topHyp.confidenceScore ?? 0;
        const execPct = Math.round(execConfidence * 100);
        const autopilotLevel = getAutopilotLevel();
        const levelPermits = !command || autopilotLevelPermits(command, autopilotLevel);
        const isShadow = isShadowMode();
        // Require both the agent-pipeline (blast radius, corpus, critic) AND the
        // planning-gate (classifier blend, blast-risk threshold adjustment) to agree.
        // This matches the two-gate logic used by incident-autopilot.ts.
        const gate = planningGate(topHyp, service ?? 'unknown', AUTO_EXECUTE_CONFIDENCE_THRESHOLD());
        const canAutoExecute = shouldAutoExecute && !isShadow && command
          && pipeline.verdict === 'proceed'
          && gate.execute
          && levelPermits;

        span.setAttribute('mergen.pipeline.verdict', pipeline.verdict ?? '');
        if (command) {
          span.setAttribute('mergen.command', command);
        }

        if (isShadow && shouldAutoExecute && command) {
          lines.push(`👁️ **Shadow mode** — would execute \`${command}\` (remediation: ${execPct}%). No action taken.`, '');
        }

        if (shouldAutoExecute && !canAutoExecute && !isShadow) {
          if (!command) {
            lines.push('⚠️ Auto-execute skipped — no executable command found in fixHint.');
          } else if (pipeline.verdict === 'block') {
            lines.push(`⚠️ Auto-execute blocked by governance pipeline: ${pipeline.blockReason ?? 'see pipeline stages above'}`);
          } else if (!gate.execute) {
            lines.push(`⚠️ Auto-execute blocked by planning gate: ${gate.reason}`);
          } else if (!levelPermits) {
            const commandTier = classifyCommandRisk(command);
            lines.push(`⚠️ Auto-execute skipped — MERGEN_AUTOPILOT_LEVEL=${autopilotLevel} permits ${autopilotLevelDescription(autopilotLevel)}. This command is \`${commandTier}\` tier. Set MERGEN_AUTOPILOT_LEVEL=full to enable.`);
          } else if (topHyp.remediationConfidence !== undefined && topHyp.remediationConfidence < AUTO_EXECUTE_CONFIDENCE_THRESHOLD()) {
            lines.push(`⚠️ Auto-execute skipped — remediation confidence ${execPct}% is below the 85% threshold (diagnosis: ${pct}%). The root cause is identified with high confidence but the fix has variable reliability — apply manually.`);
          } else {
            lines.push(`⚠️ Auto-execute skipped — confidence ${pct}% is below the 85% threshold for autonomous action.`);
          }
          lines.push('');
        }

        if (canAutoExecute && command) {
          span.setAttribute('mergen.execution.attempted', true);
          lines.push(`### Auto-Execute`, '', `Running: \`${command}\``, '');
          if (topHyp.pid) {
            void postThreadReply(topHyp.pid, `⚙️ *Mergen auto-executing fix* (diagnosis: ${pct}%, remediation: ${execPct}%)\n\`${command}\``);
          }
          const resolvedActor = actor ?? process.env.MERGEN_MCP_ACTOR ?? 'mcp-client';
          const execResult = await executeRemediation(command, { cwd, actor: resolvedActor });

          if (execResult.blocked) {
            span.setAttribute('mergen.execution.blocked', true);
            span.setAttribute('mergen.execution.block_reason', execResult.blockReason ?? '');
            lines.push(`🚫 **Blocked:** ${execResult.blockReason}`, '', 'Apply manually and validate.');
          } else if (!execResult.ok) {
            span.setAttribute('mergen.execution.ok', false);
            span.setAttribute('mergen.execution.exit_code', execResult.exitCode);
            lines.push(`❌ Command failed (exit ${execResult.exitCode}).`);
            if (execResult.stderr.trim()) {
              lines.push('', '```', execResult.stderr.trim().slice(0, 500), '```');
            }
          } else {
            span.setAttribute('mergen.execution.ok', true);
            span.setAttribute('mergen.execution.exit_code', 0);
            lines.push(`✅ Executed (${execResult.durationMs}ms, exit 0)`);
            if (execResult.stdout.trim()) {
              lines.push('', '```', execResult.stdout.trim().slice(0, 500), '```');
            }
            lines.push('');

            // Brief pause then validate
            await new Promise((r) => setTimeout(r, 3000));

            const logsAfter = store.getLogs(200, 'error', sinceTs, tenantId);
            const netAfter  = store.getNetwork(200, undefined, sinceTs, tenantId).filter((n) => n.status >= 400 || n.error);
            const afterCount = logsAfter.length + netAfter.length;
            const beforeCount = errorCount + netErrors;

            const verdict = classifyVerdict(beforeCount, afterCount);
            span.setAttribute('mergen.execution.verdict', verdict);

            if (topHyp.pid) {
              const existing = getRecords().find((r) => r.pid === topHyp.pid);
              if (existing && !existing.verdict) recordVerdict(topHyp.pid, verdict);
              recordRemediationVerdict(topHyp.pid, verdict);
              if (verdict === 'correct') {
                const resolvedAt = Date.now();
                const inc = incidentStore.upsert(topHyp.pid, {
                  status: 'resolved',
                  resolvedAt,
                  resolvedAutonomously: true,
                  causallyCorrect: true,
                });
                // Y1 corpus moat: write postmortem on every autonomous resolution
                generatePostmortem({
                  pid: topHyp.pid,
                  tag: topHyp.tag ?? 'unknown',
                  service: service ?? 'unknown',
                  rootCause: topHyp.summary ?? '',
                  fixCommand: command,
                  confidence: topHyp.confidenceScore ?? 0,
                  mttrMs: inc.createdAt ? resolvedAt - inc.createdAt : null,
                  resolvedAutonomously: true,
                  evidence: topHyp.evidence,
                  fixHint: topHyp.fixHint,
                });
              }
            }

            if (afterCount === 0) {
              lines.push('### Validation — RESOLVED', '', '✅ Zero errors after fix.');
              if (topHyp.pid) void postThreadReply(topHyp.pid, '✅ *RESOLVED* — zero errors after autonomous fix.');
            } else if (afterCount < beforeCount) {
              lines.push('### Validation — PARTIAL', '', `⚠️ ${afterCount} errors remain (down from ${beforeCount}).`);
              if (topHyp.pid) void postThreadReply(topHyp.pid, `⚠️ *PARTIAL* — ${afterCount} errors remain (down from ${beforeCount}).`);
            } else if (afterCount > beforeCount) {
              lines.push('### Validation — REGRESSED', '', `❌ ${afterCount} errors (up from ${beforeCount}). Consider reverting.`);
              if (topHyp.pid) void postThreadReply(topHyp.pid, `❌ *REGRESSED* — ${afterCount} errors (up from ${beforeCount}). Consider reverting.`);
            } else {
              lines.push('### Validation — UNRESOLVED', '', `❌ ${afterCount} errors remain (same as before).`);
              if (topHyp.pid) void postThreadReply(topHyp.pid, `❌ *UNRESOLVED* — ${afterCount} errors remain.`);
            }
          }
        } else if (command) {
          lines.push(`**Command to run:** \`${command}\``);
          lines.push('', `Call \`execute_fix(pid: "${topHyp.pid ?? 'unknown'}", confirm: true)\` to execute, or run manually.`);
        }

        // Team upgrade nudge: surfaces once the free-tier user has seen enough value
        // to justify sharing the override corpus with their on-call rotation.
        const analyzedCount = incidentStore.list(undefined, 200).length;
        if (getActivePlanId() === 'free' && analyzedCount >= TEAM_UPGRADE_INCIDENT_THRESHOLD) {
          lines.push(
            '',
            '---',
            `> **You've analyzed ${analyzedCount} incidents with Mergen.** The override corpus you've built is your team's most valuable asset — it prevents repeat failures automatically. The **Team plan ($299/mo)** shares it across your on-call rotation, adds incident replay, and unlocks the shadow analytics PDF your CISO needs before approving autopilot.`,
            `> → https://mergen.dev/pricing`,
          );
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err: any) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
