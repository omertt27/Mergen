import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store, LogLevel } from './buffer.js';
import { consumeCredit, getUsageSnapshot } from './usage.js';
import { getActivePlanId, getLicenseState } from './license.js';
import { getPlan, PLANS } from './plans.js';
import { buildCausalChain } from './causal.js';

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

  // ── analyze_runtime ───────────────────────────────────────────────────────────
  // Premium tool: consumes one credit per call.
  // Free plan → blocked with upgrade prompt.
  // Solo Standard → 500 credits/mo included, $0.05/call after.
  // Solo Pro + Team → unlimited.
  server.registerTool(
    'analyze_runtime',
    {
      description:
        '🔬 PREMIUM — Reconstructs the causal chain that led to the current runtime error. ' +
        'Resolves stack frames to original source (with code snippets), correlates console errors ' +
        'with network failures and DOM state at the exact moment of crash, and produces a ' +
        'structured Context Pack for precise root-cause diagnosis. ' +
        'Costs 1 credit per call. Free plan: unavailable. Solo Standard: 500/mo. Solo Pro/Team: unlimited.',
      inputSchema: {
        focus: z.enum(['errors', 'network', 'all']).optional()
          .describe('Limit analysis scope (default: all)'),
        since: z.number().int().optional()
          .describe('Only analyze events after this Unix timestamp in ms'),
      },
    },
    async ({ focus = 'all', since }) => {
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
