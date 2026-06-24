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
import { getStatsForTag } from './calibration.js';
import logger from '../sensor/logger.js';

const PLAN_TIER_DESCRIPTION = 'Free plan: 10 analyze credits/month. Starter ($499/mo): 100 credits. Team ($2,500/mo): 1,000 credits. See https://mergen.dev/pricing for details.';

/** Registers only `reconstruct_context` — used by slim (5-tool) MCP mode. */
export function registerAnalyzeRuntime(server: McpServer): void {
  _registerAnalyzeRuntime(server);
}

function _registerAnalyzeRuntime(server: McpServer): void {
  server.registerTool(
    'reconstruct_context',
    {
      description:
        '🔬 EXECUTION HISTORY — Reconstructs what happened in the runtime before a failure. ' +
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

      // Charge the credit only after a successful analysis — no cost for timeouts or errors.
      const credit = await consumeCredit();
      if (!credit.allowed) {
        return {
          content: [{
            type: 'text',
            text: [
              `⛔ Monthly limit reached on the **Free** plan.`,
              ``,
              `**Upgrade** at https://mergen.dev/pricing for more credits.`,
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

      // Surface the causal conclusion so the AI IDE gets a diagnosis, not a log dump.
      let hypothesisSection = '';
      if (causal.hypotheses.length > 0) {
        const top = causal.hypotheses[0];
        const pct = Math.round((top.confidenceScore ?? 0) * 100);
        const totalEvents = logs.length + network.length;
        const isThin    = totalEvents < 5;
        const isLowConf = (top.confidenceScore ?? 1) < 0.60 || top.confidence === 'LOW';

        const h: string[] = [''];

        // Item 2: honest framing when evidence is sparse or confidence is low.
        // A flagged tentative answer is more useful than silence or false certainty.
        if (isThin || isLowConf) {
          const why = isThin
            ? `only ${totalEvents} event(s) in buffer — reproduce the error for a stronger signal`
            : `${pct}% confidence — more context needed`;
          h.push(`> ⚠️ **Tentative diagnosis** (${why}). Treat as a starting hypothesis, not a verdict.`, '');
        }

        // Item 2: calibration visibility — show whether confidence is empirical or estimated.
        const calStats = getStatsForTag(top.tag);
        const calNote  = calStats?.isEmpirical
          ? `_Confidence calibrated from ${calStats.verdicts} verdict(s) on this system — empirical._`
          : `_Confidence is estimated (no local verdicts yet). Call \`validate_fix\` after applying a fix to calibrate._`;

        h.push(
          `## Root Cause — ${top.confidence} (${pct}%)`,
          calNote,
          '',
          top.summary,
          '',
        );
        if (top.causalPath?.length) {
          h.push('**Causal chain:**');
          top.causalPath.forEach((step, i) => h.push(`${i + 1}. ${step}`));
          h.push('');
        }
        if (top.evidence?.length) {
          h.push('**Evidence:**');
          top.evidence.slice(0, 3).forEach((e) => h.push(`- ${e}`));
          h.push('');
        }
        if (top.fixHint) {
          h.push(`**Fix:** ${top.fixHint}`);
          h.push('');
        }
        if (causal.hypotheses.length > 1) {
          h.push(`_${causal.hypotheses.length - 1} alternative hypothesis(es) considered and ranked lower._`);
          h.push('');
        }

        // Item 3: cross-incident "seen before" — conservative: only surface when
        // we have ≥1 prior resolved incident older than 60 s (avoids false positives).
        try {
          const { postmortemStore } = await import('./postmortem-store.js');
          const prior = postmortemStore.getByTag(top.tag, 5)
            .filter((pm) => pm.generatedAt < Date.now() - 60_000);
          if (prior.length > 0) {
            const latest  = prior[0];
            const daysAgo = Math.round((Date.now() - latest.generatedAt) / 86_400_000);
            const ageStr  = daysAgo === 0 ? 'today' : `${daysAgo}d ago`;
            const mttrStr = latest.mttrMs ? `, resolved in ${Math.round(latest.mttrMs / 60_000)}m` : '';
            h.push(
              `> 🔁 **Seen before** — ${prior.length} prior incident(s) with this pattern` +
              ` (most recent: ${ageStr}${mttrStr}). Call \`get_incident_history\` for past fixes.`,
              '',
            );
          }
        } catch { /* postmortem store unavailable — non-fatal */ }

        hypothesisSection = h.join('\n');
      }

      const fullText = causal.contextPack + hypothesisSection + noticeBlock + usageFooter;

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

      // Show how long errors have been present — "first error 45m ago" tells the dev
      // whether this is a new issue or something that's been silently broken.
      if (errors.length > 0) {
        const oldest = errors.reduce((a, b) => (a.timestamp < b.timestamp ? a : b));
        const newest = errors.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
        const fmt = (ms: number): string => {
          const s = Math.round(ms / 1000);
          if (s < 60) return `${s}s ago`;
          if (s < 3600) return `${Math.round(s / 60)}m ago`;
          return `${Math.round(s / 3600)}h ago`;
        };
        const oldestStr = fmt(Date.now() - oldest.timestamp);
        const newestStr = fmt(Date.now() - newest.timestamp);
        const timing = oldest.timestamp === newest.timestamp
          ? `first (and only) occurrence ${oldestStr}`
          : `first ${oldestStr} · most recent ${newestStr}`;
        lines.push(`| Error window     | ${timing} |`);
      }

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
        'Call this proactively whenever quick_check shows warnings, without waiting for an error — ' +
        'warnings are cheaper to fix before they cascade. No credit cost.',
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

  // ── get_system_status ──────────────────────────────────────────────────────
  // Zero-parameter "what's happening with my system?" — combines current buffer
  // with persisted postmortems. Distinct from get_status (billing info),
  // session_summary (buffer-only), and get_incident_history (needs fingerprint).
  server.registerTool(
    'get_system_status',
    {
      description:
        '⚡ FREE · No credit cost. Zero-parameter snapshot of system health across sessions. ' +
        'Answers "what is happening right now and what has happened recently?" by combining ' +
        'the live buffer (current errors, warnings, network failures) with the persistent ' +
        'incident history (past resolved incidents from SQLite, survives server restarts). ' +
        'Call this when picking up work after a break, or as the first check when something feels off. ' +
        'Use session_summary for a deeper buffer-only view; use get_incident_history for past ' +
        'incidents by fingerprint or service. For billing/plan status use get_status.',
    },
    async () => {
      trackCall('get_status');

      const errors   = store.getLogs(200, 'error');
      const warns    = store.getLogs(200, 'warn');
      const network  = store.getNetwork(200);
      const netFails = network.filter((n) => n.status >= 400 || n.status === 0 || n.error);
      const signals  = store.getSignals();

      const lines: string[] = ['## ⬡ Mergen Status', ''];

      // Current buffer state
      if (errors.length === 0 && warns.length === 0 && netFails.length === 0) {
        lines.push('**Buffer:** ✅ Clean — no errors, warnings, or network failures.');
      } else {
        lines.push('**Buffer:**');
        if (errors.length > 0) {
          const oldest = errors.reduce((a, b) => (a.timestamp < b.timestamp ? a : b));
          const ageMin = Math.round((Date.now() - oldest.timestamp) / 60_000);
          const ageStr = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`;
          lines.push(`- ❌ ${errors.length} error(s) — first appeared ${ageStr} ago`);
        }
        if (warns.length > 0) lines.push(`- ⚠️ ${warns.length} warning(s)`);
        if (netFails.length > 0) lines.push(`- 🌐 ${netFails.length} network failure(s)`);
      }

      if (signals.length > 0) {
        lines.push('');
        lines.push('**Detected patterns:**');
        for (const s of signals.slice(0, 3)) {
          lines.push(`- ${s.message}`);
        }
        lines.push('> Call `reconstruct_context` for root cause + fix.');
      }

      // Recent incident history from persistent store (cross-session)
      lines.push('');
      try {
        const { postmortemStore } = await import('./postmortem-store.js');
        const recent = postmortemStore.list(5);
        if (recent.length > 0) {
          lines.push('**Recent incidents (persistent, survives restarts):**');
          for (const pm of recent) {
            const daysAgo = Math.round((Date.now() - pm.generatedAt) / 86_400_000);
            const ageStr  = daysAgo === 0 ? 'today' : `${daysAgo}d ago`;
            const mttr    = pm.mttrMs ? ` · ${Math.round(pm.mttrMs / 60_000)}m MTTR` : '';
            const how     = pm.resolvedAutonomously ? '🤖' : '👤';
            lines.push(`- ${how} **${pm.tag.replace(/^infra_/, '')}** on \`${pm.service}\` — ${ageStr}${mttr}`);
          }
          lines.push('');
          lines.push('> Call `get_incident_history` with a service name for full history and past fixes.');
        } else {
          lines.push('**Recent incidents:** none recorded yet — incidents appear here after resolution.');
        }
      } catch {
        lines.push('**Recent incidents:** history store unavailable.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── get_env_snapshot ───────────────────────────────────────────────────────
  // Captures current env vars and diffs against the last saved snapshot.
  // Solo-dev target: "someone changed an env var" is a huge share of real incidents.
  server.registerTool(
    'get_env_snapshot',
    {
      description:
        '⚡ FREE · No credit cost. Captures the current environment variables and compares against ' +
        'the last saved snapshot in ~/.mergen/env-snapshot.json. Surfaces any additions, removals, ' +
        'or value changes since the snapshot was taken. ' +
        'Call this when something broke after a config change, or to correlate "env changed" with ' +
        'the timing of an incident. Automatically redacts secrets (keys matching ' +
        'SECRET, TOKEN, PASSWORD, KEY, CREDENTIAL). Saves a new snapshot on every call.',
    },
    async () => {
      trackCall('get_env_snapshot');

      const { readFileSync, writeFileSync, mkdirSync } = await import('fs');
      const { join } = await import('path');
      const { homedir } = await import('os');

      const REDACT_RE = /secret|token|password|passwd|key|credential|api_key|auth|private/i;
      const sanitise = (k: string, v: string): string =>
        REDACT_RE.test(k) ? '[REDACTED]' : v.slice(0, 200);

      const currentEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) currentEnv[k] = sanitise(k, v);
      }

      const snapshotDir  = join(homedir(), '.mergen');
      const snapshotPath = join(snapshotDir, 'env-snapshot.json');

      let prior: Record<string, string> | null = null;
      try {
        prior = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, string>;
      } catch { /* no prior snapshot — first call */ }

      // Save current as new snapshot
      try {
        mkdirSync(snapshotDir, { recursive: true });
        writeFileSync(snapshotPath, JSON.stringify({ ...currentEnv, _savedAt: new Date().toISOString() }, null, 2), 'utf8');
      } catch { /* non-fatal */ }

      const lines: string[] = ['## Environment Snapshot', ''];

      if (!prior) {
        lines.push('_First snapshot saved — no prior baseline to diff against._');
        lines.push(`**Variables captured:** ${Object.keys(currentEnv).length}`);
        lines.push('');
        lines.push('Call this tool again after a config change to see the diff.');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // Compute diff
      const added:   string[] = [];
      const removed: string[] = [];
      const changed: Array<{ key: string; was: string; now: string }> = [];

      for (const k of Object.keys(currentEnv)) {
        if (k === '_savedAt') continue;
        if (!(k in prior)) { added.push(k); }
        else if (prior[k] !== currentEnv[k]) { changed.push({ key: k, was: prior[k], now: currentEnv[k] }); }
      }
      for (const k of Object.keys(prior)) {
        if (k === '_savedAt') continue;
        if (!(k in currentEnv)) removed.push(k);
      }

      const savedAt = prior['_savedAt'] ? ` (snapshot from ${prior['_savedAt']})` : '';
      lines.push(`**Baseline:**${savedAt}`);
      lines.push('');

      if (added.length === 0 && removed.length === 0 && changed.length === 0) {
        lines.push('✅ **No changes** — environment is identical to the last snapshot.');
      } else {
        if (added.length > 0) {
          lines.push('### Added');
          for (const k of added.slice(0, 10)) lines.push(`- \`${k}\` = ${currentEnv[k]}`);
          if (added.length > 10) lines.push(`_...and ${added.length - 10} more_`);
          lines.push('');
        }
        if (removed.length > 0) {
          lines.push('### Removed');
          for (const k of removed.slice(0, 10)) lines.push(`- \`${k}\``);
          lines.push('');
        }
        if (changed.length > 0) {
          lines.push('### Changed');
          for (const { key, was, now } of changed.slice(0, 10)) {
            lines.push(`- \`${key}\`: \`${was}\` → \`${now}\``);
          }
          if (changed.length > 10) lines.push(`_...and ${changed.length - 10} more_`);
          lines.push('');
        }
        lines.push('> If any of these changes correlate with when errors started, use `get_regression_start` to confirm timing.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── get_diff_from_baseline ─────────────────────────────────────────────────
  // Answers "what's different from when it last worked?" — a different question
  // from "what's wrong now?" and a different computation from root-cause analysis.
  server.registerTool(
    'get_diff_from_baseline',
    {
      description:
        '⚡ FREE · No credit cost. Answers "what changed since it last worked?" by splitting ' +
        'the error history into two windows and showing what is NEW in the recent window. ' +
        'Use this when a user says "this used to work" or "something changed" — it surfaces ' +
        'new error fingerprints, newly failing endpoints, and the timing of when they appeared. ' +
        'Queries persistent SQLite history so it works across server restarts. ' +
        'Different from reconstruct_context (which identifies root cause) and session_summary ' +
        '(which describes the current buffer) — this is the delta view.',
      inputSchema: {
        lookback_minutes: z.number().int().min(5).max(1440).optional()
          .describe('How far back to look (default 60). The baseline is the equal-length window before that.'),
      },
    },
    async ({ lookback_minutes = 60 }) => {
      trackCall('get_diff_from_baseline');

      const { historyStore } = await import('../sensor/sqlite-store.js');
      const { normaliseMessage } = await import('./error-fingerprint.js');

      const now         = Date.now();
      const windowMs    = lookback_minutes * 60_000;
      const recentStart = now - windowMs;
      const baseStart   = now - windowMs * 2;

      // Query both windows from persistent store
      const baseErrors   = (historyStore.query({ since: baseStart, limit: 5000, type: 'console', level: 'error' }) as import('../sensor/buffer.js').ConsoleEvent[])
        .filter((e) => e.timestamp < recentStart);
      const recentErrors = (historyStore.query({ since: recentStart, limit: 5000, type: 'console', level: 'error' }) as import('../sensor/buffer.js').ConsoleEvent[]);

      const baseNetwork   = store.getNetwork(500, undefined, baseStart).filter((n) => n.timestamp < recentStart && (n.status >= 400 || !!n.error));
      const recentNetwork = store.getNetwork(500, undefined, recentStart).filter((n) => n.status >= 400 || !!n.error);

      // Fingerprint the base errors so we can diff
      const baseFingerprints = new Set(
        baseErrors.map((e) => normaliseMessage(e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '))),
      );
      const baseEndpoints = new Set(baseNetwork.map((n) => `${n.method} ${n.url}`));

      // New error patterns: in recent but NOT in baseline
      const newErrors = recentErrors.filter((e) => {
        const fp = normaliseMessage(e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
        return !baseFingerprints.has(fp);
      });
      const newEndpoints = recentNetwork.filter((n) => !baseEndpoints.has(`${n.method} ${n.url}`));

      // Deduplicate new errors for display
      const seen = new Set<string>();
      const uniqueNewErrors: Array<{ fp: string; sample: string; count: number; firstSeen: number }> = [];
      for (const e of newErrors) {
        const msg = e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        const fp  = normaliseMessage(msg);
        if (!seen.has(fp)) {
          seen.add(fp);
          const count = newErrors.filter((x) => {
            const xmsg = x.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            return normaliseMessage(xmsg) === fp;
          }).length;
          uniqueNewErrors.push({ fp, sample: msg.slice(0, 120), count, firstSeen: e.timestamp });
        }
      }

      const seenEp = new Set<string>();
      const uniqueNewEp: Array<{ key: string; status: number; count: number }> = [];
      for (const n of newEndpoints) {
        const key = `${n.method} ${n.url}`;
        if (!seenEp.has(key)) {
          seenEp.add(key);
          uniqueNewEp.push({ key, status: n.status, count: newEndpoints.filter((x) => `${x.method} ${x.url}` === key).length });
        }
      }

      const fmtAgo = (ts: number) => {
        const min = Math.round((now - ts) / 60_000);
        return min < 60 ? `${min}m ago` : `${Math.round(min / 60)}h ago`;
      };

      const lines: string[] = [
        `## Diff from Baseline — last ${lookback_minutes}m vs. ${lookback_minutes}m before that`,
        '',
        `**Baseline:** ${baseErrors.length} error(s), ${baseNetwork.length} network failure(s)`,
        `**Recent:**   ${recentErrors.length} error(s), ${recentNetwork.length} network failure(s)`,
        '',
      ];

      if (uniqueNewErrors.length === 0 && uniqueNewEp.length === 0) {
        if (recentErrors.length === 0) {
          lines.push('✅ **No change detected** — no errors in either window.');
        } else {
          lines.push('✅ **No new patterns** — errors present but same fingerprints as baseline (not a regression, likely ongoing).');
        }
      } else {
        if (uniqueNewErrors.length > 0) {
          lines.push('### New error patterns (not in baseline)');
          lines.push('');
          for (const e of uniqueNewErrors.slice(0, 5)) {
            lines.push(`- **×${e.count}** — "${e.sample}" _(first seen ${fmtAgo(e.firstSeen)})_`);
          }
          lines.push('');
        }
        if (uniqueNewEp.length > 0) {
          lines.push('### Newly failing endpoints');
          lines.push('');
          for (const ep of uniqueNewEp.slice(0, 5)) {
            lines.push(`- **×${ep.count}** \`${ep.key}\` → ${ep.status || 'ERR'}`);
          }
          lines.push('');
        }
        lines.push('> 🔬 Call `reconstruct_context` for root cause + fix hint on these new patterns.');
        lines.push('> Call `get_regression_start` to find the exact timestamp when each pattern first appeared.');
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
        'Finds when an error pattern FIRST appeared and correlates it with the closest deploy or CI event before that timestamp. ' +
        'Call this FIRST when the user says "something broke" or "this stopped working" — it answers ' +
        '"when did this start and what change introduced it?" without requiring any parameters. ' +
        'Queries full SQLite history across server restarts, so it remembers errors from previous sessions. ' +
        'Works even without deploy/CI integration — always returns the first-seen timestamp and occurrence count.',
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
        const ageMs  = Date.now() - first.timestamp;
        const ageMin = Math.round(ageMs / 60_000);
        const ageStr = ageMin < 60 ? `${ageMin} minutes ago` : `${Math.round(ageMin / 60)} hours ago`;
        lines.push(`**No deploy or CI signal found** — can't attribute this to a specific change.`);
        lines.push(`What I know: this error first appeared **${ageStr}** and has fired **${matching.length} time(s)** since.`);
        lines.push('');
        lines.push('**To enable deploy correlation (pick one):**');
        lines.push('  `mergen-server watch npm start` — captures process restarts as deploy events automatically');
        lines.push('  `POST /ci {"status":"success","sha":"abc123"}` — from any CI step or deploy script');
      }

      // Item 1: cross-tool pointer — only when errors are currently active.
      // reconstruct_context doesn't point back here, so no loop.
      const activeErrors = store.getLogs(5, 'error');
      if (activeErrors.length > 0 && matching.length > 0) {
        lines.push('');
        lines.push('> 🔬 **For the causal chain and fix hint:** call `reconstruct_context`.');
        lines.push('> Regression start tells you *when* — reconstruct_context tells you *why* and what to do.');
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
