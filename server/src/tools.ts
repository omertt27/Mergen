import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store, LogLevel } from './buffer.js';
import { consumeCredit, getUsageSnapshot } from './usage.js';
import { getActivePlanId, getLicenseState } from './license.js';
import { getPlan } from './plans.js';

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

  // ── analyze_runtime ───────────────────────────────────────────────────────────
  // Premium tool: consumes one credit per call.
  // Free plan → blocked with upgrade prompt.
  // Solo Standard → 500 credits/mo included, $0.05/call after.
  // Solo Pro + Team → unlimited.
  server.registerTool(
    'analyze_runtime',
    {
      description:
        '🔬 PREMIUM — Deep analysis of current browser telemetry. ' +
        'Identifies root causes, correlates console errors with network failures, ' +
        'and proposes a concrete fix. Costs 1 credit per call. ' +
        'Free plan: not available. Solo Standard: 500/mo. Solo Pro/Team: unlimited.',
      inputSchema: {
        focus: z.enum(['errors', 'network', 'all']).optional()
          .describe('What to focus the analysis on (default: all)'),
        since: z.number().int().optional()
          .describe('Only analyze events after this Unix timestamp in ms'),
      },
    },
    async ({ focus = 'all', since }) => {
      // ── Credit gate ────────────────────────────────────────────────────────
      const credit = await consumeCredit();
      if (!credit.allowed) {
        const ls = getLicenseState();
        const upgradeUrl = 'https://mergen.dev/pricing';
        return {
          content: [{
            type: 'text',
            text:
              `⛔ ${credit.reason}\n\n` +
              `Current plan: ${getPlan(getActivePlanId()).name}\n` +
              `Upgrade at: ${upgradeUrl}`,
          }],
          isError: true,
        };
      }

      // ── Gather telemetry ───────────────────────────────────────────────────
      const logs     = (focus === 'network') ? [] : store.getLogs(200, undefined, since);
      const network  = (focus === 'errors')  ? [] : store.getNetwork(200, undefined, since);
      const contexts = store.getContext(10, since);

      const errors   = logs.filter((e) => e.level === 'error');
      const warns    = logs.filter((e) => e.level === 'warn');
      const netFails = network.filter((e) => e.status >= 400 || e.status === 0);

      const usage = getUsageSnapshot();
      const usageLine = usage.included === null
        ? `Credits used this month: ${usage.used} (unlimited plan)`
        : `Credits used this month: ${usage.used} / ${usage.included}`;

      // ── Build structured prompt for the AI ────────────────────────────────
      // The MCP client (Claude / Cursor) will receive this as tool output and
      // reason over it. We structure it so the AI has everything it needs to
      // produce a root-cause analysis and diff.
      const sections: string[] = [
        `# Mergen Runtime Analysis — ${new Date().toISOString()}`,
        `${usageLine}\n`,
      ];

      if (errors.length > 0) {
        sections.push(`## Console Errors (${errors.length})`);
        sections.push(errors.map((e) => {
          const args = e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
          const stack = e.stack ? `\n${e.stack}` : '';
          return `- [${new Date(e.timestamp).toISOString()}] ${args}${stack}`;
        }).join('\n'));
      }

      if (warns.length > 0) {
        sections.push(`## Console Warnings (${warns.length})`);
        sections.push(warns.map((e) =>
          `- ${e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`
        ).join('\n'));
      }

      if (netFails.length > 0) {
        sections.push(`## Failed Network Requests (${netFails.length})`);
        sections.push(netFails.map((e) => {
          const body = e.error ? ` | ${e.error}` : e.responseBody
            ? ` | ${JSON.stringify(e.responseBody).slice(0, 300)}` : '';
          return `- ${e.method} ${e.url} → ${e.status} ${e.statusText}${body}`;
        }).join('\n'));
      }

      if (contexts.length > 0) {
        sections.push(`## DOM & Storage Context at Error Time (${contexts.length} snapshot(s))`);
        sections.push(contexts.map((s) => {
          const parts = [`- [${new Date(s.timestamp).toISOString()}] ${s.url} | Page: "${s.title}"`];
          if (s.activeElement) parts.push(`  Focused: ${s.activeElement}`);
          if (s.component)     parts.push(`  Component: ${s.component}`);
          const ls = Object.entries(s.localStorage);
          if (ls.length > 0) parts.push(`  localStorage: ${ls.map(([k, v]) => `${k}=${v}`).join(', ')}`);
          const ss = Object.entries(s.sessionStorage);
          if (ss.length > 0) parts.push(`  sessionStorage: ${ss.map(([k, v]) => `${k}=${v}`).join(', ')}`);
          return parts.join('\n');
        }).join('\n'));
      }

      if (errors.length === 0 && warns.length === 0 && netFails.length === 0) {
        sections.push('✅ No errors, warnings, or failed network requests detected.');
      }

      sections.push(
        '\n---',
        'Using the telemetry above:',
        '1. Identify the root cause(s).',
        '2. Correlate any console errors with network failures if related.',
        '3. Propose a concrete fix (code diff if possible).',
        '4. Flag anything that needs immediate attention.',
      );

      return { content: [{ type: 'text', text: sections.join('\n\n') }] };
    },
  );
}
