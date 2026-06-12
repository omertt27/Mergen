import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store } from '../sensor/buffer.js';
import { truncateToTokenBudget } from './token-budget.js';
import { consumeCredit, getUsageSnapshot } from './usage.js';
import { buildCausalChain } from './causal.js';
import { buildCausalGraph } from './causal-graph.js';
import { hypothesisHistory } from './hypothesis-history.js';
import { computeErrorFrequency, computeNetworkFrequency } from './error-fingerprint.js';
import { computeAnomaly, getAnomalousPatterns } from './baseline.js';
import { generateReproSteps } from './repro-steps.js';
import { trackCall, buildCreditBar, getLastClearAt, setFirstAnalyzeAt, setLastTimeToFirstAnalysisMs } from './tools-state.js';
import { startSession } from './session-metrics.js';
import logger from '../sensor/logger.js';

const PLAN_TIER_DESCRIPTION = 'Free: up to 25 incidents/month (shadow mode). Pro ($29/mo): 200 incidents/month, $50 overage ceiling.';

/** Registers only `reconstruct_context` — used by slim (5-tool) MCP mode. */
export function registerAnalyzeRuntime(server: McpServer): void {
  _registerAnalyzeRuntime(server);
}

function _registerAnalyzeRuntime(server: McpServer): void {
  server.registerTool(
    'reconstruct_context',
    {
      description:
        '🔬 OPERATIONAL MEMORY — Reconstructs what happened in the runtime before a failure. ' +
        'Resolves stack frames to original source (with code snippets), tracks event dependencies ' +
        '(request → response → state mutation → crash), flags AI-generated commits in the blast radius, ' +
        'and produces a structured diagnosis with root-cause summary, causal path, and fix hint. ' +
        'Use whenever the user asks why something broke, what changed before an error, or needs ' +
        'context about an AI-written service they did not author. ' +
        PLAN_TIER_DESCRIPTION,
      inputSchema: {
        focus: z.enum(['errors', 'network', 'all']).optional()
          .describe('Limit analysis scope (default: all)'),
        since: z.number().int().optional()
          .describe('Only analyze events after this Unix timestamp in ms'),
        max_tokens: z.number().int().min(100).max(10000).optional()
          .describe('Soft token limit for response. Will truncate if exceeded.'),
      },
    },
    async ({ focus = 'all', since, max_tokens }) => {
      trackCall('reconstruct_context');
      setLastTimeToFirstAnalysisMs(Date.now() - getLastClearAt());

      const credit = await consumeCredit();
      if (!credit.allowed) {
        return {
          content: [{
            type: 'text',
            text: [
              `⛔ Monthly limit reached on the **Free** plan.`,
              ``,
              `**Upgrade to Pro** ($29/mo) for 200 incidents/month with a $50/month overage ceiling.`,
              `→ https://mergen.dev/pricing`,
              ``,
              `**Continue debugging with free tools:**`,
              `1. \`get_incident_context\` — fetch active Datadog incident context (free)`,
              `2. \`triage_incident\` — full causal analysis without credit cost`,
              ``,
              `Call \`triage_incident\` to continue debugging.`,
            ].join('\n'),
          }],
          isError: true,
        };
      }

      const logs     = focus === 'network' ? [] : store.getLogs(200, undefined, since);
      const network  = focus === 'errors'  ? [] : store.getNetwork(200, undefined, since);
      const contexts = store.getContext(20, since);

      const terminal     = store.getTerminalOutput(100, undefined, since);
      const processExits = store.getProcessExits(20, undefined, since);
      const ciEvents     = store.getCIEvents(20, undefined, since);
      const deployments  = store.getDeployments(10, undefined, since);
      let causal;
      try {
        causal = await Promise.race([
          buildCausalChain(logs, network, contexts, since, terminal, processExits, ciEvents, deployments),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('analysis timeout')), 30_000),
          ),
        ]);
      } catch (err) {
        logger.warn({ err }, 'reconstruct_context: causal analysis failed — returning raw telemetry');
        const errorCount = logs.filter((e) => e.level === 'error').length;
        const netErrors  = (network as Array<{ status: number; error?: unknown; method: string; url: string }>)
          .filter((n) => n.status >= 400 || !!n.error);
        const topErrors  = logs.filter((e) => e.level === 'error').slice(0, 5);
        return {
          content: [{
            type: 'text',
            text: [
              `⚡ **Raw Telemetry Snapshot** (analysis unavailable — ${err instanceof Error ? err.message : 'unknown error'})`,
              ``,
              `**${errorCount} console errors, ${netErrors.length} network failures** in window`,
              topErrors.length > 0
                ? `**Top errors:**\n${topErrors.map((e) => `- ${String(e.args?.[0] ?? '').slice(0, 120)}`).join('\n')}`
                : '',
              netErrors.length > 0
                ? `**Network failures:**\n${netErrors.slice(0, 5).map((n) => `- ${n.method} ${n.url} → ${n.status}`).join('\n')}`
                : '',
              ``,
              `_Manual investigation required. Retry \`reconstruct_context\` if the issue persists._`,
            ].filter(Boolean).join('\n'),
          }],
          isError: true,
        };
      }

      setFirstAnalyzeAt(Date.now());

      for (const h of causal.hypotheses) {
        if (h.pid) startSession(h.pid, h.tag);
      }

      const usage       = getUsageSnapshot();
      const usageFooter = usage.included === null
        ? `\n\n---\n*Credits used this month: ${usage.used} (unlimited plan)*`
        : `\n\n---\n*Credits: ${usage.used} / ${usage.included} used` +
          (usage.overage > 0 ? ` · ${usage.overage} overage ($${(usage.estimatedOverageCents / 100).toFixed(2)} est.)` : '') +
          ` · resets ${new Date(usage.resetsAt).toUTCString()}*`;

      const noticeBlock = credit.notice ? `\n\n> ${credit.notice}` : '';
      const fullText    = causal.contextPack + noticeBlock + usageFooter;

      const { result, truncated, omitted, estimatedTokens } = truncateToTokenBudget(fullText.split('\n'), max_tokens, '\n');
      if (truncated) logger.info({ tool: 'reconstruct_context', omitted, estimatedTokens }, 'response truncated');

      return { content: [{ type: 'text', text: result }] };
    },
  );
}

export function registerAnalysisTools(server: McpServer): void {
  // ── quick_check ────────────────────────────────────────────────────────────
  server.registerTool(
    'quick_check',
    {
      description:
        '⚡ FREE · No credit cost. Instant buffer pulse — use this constantly during development, ' +
        'not just when things break. Returns: error/warning/network counts, and any detected patterns ' +
        '(repeated failures, warning spikes, slow requests). ' +
        'Call this before writing code, after running the app, or whenever something feels off. ' +
        'For the root cause and a code fix, call reconstruct_context.',
    },
    async () => {
      trackCall('quick_check');
      const errors   = store.getLogs(200, 'error');
      const warns    = store.getLogs(200, 'warn');
      const network  = store.getNetwork(200);
      const signals  = store.getSignals();
      const netFails = network.filter((n) => n.status >= 400 || n.status === 0 || n.error);

      const lines: string[] = ['## ⚡ Quick Check', ''];
      const errLabel  = errors.length   === 0 ? '✅ 0' : `❌ ${errors.length}`;
      const warnLabel = warns.length    === 0 ? '✅ 0' : `⚠️ ${warns.length}`;
      const netLabel  = netFails.length === 0 ? '✅ 0' : `❌ ${netFails.length}`;
      lines.push('| | Count |');
      lines.push('|---|---|');
      lines.push(`| Console errors   | ${errLabel} |`);
      lines.push(`| Warnings         | ${warnLabel} |`);
      lines.push(`| Network failures | ${netLabel} |`);
      lines.push(`| Buffer total     | ${store.size()} |`);

      if (signals.length > 0) {
        lines.push('', '### 🔍 Detected patterns', '');
        for (const s of signals) {
          const confPct = Math.round(s.confidence * 100);
          lines.push(`**${confPct}%** — ${s.message}`);
          lines.push(`  → **Next step:** ${s.action}`);
          lines.push('');
        }
        lines.push('> 🔬 **Root cause + fix:** call `reconstruct_context`.');
      } else if (errors.length > 0) {
        lines.push('', `> ❌ ${errors.length} error(s) in buffer. Call \`reconstruct_context\` for root cause + fix.`);
      } else if (warns.length > 0) {
        lines.push('', `> ⚠️ ${warns.length} warning(s) in buffer. Call \`explain_warning\` to understand them before they escalate.`);
      } else {
        lines.push('', '> ✅ Buffer clean — no errors, warning spikes, or repeated failures.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── explain_warning ────────────────────────────────────────────────────────
  server.registerTool(
    'explain_warning',
    {
      description:
        '⚡ FREE · No credit cost. Explains the most recent console warning — ' +
        'what it means, why it might cause a crash later, and what to do about it. ' +
        'Use this immediately when you see a warning you don\'t understand, ' +
        'before it cascades into a harder-to-debug error. No credit cost.',
      inputSchema: {
        since: z.number().int().optional()
          .describe('Only look at warnings after this Unix timestamp in ms'),
      },
    },
    async ({ since }) => {
      trackCall('explain_warning');
      const warns = store.getLogs(200, 'warn', since);

      if (warns.length === 0) {
        return { content: [{ type: 'text', text: '✅ No warnings in buffer.' }] };
      }

      const latest  = warns[warns.length - 1];
      const message = latest.args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ').slice(0, 500);

      const windowMs      = 5_000;
      const nearbyNetwork = store.getNetwork(200).filter(
        (n) => Math.abs(n.timestamp - latest.timestamp) < windowMs,
      );
      const nearbyErrors  = store.getLogs(200, 'error').filter(
        (e) => e.timestamp > latest.timestamp,
      );

      const lines: string[] = [
        '## ⚠️ Warning Explanation', '',
        `**Message:** \`${message}\``,
        `**When:** ${new Date(latest.timestamp).toISOString()}`,
        `**URL:** ${latest.url}`,
      ];

      if (latest.stack) {
        lines.push('', '<details><summary>📋 Stack trace</summary>', '', '```', latest.stack.slice(0, 1000), '```', '</details>');
      }

      if (nearbyNetwork.length > 0) {
        lines.push('', '**Nearby network activity (±5s):**');
        for (const n of nearbyNetwork.slice(0, 3)) {
          const badge = n.status >= 400 || n.status === 0 ? '❌' : '✅';
          lines.push(`- ${badge} \`${n.method} ${n.url}\` → ${n.status} (${n.duration}ms)`);
        }
      }

      if (nearbyErrors.length > 0) {
        lines.push('', `> ⚠️ **${nearbyErrors.length} error(s) fired AFTER this warning** — this warning may have been a precursor.`);
        lines.push('> Call **`reconstruct_context`** for a full causal chain.');
      }

      if (warns.length > 1) {
        lines.push('', `*${warns.length - 1} other warning(s) in buffer — showing most recent only.*`);
      }

      lines.push('', '---', '**Your task:** Explain what this warning means, why it could cause a crash, and the minimal fix.');

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── session_summary ────────────────────────────────────────────────────────
  server.registerTool(
    'session_summary',
    {
      description:
        '⚡ FREE · No credit cost. Summarises everything that happened in the current buffer: ' +
        'total errors, repeated failures, warning patterns, slow endpoints, and the top signals. ' +
        'Use this at the end of a debug session, when picking up work after a break, ' +
        'or to get a "what has been happening?" overview without running a full analysis. ' +
        'No credit cost.',
      inputSchema: {
        since: z.number().int().optional()
          .describe('Summarise only events after this Unix timestamp in ms'),
      },
    },
    async ({ since }) => {
      trackCall('session_summary');
      const logs    = store.getLogs(200, undefined, since);
      const network = store.getNetwork(200, undefined, since);
      const signals = store.getSignals();

      const errors   = logs.filter((e) => e.level === 'error');
      const warns    = logs.filter((e) => e.level === 'warn');
      const netFails = network.filter((n) => n.status >= 400 || n.status === 0 || n.error);
      const slowReqs = network.filter((n) => n.duration > 2000);

      const lines: string[] = ['## 📊 Session Summary', ''];
      lines.push('| Metric | Value |', '|---|---|');
      lines.push(`| Console errors     | ${errors.length} |`);
      lines.push(`| Warnings           | ${warns.length} |`);
      lines.push(`| Network failures   | ${netFails.length} |`);
      lines.push(`| Slow requests (>2s)| ${slowReqs.length} |`);
      lines.push(`| Total events       | ${store.size()} |`, '');

      if (errors.length > 0) {
        const seen = new Map<string, number>();
        for (const e of errors) {
          const msg = e.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').split('\n')[0].slice(0, 100);
          seen.set(msg, (seen.get(msg) ?? 0) + 1);
        }
        lines.push('### ❌ Errors', '');
        for (const [msg, count] of [...seen.entries()].sort((a, b) => b[1] - a[1]))
          lines.push(`- ${count > 1 ? `**(×${count})**` : ''} \`${msg}\``);
        lines.push('');
      }

      if (netFails.length > 0) {
        lines.push('### 🌐 Failing endpoints', '');
        const seen = new Map<string, { count: number; status: number }>();
        for (const n of netFails) {
          const key  = `${n.method} ${n.url}`;
          const prev = seen.get(key);
          seen.set(key, { count: (prev?.count ?? 0) + 1, status: n.status });
        }
        for (const [endpoint, { count, status }] of [...seen.entries()].sort((a, b) => b[1].count - a[1].count))
          lines.push(`- ${count > 1 ? `**(×${count})**` : ''} \`${endpoint}\` → ${status || 'NET_ERR'}`);
        lines.push('');
      }

      if (signals.length > 0) {
        lines.push('### 🔍 Patterns detected', '');
        for (const s of signals) {
          lines.push(`- ${s.message}`);
          lines.push(`  → **${s.action}**`);
        }
        lines.push('');
      }

      if (errors.length > 0 || signals.length > 0) {
        lines.push('> 💡 Call **`reconstruct_context`** for root cause analysis and a fix suggestion.');
      } else {
        lines.push('> ✅ Session looks clean — no significant errors or patterns detected.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── get_error_frequency ────────────────────────────────────────────────────
  server.registerTool(
    'get_error_frequency',
    {
      description:
        'Returns deduplicated error patterns with occurrence counts, first/last seen times, and whether each pattern is new this session. ' +
        'Use this to distinguish "this error fired 847 times" from "this is the first occurrence." ' +
        'High-count errors are fires; single occurrences are investigations.',
      inputSchema: {
        since: z.number().int().optional().describe('Only count errors after this Unix timestamp in ms'),
        top: z.number().int().min(1).max(50).optional().describe('Return top N patterns by count (default 10)'),
      },
    },
    async ({ since, top = 10 }) => {
      trackCall('get_error_frequency');
      const logs    = store.getLogs(200, 'error', since);
      const network = store.getNetwork(200, undefined, since);

      const errFreq = computeErrorFrequency(logs).slice(0, top);
      const netFreq = computeNetworkFrequency(network).slice(0, top);

      if (errFreq.length === 0 && netFreq.length === 0) {
        return { content: [{ type: 'text', text: 'No errors in buffer.' }] };
      }

      const lines = ['## Error Frequency\n'];
      if (errFreq.length > 0) {
        lines.push('### Console Errors\n');
        for (const e of errFreq) {
          const age      = `first: ${new Date(e.firstSeen).toISOString().slice(11, 19)}, last: ${new Date(e.lastSeen).toISOString().slice(11, 19)}`;
          const newBadge = e.isNew ? ' 🆕' : '';
          lines.push(`**×${e.count}**${newBadge} — "${e.sample.slice(0, 100)}"`);
          lines.push(`   pattern: \`${e.fingerprint}\` | ${age}`);
          lines.push('');
        }
      }
      if (netFreq.length > 0) {
        lines.push('### Network Failures\n');
        for (const n of netFreq) lines.push(`**×${n.count}** — ${n.sample}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── get_anomaly_baseline ───────────────────────────────────────────────────
  server.registerTool(
    'get_anomaly_baseline',
    {
      description:
        'Compares the current error rate to the historical baseline for this time of day and day of week. ' +
        'Returns whether the current rate is anomalous, the normal rate, the multiplier, and a human-readable summary. ' +
        'Requires MERGEN_RETENTION_HOURS ≥ 24 for a meaningful baseline — with only 1h of data it will report insufficient data.',
      inputSchema: {
        fingerprint: z.string().optional()
          .describe('Specific error pattern to check (from get_error_frequency). Empty = check all errors.'),
      },
    },
    async ({ fingerprint = '' }) => {
      trackCall('get_anomaly_baseline');
      const { historyStore } = await import('../sensor/sqlite-store.js');
      const since7d    = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const histEvents = historyStore.query({ since: since7d, limit: 10000, level: 'error', type: 'console' }) as import('../sensor/buffer.js').ConsoleEvent[];
      const current    = store.getLogs(200, 'error', Date.now() - 60 * 60 * 1000);

      if (fingerprint) {
        const result = await computeAnomaly(histEvents, current, fingerprint);
        return { content: [{ type: 'text', text: result.summary }] };
      }

      const anomalies = await getAnomalousPatterns(histEvents, current);
      const overall   = await computeAnomaly(histEvents, current);

      const lines = ['## Anomaly Baseline\n', overall.summary, ''];
      if (anomalies.length > 0) {
        lines.push(`### Anomalous patterns (${anomalies.length})\n`);
        for (const a of anomalies.slice(0, 5)) {
          const mult = isFinite(a.multiplier) ? `${a.multiplier.toFixed(1)}×` : 'new';
          lines.push(`- **${mult} above baseline** — \`${a.fingerprint}\` (${a.currentCount} now vs ${a.normalRate.toFixed(1)} normal)`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── get_regression_start ───────────────────────────────────────────────────
  server.registerTool(
    'get_regression_start',
    {
      description:
        'Finds when an error pattern FIRST appeared, then correlates with the most recent deployment or CI event before that timestamp. ' +
        'Answers "when did this regression start and what change introduced it?" ' +
        'Works best when CI and deployment events are being sent to Mergen.',
      inputSchema: {
        fingerprint: z.string().optional()
          .describe('Error pattern fingerprint from get_error_frequency. If omitted, uses the most frequent current error.'),
      },
    },
    async ({ fingerprint }) => {
      trackCall('get_regression_start');
      const { historyStore }   = await import('../sensor/sqlite-store.js');
      const { normaliseMessage } = await import('./error-fingerprint.js');

      const allErrors     = historyStore.query({ since: 0, limit: 10000, type: 'console', level: 'error' }) as import('../sensor/buffer.js').ConsoleEvent[];
      const currentErrors = store.getLogs(200, 'error');

      let fp = fingerprint;
      if (!fp && currentErrors.length > 0) {
        const { computeErrorFrequency: cef } = await import('./error-fingerprint.js');
        const top = cef(currentErrors)[0];
        fp = top?.fingerprint ?? '';
      }
      if (!fp) return { content: [{ type: 'text', text: 'No error patterns found in buffer.' }] };

      const matching = allErrors.filter((e) => {
        const msg = e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        return normaliseMessage(msg) === fp;
      }).sort((a, b) => a.timestamp - b.timestamp);

      if (matching.length === 0) return { content: [{ type: 'text', text: `No historical data for pattern: \`${fp}\`` }] };

      const first    = matching[0];
      const firstIso = new Date(first.timestamp).toISOString();

      const deploys      = store.getDeployments(20).filter((d) => d.timestamp <= first.timestamp).sort((a, b) => b.timestamp - a.timestamp);
      const ci           = store.getCIEvents(20).filter((c) => c.timestamp <= first.timestamp).sort((a, b) => b.timestamp - a.timestamp);
      const triggerDeploy = deploys[0] ?? null;
      const triggerCI    = ci.find((c) => c.status === 'failure') ?? ci[0] ?? null;

      const lines = [
        `## Regression Start\n`,
        `**Pattern:** \`${fp}\``,
        `**First seen:** ${firstIso}`,
        `**Total occurrences in history:** ${matching.length}`,
        '',
      ];

      if (triggerDeploy) {
        const msBefore = first.timestamp - triggerDeploy.timestamp;
        lines.push(`**Closest deploy before first occurrence:** \`${triggerDeploy.shortSha ?? triggerDeploy.sha.slice(0, 7)}\` to ${triggerDeploy.environment} (${Math.round(msBefore / 60000)}m before error)`);
        if (triggerDeploy.actor) lines.push(`   Deployed by: ${triggerDeploy.actor}`);
      }
      if (triggerCI) {
        lines.push(`**CI run before first occurrence:** ${triggerCI.job} — ${triggerCI.status}${triggerCI.failedTests?.length ? ` (${triggerCI.failedTests.length} failing tests)` : ''}`);
      }
      if (!triggerDeploy && !triggerCI) {
        lines.push('No deployment or CI events found before first occurrence.');
        lines.push('Connect CI and deployments to Mergen for automatic regression attribution.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── get_repro_steps ────────────────────────────────────────────────────────
  server.registerTool(
    'get_repro_steps',
    {
      description:
        'Generates draft "steps to reproduce" from the event timeline — user navigation, network calls, state changes, and the error. ' +
        'Ready to paste into a Jira or Linear ticket. Confidence is HIGH when ≥3 context snapshots are available.',
      inputSchema: {
        since: z.number().int().optional().describe('Only use events after this Unix timestamp in ms'),
      },
    },
    async ({ since }) => {
      trackCall('get_repro_steps');
      const logs     = store.getLogs(200, undefined, since);
      const network  = store.getNetwork(200, undefined, since);
      const contexts = store.getContext(20, since);
      const repro    = generateReproSteps(logs, network, contexts);
      return { content: [{ type: 'text', text: `## Reproduction Steps (confidence: ${repro.confidence})\n\n${repro.markdown}` }] };
    },
  );

  // ── get_causal_graph ───────────────────────────────────────────────────────
  server.registerTool(
    'get_causal_graph',
    {
      description:
        '⚡ FREE · Returns the causal graph of the current session as structured JSON — ' +
        'typed nodes (error, warn, network_fail, network_ok, state, process_exit) and ' +
        'typed edges (TRACE_JOINED, CAUSED_BY, STATE_AT, CORRELATED_WITH, PRECEDED_BY). ' +
        'Model-agnostic: any consumer can traverse this graph without relying on natural-language summaries. ' +
        'Edge kinds are ordered by determinism: TRACE_JOINED is exact (W3C traceparent match), ' +
        'CAUSED_BY is detector-validated, CORRELATED_WITH is temporal proximity only. ' +
        'Use this to reason about event causality programmatically, build visualizations, ' +
        'or feed structured data to a custom pipeline — without spending reconstruct_context credits.',
      inputSchema: {
        since: z.number().int().optional().describe('Only include events after this Unix timestamp in ms'),
      },
    },
    async ({ since }) => {
      trackCall('get_causal_graph');
      const logs         = store.getLogs(200, undefined, since);
      const network      = store.getNetwork(200, undefined, since);
      const contexts     = store.getContext(20, since);
      const terminal     = store.getTerminalOutput(100, undefined, since);
      const processExits = store.getProcessExits(20, undefined, since);
      const ciEvents     = store.getCIEvents(20, undefined, since);
      const deployments  = store.getDeployments(10, undefined, since);

      const causal = await buildCausalChain(logs, network, contexts, since, terminal, processExits, ciEvents, deployments);
      const graph  = buildCausalGraph(causal);

      return { content: [{ type: 'text', text: JSON.stringify(graph, null, 2) }] };
    },
  );

  _registerAnalyzeRuntime(server);

  // ── suggest_logging_locations ──────────────────────────────────────────────
  server.registerTool(
    'suggest_logging_locations',
    {
      description:
        '⚡ FREE · Given a hypothesis from reconstruct_context, reads your source files and suggests ' +
        'exactly where to add console.log statements to validate the hypothesis. ' +
        'Identifies function entry points, conditional branches, and error paths relevant to the diagnosis. ' +
        'Returns copy-pasteable console.log snippets with specific line numbers.',
      inputSchema: {
        hypothesis: z.string()
          .describe('The hypothesis text from reconstruct_context (e.g. "JWT token expired before request")'),
        file_path: z.string().optional()
          .describe('Absolute or workspace-relative path to a source file to analyze. If omitted, uses recent stack frames from buffer.'),
        max_suggestions: z.number().int().min(1).max(20).optional()
          .describe('Maximum number of suggestions to return (default: 5)'),
      },
    },
    async ({ hypothesis, file_path, max_suggestions = 5 }) => {
      const { readFileSync, existsSync } = await import('fs');
      const { resolve, basename }        = await import('path');

      const recentLogs = store.getLogs(50);
      const frameFiles = new Set<string>();
      for (const ev of recentLogs) {
        if (ev.level === 'error' && ev.stack) {
          const matches = ev.stack.matchAll(/\(?((?:\/|\.\/|\.\.\/)[\w./\-]+\.(?:ts|tsx|js|jsx)):/g);
          for (const m of matches) {
            const fp = m[1];
            if (!fp.includes('node_modules')) frameFiles.add(fp);
          }
        }
      }

      const candidates: string[] = file_path
        ? [resolve(file_path)]
        : Array.from(frameFiles).slice(0, 3);

      if (candidates.length === 0) {
        return {
          content: [{
            type: 'text',
            text:
              '## 🔍 No source files found\n\n' +
              'No recent stack frames in the buffer and no `file_path` provided.\n\n' +
              '**How to use:**\n' +
              '1. Trigger the error in your app to capture stack frames\n' +
              '2. Then call this tool again, or pass `file_path` directly\n\n' +
              '**Example:**\n' +
              '```\n' +
              'suggest_logging_locations(\n' +
              '  hypothesis: "JWT token expired before request",\n' +
              '  file_path: "src/auth/login.ts"\n' +
              ')\n' +
              '```',
          }],
        };
      }

      const keywords = hypothesis
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 3 && !['with', 'from', 'that', 'this', 'when', 'then', 'before', 'after'].includes(w));

      const lines: string[] = ['## 💡 Suggested Logging Locations', '', `**Hypothesis:** ${hypothesis}`, ''];

      let totalSuggestions = 0;

      for (const filePath of candidates) {
        if (totalSuggestions >= max_suggestions) break;
        if (!existsSync(filePath)) continue;

        let src: string;
        try { src = readFileSync(filePath, 'utf8'); } catch { continue; }

        const fileLines = src.split('\n');
        const fileName  = basename(filePath);
        const suggestions: Array<{ lineNum: number; context: string; logSnippet: string }> = [];

        for (let i = 0; i < fileLines.length; i++) {
          const line      = fileLines[i];
          const lineLower = line.toLowerCase();
          if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('*') || lineLower.includes('import ')) continue;

          let score = 0;
          for (const kw of keywords) if (lineLower.includes(kw)) score += 2;

          const isFunctionEntry = /^\s*(async\s+)?function\s+\w+|^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(|^\s*(async\s+)?\(\s*\)\s*=>/.test(line);
          const isConditional   = /^\s*(if|else if|switch)\s*\(/.test(line);
          const isErrorPath     = /catch\s*\(|\.catch\(|reject\(|throw\s+/.test(line);
          const isReturn        = /^\s*return\s+/.test(line);
          const isAwait         = /await\s+/.test(line);

          if (isFunctionEntry)          score += 3;
          if (isConditional && score > 0) score += 2;
          if (isErrorPath)              score += 4;
          if (isReturn && score > 0)    score += 1;
          if (isAwait && score > 0)     score += 1;
          if (score < 2) continue;

          const indent   = line.match(/^(\s*)/)?.[1] ?? '';
          const context  = line.trim().slice(0, 80);
          let logSnippet: string;

          if (isErrorPath) {
            logSnippet = `${indent}console.error('[mergen] ${hypothesis.slice(0, 40)} — error path', { error: e ?? err, timestamp: Date.now() });`;
          } else if (isConditional) {
            const condMatch = line.match(/(?:if|else if)\s*\((.+)\)/);
            const cond      = condMatch ? condMatch[1].slice(0, 60) : 'condition';
            logSnippet = `${indent}console.log('[mergen] branch: ${cond}', { result: ${cond.split(/[=!<>& |]+/)[0]?.trim() ?? 'value'} });`;
          } else if (isFunctionEntry) {
            const fnMatch = line.match(/function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=/);
            const fnName  = fnMatch ? (fnMatch[1] || fnMatch[2]) : 'fn';
            logSnippet = `${indent}console.log('[mergen] ${fnName} called', { args: arguments, timestamp: Date.now() });`;
          } else {
            logSnippet = `${indent}console.log('[mergen] checkpoint', { line: ${i + 1}, value: /* insert variable */ undefined });`;
          }

          suggestions.push({ lineNum: i + 1, context, logSnippet });
        }

        const topSuggestions = suggestions.slice(0, max_suggestions - totalSuggestions);
        if (topSuggestions.length > 0) {
          lines.push(`### 📄 ${fileName}`, `\`${filePath}\``, '');
          for (const s of topSuggestions) {
            lines.push(`**Line ${s.lineNum}:** \`${s.context}\``);
            lines.push('```typescript', `// Add BEFORE line ${s.lineNum}:`, s.logSnippet, '```', '');
            totalSuggestions++;
          }
        }
      }

      if (totalSuggestions === 0) {
        lines.push('No specific logging locations found in the analyzed file(s).', '');
        lines.push('**Tips:**');
        lines.push('- Pass a more specific `file_path` (e.g., `src/auth/login.ts`)');
        lines.push('- Trigger the error in your app so stack frames are captured');
        lines.push('- Try a more specific `hypothesis` with code-related keywords');
      } else {
        lines.push('---', '**After adding logs:** reproduce the issue, then call `get_recent_logs(level: "log")` to see the output.');
        lines.push('Use `link_fix` after you resolve the issue to train the accuracy model.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
