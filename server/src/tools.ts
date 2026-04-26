import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store, LogLevel } from './buffer.js';
import { consumeCredit, getUsageSnapshot } from './usage.js';
import { getActivePlanId, getLicenseState } from './license.js';
import { getPlan, PLANS } from './plans.js';
import { buildCausalChain } from './causal.js';

// ── Internal call tracker ─────────────────────────────────────────────────────
// Lightweight in-process counters for optimizing free→paid conversion.
// Exported so /usage endpoint can expose them; never persisted to disk.
// Capped to known tool names to prevent unbounded key growth.
const KNOWN_TOOLS = new Set([
  'quick_check', 'explain_warning', 'session_summary', 'analyze_runtime',
  'get_recent_logs', 'get_network_activity', 'get_dom_context', 'clear_buffer', 'get_status',
]);
export const toolCallCounts: Record<string, number> = {};
function trackCall(tool: string): void {
  if (!KNOWN_TOOLS.has(tool)) return;
  toolCallCounts[tool] = (toolCallCounts[tool] ?? 0) + 1;
}

/** Visual credit bar, e.g. [████████░░] 80% */
function buildCreditBar(used: number, total: number): string {
  const pct = Math.min(1, used / total);
  const filled = Math.round(pct * 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${Math.round(pct * 100)}%`;
}

export function registerTools(server: McpServer): void {
  // ── get_recent_logs ──────────────────────────────────────────────────────────
  server.registerTool(
    'get_recent_logs',
    {
      description:
        'Returns recent browser console events (log/warn/error). ' +
        'Always lead with: total errors, total warnings, then the most critical issue first.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional()
          .describe('Max events to return (default 50)'),
        level: z.enum(['error', 'warn', 'log']).optional()
          .describe('Filter by log level'),
        since: z.number().int().optional()
          .describe('Only return events after this Unix timestamp in ms'),
      },
    },
    async ({ limit, level, since }) => {
      const events = store.getLogs(limit ?? 50, level as LogLevel | undefined, since);

      if (events.length === 0) {
        return { content: [{ type: 'text', text: 'No console events in buffer.' }] };
      }

      const errors = events.filter((e) => e.level === 'error').length;
      const warns = events.filter((e) => e.level === 'warn').length;
      const header =
        `Buffer: ${store.size()} total events. ` +
        `Showing ${events.length} — ${errors} error(s), ${warns} warning(s).\n\n`;

      const lines = events.map((e) => {
        const ts = new Date(e.timestamp).toISOString();
        const args = e.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        const stack = e.stack ? `\n  Stack: ${e.stack}` : '';
        return `[${ts}] [${e.level.toUpperCase()}] ${args}${stack}`;
      }).join('\n');

      return { content: [{ type: 'text', text: header + lines }] };
    },
  );

  // ── get_network_activity ─────────────────────────────────────────────────────
  server.registerTool(
    'get_network_activity',
    {
      description:
        'Returns intercepted fetch/XHR events. ' +
        '404 = missing asset or API call; 500 = critical server error.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional()
          .describe('Max events to return (default 50)'),
        status_filter: z.number().int().optional()
          .describe('Filter to a specific HTTP status code (e.g. 404, 500)'),
        since: z.number().int().optional()
          .describe('Only return events after this Unix timestamp in ms'),
      },
    },
    async ({ limit, status_filter, since }) => {
      const events = store.getNetwork(limit ?? 50, status_filter, since);

      if (events.length === 0) {
        const msg = status_filter
          ? `No network events with status ${status_filter}.`
          : 'No network events in buffer.';
        return { content: [{ type: 'text', text: msg }] };
      }

      const lines = events.map((e) => {
        const ts = new Date(e.timestamp).toISOString();
        const flag = e.status >= 500 ? ' [CRITICAL]' : e.status >= 400 ? ' [ERROR]' : '';
        const body = e.error
          ? ` | error: ${e.error}`
          : e.responseBody
            ? ` | response: ${JSON.stringify(e.responseBody).slice(0, 200)}`
            : '';
        return `[${ts}] ${e.method} ${e.url} → ${e.status} ${e.statusText} (${e.duration}ms)${flag}${body}`;
      }).join('\n');

      return { content: [{ type: 'text', text: lines }] };
    },
  );

  // ── get_dom_context ───────────────────────────────────────────────────────────
  server.registerTool(
    'get_dom_context',
    {
      description:
        'Returns DOM and storage snapshots captured at the exact millisecond of each console.error. ' +
        'Shows the page URL, title, focused element, React/Vue component, localStorage, and sessionStorage. ' +
        'Use this to understand what the user was doing and what state the app was in when an error fired.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional()
          .describe('Max snapshots to return (default 10)'),
        since: z.number().int().optional()
          .describe('Only return snapshots after this Unix timestamp in ms'),
      },
    },
    async ({ limit, since }) => {
      const snapshots = store.getContext(limit ?? 10, since);

      if (snapshots.length === 0) {
        return { content: [{ type: 'text', text: 'No context snapshots yet. They are captured automatically on every console.error.' }] };
      }

      const lines = snapshots.map((s) => {
        const ts = new Date(s.timestamp).toISOString();
        const parts: string[] = [
          `[${ts}] ${s.url}`,
          `  Page: ${s.title}`,
        ];
        if (s.activeElement) parts.push(`  Focused element: ${s.activeElement}`);
        if (s.component)     parts.push(`  Component: ${s.component}`);

        const lsEntries = Object.entries(s.localStorage);
        if (lsEntries.length > 0) {
          parts.push(`  localStorage (${lsEntries.length} keys):`);
          for (const [k, v] of lsEntries) parts.push(`    ${k} = ${v}`);
        }

        const ssEntries = Object.entries(s.sessionStorage);
        if (ssEntries.length > 0) {
          parts.push(`  sessionStorage (${ssEntries.length} keys):`);
          for (const [k, v] of ssEntries) parts.push(`    ${k} = ${v}`);
        }

        return parts.join('\n');
      });

      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    },
  );

  // ── clear_buffer ─────────────────────────────────────────────────────────────
  server.registerTool(
    'clear_buffer',
    { description: 'Clears all events from the in-memory buffer.' },
    async () => {
      const was = store.size();
      store.clear();
      return { content: [{ type: 'text', text: `Cleared ${was} event(s) from buffer.` }] };
    },
  );

  // ── get_status ────────────────────────────────────────────────────────────────
  server.registerTool(
    'get_status',
    {
      description:
        'Returns your current plan, credit usage, billing status, and next reset date. ' +
        'Use this to check how many analyze_runtime credits remain before calling that tool.',
    },
    async () => {
      const snap = getUsageSnapshot();
      const licState = getLicenseState();

      const lines: string[] = [
        `## Mergen Status`,
        ``,
        `**Plan:** ${snap.planName}`,
        `**Period:** ${snap.month}  |  **Resets:** ${new Date(snap.resetsAt).toUTCString()}`,
        ``,
      ];

      if (snap.included === null) {
        lines.push(`**Credits:** ${snap.used} used  (unlimited plan)`);
      } else {
        const bar = buildCreditBar(snap.used, snap.included);
        lines.push(`**Credits:** ${snap.used} / ${snap.included} used  ${bar}`);
        lines.push(`**Remaining:** ${snap.remaining}`);
        if (snap.lowCredits) {
          lines.push(`⚠ **Low credits** — only ${snap.remaining} call(s) left at no extra charge.`);
        }
      }

      if (snap.overage > 0) {
        const rate = `$${(snap.overageCentsPerCredit / 100).toFixed(2)}/call`;
        lines.push(``);
        lines.push(`**Overage:** ${snap.overage} call(s) × ${rate} = **$${(snap.estimatedOverageCents / 100).toFixed(2)}** estimated`);
        lines.push(`**Billing status:** ${snap.billingStatus === 'confirmed' ? '✅ confirmed' : '⏳ pending (will be sent to LemonSqueezy within 5 s)'}`);
      }

      if (snap.planId === 'free') {
        lines.push(``);
        lines.push(`> **Upgrade to unlock analyze_runtime:**`);
        for (const plan of Object.values(PLANS)) {
          if (plan.id === 'free') continue;
          const price = plan.priceUsdCents === 0 ? 'pay-as-you-go ($0.05/call)' : `$${(plan.priceUsdCents / 100).toFixed(0)}/mo`;
          const credits = plan.analyzeCreditsPerMonth === Infinity ? 'unlimited' : `${plan.analyzeCreditsPerMonth}/mo`;
          lines.push(`> - **${plan.name}** — ${price} — ${credits} credits`);
        }
        lines.push(`>`);
        lines.push(`> https://mergen.dev/pricing`);
      }

      if (licState?.customerEmail) {
        lines.push(``);
        lines.push(`**Account:** ${licState.customerEmail}  |  Last validated: ${licState.validatedAt?.slice(0, 10)}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── quick_check ──────────────────────────────────────────────────────────────
  // Free, no credit cost. Answers "is anything wrong right now?" in <1s.
  // Deliberately stops at WHAT — counts and pattern labels only.
  // WHY and the fix are gated behind analyze_runtime (paid).
  server.registerTool(
    'quick_check',
    {
      description:
        '⚡ FREE · No credit cost. Instant buffer pulse — use this constantly during development, ' +
        'not just when things break. Returns: error/warning/network counts, and any detected patterns ' +
        '(repeated failures, warning spikes, slow requests). ' +
        'Call this before writing code, after running the app, or whenever something feels off. ' +
        'For the root cause and a code fix, call analyze_runtime.',
    },
    async () => {
      trackCall('quick_check');
      const errors   = store.getLogs(200, 'error');
      const warns    = store.getLogs(200, 'warn');
      const network  = store.getNetwork(200);
      const signals  = store.getSignals();
      const netFails = network.filter((n) => n.status >= 400 || n.status === 0 || n.error);

      const lines: string[] = ['## ⚡ Quick Check'];
      lines.push('');

      // Counts only — no root cause, no fix (those are paid)
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
        lines.push('');
        lines.push('### 🔍 Detected patterns');
        lines.push('');
        for (const s of signals) {
          const confPct = Math.round(s.confidence * 100);
          lines.push(`**${confPct}%** — ${s.message}`);
          lines.push(`  → **Next step:** ${s.action}`);
          lines.push('');
        }
        lines.push('> 🔬 **Root cause + fix:** call `analyze_runtime`.');
      } else if (errors.length > 0) {
        lines.push('');
        lines.push(`> ❌ ${errors.length} error(s) in buffer. Call \`analyze_runtime\` for root cause + fix.`);
      } else if (warns.length > 0) {
        lines.push('');
        lines.push(`> ⚠️ ${warns.length} warning(s) in buffer. Call \`explain_warning\` to understand them before they escalate.`);
      } else {
        lines.push('');
        lines.push('> ✅ Buffer clean — no errors, warning spikes, or repeated failures.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── explain_warning ───────────────────────────────────────────────────────────
  // Free, no credit cost. Surfaces the most recent warning with context.
  // The "shift left" tool — use BEFORE things break, not after.
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

      // Most recent warning first
      const latest = warns[warns.length - 1];
      const message = latest.args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ').slice(0, 500);

      // Gather a little context: any network calls around the same time?
      const windowMs = 5_000;
      const nearbyNetwork = store.getNetwork(200).filter(
        (n) => Math.abs(n.timestamp - latest.timestamp) < windowMs,
      );
      const nearbyErrors = store.getLogs(200, 'error').filter(
        (e) => e.timestamp > latest.timestamp,
      );

      const lines: string[] = [
        '## ⚠️ Warning Explanation',
        '',
        `**Message:** \`${message}\``,
        `**When:** ${new Date(latest.timestamp).toISOString()}`,
        `**URL:** ${latest.url}`,
      ];

      if (latest.stack) {
        lines.push('');
        lines.push('<details><summary>📋 Stack trace</summary>');
        lines.push('');
        lines.push('```');
        lines.push(latest.stack.slice(0, 1000));
        lines.push('```');
        lines.push('</details>');
      }

      if (nearbyNetwork.length > 0) {
        lines.push('');
        lines.push('**Nearby network activity (±5s):**');
        for (const n of nearbyNetwork.slice(0, 3)) {
          const badge = n.status >= 400 || n.status === 0 ? '❌' : '✅';
          lines.push(`- ${badge} \`${n.method} ${n.url}\` → ${n.status} (${n.duration}ms)`);
        }
      }

      if (nearbyErrors.length > 0) {
        lines.push('');
        lines.push(`> ⚠️ **${nearbyErrors.length} error(s) fired AFTER this warning** — this warning may have been a precursor.`);
        lines.push('> Call **`analyze_runtime`** for a full causal chain.');
      }

      if (warns.length > 1) {
        lines.push('');
        lines.push(`*${warns.length - 1} other warning(s) in buffer — showing most recent only.*`);
      }

      lines.push('');
      lines.push('---');
      lines.push('**Your task:** Explain what this warning means, why it could cause a crash, and the minimal fix.');

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── session_summary ───────────────────────────────────────────────────────────
  // Free, no credit cost. "What happened during this session?"
  // Designed for end-of-session review or when picking up after a break.
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
      const logs     = store.getLogs(200, undefined, since);
      const network  = store.getNetwork(200, undefined, since);
      const signals  = store.getSignals();

      const errors    = logs.filter((e) => e.level === 'error');
      const warns     = logs.filter((e) => e.level === 'warn');
      const netFails  = network.filter((n) => n.status >= 400 || n.status === 0 || n.error);
      const slowReqs  = network.filter((n) => n.duration > 2000);

      const lines: string[] = ['## 📊 Session Summary'];
      lines.push('');
      lines.push('| Metric | Value |');
      lines.push('|---|---|');
      lines.push(`| Console errors     | ${errors.length} |`);
      lines.push(`| Warnings           | ${warns.length} |`);
      lines.push(`| Network failures   | ${netFails.length} |`);
      lines.push(`| Slow requests (>2s)| ${slowReqs.length} |`);
      lines.push(`| Total events       | ${store.size()} |`);
      lines.push('');

      if (errors.length > 0) {
        // Deduplicate errors by first line of message
        const seen = new Map<string, number>();
        for (const e of errors) {
          const msg = e.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').split('\n')[0].slice(0, 100);
          seen.set(msg, (seen.get(msg) ?? 0) + 1);
        }
        lines.push('### ❌ Errors');
        lines.push('');
        for (const [msg, count] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
          lines.push(`- ${count > 1 ? `**(×${count})**` : ''} \`${msg}\``);
        }
        lines.push('');
      }

      if (netFails.length > 0) {
        lines.push('### 🌐 Failing endpoints');
        lines.push('');
        const seen = new Map<string, { count: number; status: number }>();
        for (const n of netFails) {
          const key = `${n.method} ${n.url}`;
          const prev = seen.get(key);
          seen.set(key, { count: (prev?.count ?? 0) + 1, status: n.status });
        }
        for (const [endpoint, { count, status }] of [...seen.entries()].sort((a, b) => b[1].count - a[1].count)) {
          lines.push(`- ${count > 1 ? `**(×${count})**` : ''} \`${endpoint}\` → ${status || 'NET_ERR'}`);
        }
        lines.push('');
      }

      if (signals.length > 0) {
        lines.push('### 🔍 Patterns detected');
        lines.push('');
        for (const s of signals) {
          lines.push(`- ${s.message}`);
          lines.push(`  → **${s.action}**`);
        }
        lines.push('');
      }

      if (errors.length > 0 || signals.length > 0) {
        lines.push('> 💡 Call **`analyze_runtime`** for root cause analysis and a fix suggestion.');
      } else {
        lines.push('> ✅ Session looks clean — no significant errors or patterns detected.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── analyze_runtime ───────────────────────────────────────────────────────────
  // Premium tool: consumes one credit per call.
  // Free plan → blocked with upgrade prompt.
  // Solo Standard → 500 credits/mo included, $0.05/call after.
  // Solo Pro + Team → unlimited.
  server.registerTool(
    'analyze_runtime',
    {
      description:
        '🔬 ROUTINE DEBUGGING — Call this as part of your normal debugging workflow, not just when things break. ' +
        'Reconstructs what happened in the browser: resolves stack frames to original source (with code snippets), ' +
        'tracks event dependencies (request → response → state mutation → crash), and produces a structured diagnosis ' +
        'with a single root-cause summary, causal path, and fix hint. ' +
        'Use it whenever the user asks why something is wrong, why a component is behaving unexpectedly, ' +
        'or what happened before an error. ' +
        'Costs 1 credit per call. Free plan: unavailable. Solo Standard: 500/mo. Solo Pro/Team: unlimited.',
      inputSchema: {
        focus: z.enum(['errors', 'network', 'all']).optional()
          .describe('Limit analysis scope (default: all)'),
        since: z.number().int().optional()
          .describe('Only analyze events after this Unix timestamp in ms'),
      },
    },
    async ({ focus = 'all', since }) => {
      trackCall('analyze_runtime');
      // ── Credit gate ────────────────────────────────────────────────────────
      const credit = await consumeCredit();
      if (!credit.allowed) {
        // Pain #1 — actionable message with plan names and prices
        const upgradeOptions = Object.values(PLANS)
          .filter(p => p.id !== 'free' && p.analyzeCreditsPerMonth > 0)
          .map(p => {
            const price = p.priceUsdCents === 0 ? '$0.05/call' : `$${(p.priceUsdCents / 100).toFixed(0)}/mo`;
            const credits = p.analyzeCreditsPerMonth === Infinity ? 'unlimited' : `${p.analyzeCreditsPerMonth}/mo`;
            return `  • ${p.name} — ${price} — ${credits} analyze_runtime credits`;
          })
          .join('\n');

        return {
          content: [{
            type: 'text',
            text:
              `⛔ analyze_runtime is not available on the **${getPlan(getActivePlanId()).name}** plan.\n\n` +
              `**Upgrade options:**\n${upgradeOptions}\n\n` +
              `→ https://mergen.dev/pricing`,
          }],
          isError: true,
        };
      }

      // ── Gather raw telemetry ───────────────────────────────────────────────
      const logs     = focus === 'network' ? [] : store.getLogs(200, undefined, since);
      const network  = focus === 'errors'  ? [] : store.getNetwork(200, undefined, since);
      const contexts = store.getContext(20, since);

      // ── Build causal chain + context pack ──────────────────────────────────
      const causal = await buildCausalChain(logs, network, contexts, since);

      // Append usage footer + any one-time notice (low credits, first overage)
      const usage = getUsageSnapshot();
      const usageFooter = usage.included === null
        ? `\n\n---\n*Credits used this month: ${usage.used} (unlimited plan)*`
        : `\n\n---\n*Credits: ${usage.used} / ${usage.included} used` +
          (usage.overage > 0 ? ` · ${usage.overage} overage ($${(usage.estimatedOverageCents / 100).toFixed(2)} est.)` : '') +
          ` · resets ${new Date(usage.resetsAt).toUTCString()}*`;

      const noticeBlock = credit.notice ? `\n\n> ${credit.notice}` : '';

      return {
        content: [{ type: 'text', text: causal.contextPack + noticeBlock + usageFooter }],
      };
    },
  );
}
