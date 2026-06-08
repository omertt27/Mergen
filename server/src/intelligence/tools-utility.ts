import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store } from '../sensor/buffer.js';
import { getUsageSnapshot } from './usage.js';
import { getLicenseState } from './license.js';
import { layer3Store } from '../sensor/layer3-store.js';
import { trackCall, buildCreditBar, setLastClearAt } from './tools-state.js';
import { saveSessionToHistory } from '../sensor/session-history.js';

export function registerUtilityTools(server: McpServer): void {
  // ── get_status ─────────────────────────────────────────────────────────────
  server.registerTool(
    'get_status',
    {
      description:
        'Returns your current plan, credit usage, billing status, and next reset date. ' +
        'Use this to check how many incidents remain this month before calling that tool.',
    },
    async () => {
      const snap     = getUsageSnapshot();
      const licState = getLicenseState();

      const lines: string[] = [
        `## Mergen Status`, '',
        `**Plan:** ${snap.planName}`,
        `**Period:** ${snap.month}  |  **Resets:** ${new Date(snap.resetsAt).toUTCString()}`,
        '',
      ];

      if (snap.included === null) {
        lines.push(`**Credits:** ${snap.used} used  (unlimited plan)`);
      } else {
        const bar = buildCreditBar(snap.used, snap.included);
        lines.push(`**Credits:** ${snap.used} / ${snap.included} used  ${bar}`);
        lines.push(`**Remaining:** ${snap.remaining}`);
        if (snap.lowCredits)
          lines.push(`⚠ **Low credits** — only ${snap.remaining} call(s) left at no extra charge.`);
      }

      if (snap.overage > 0) {
        const rate = `$${(snap.overageCentsPerCredit / 100).toFixed(2)}/call`;
        lines.push('',
          `**Overage:** ${snap.overage} call(s) × ${rate} = **$${(snap.estimatedOverageCents / 100).toFixed(2)}** estimated`,
          `**Billing status:** ${snap.billingStatus === 'confirmed' ? '✅ confirmed' : '⏳ pending (will be sent to LemonSqueezy within 5 s)'}`,
        );
      }

      if (snap.planId === 'free') {
        lines.push('',
          '> **Upgrade to Pro ($29/mo)** — 200 incidents/month, $50 overage ceiling, autopilot execution, auto-rollback.',
          '> https://mergen.dev/pricing',
        );
      }

      if (licState?.customerEmail) {
        lines.push('', `**Account:** ${licState.customerEmail}  |  Last validated: ${licState.validatedAt?.slice(0, 10)}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── clear_buffer ───────────────────────────────────────────────────────────
  server.registerTool(
    'clear_buffer',
    { description: 'Clears all events from the in-memory buffer. The current session is archived to disk before clearing so it can be replayed later via get_session_replay.' },
    async () => {
      const events = store.serialize();
      saveSessionToHistory(events, 'mcp-clear');
      const was = store.size();
      store.clear();
      setLastClearAt(Date.now());
      return { content: [{ type: 'text', text: `Cleared ${was} event(s) from buffer. Session archived to history.` }] };
    },
  );

  // ── mark_capture_start ─────────────────────────────────────────────────────
  server.registerTool(
    'mark_capture_start',
    {
      description:
        'Records the current timestamp as a capture-start point for this debug session. ' +
        'Call this BEFORE the user reproduces a bug. Then pass the returned `since` value to ' +
        'get_recent_logs and get_network_activity to see only what happened during reproduction. ' +
        'Workflow: (1) mark_capture_start → get timestamp T; (2) user reproduces bug; ' +
        '(3) get_recent_logs(since: T) + get_network_activity(since: T).',
      inputSchema: {},
    },
    async () => {
      const ts  = Date.now();
      const iso = new Date(ts).toISOString();
      return {
        content: [{
          type: 'text',
          text:
            `Capture started at ${iso} (since: ${ts}).\n\n` +
            `Now ask the user to reproduce the bug, then call:\n` +
            `  get_recent_logs(since: ${ts})\n` +
            `  get_network_activity(since: ${ts})`,
        }],
      };
    },
  );

  // ── export_session ─────────────────────────────────────────────────────────
  server.registerTool(
    'export_session',
    {
      description:
        'Exports the current session — all buffered events, signals, and the latest analysis — ' +
        'as a structured JSON file in the current working directory. ' +
        'Use this to share a bug context with teammates or attach to a GitHub issue. ' +
        'Returns the file path and a human-readable summary.',
      inputSchema: {
        label: z.string().optional()
          .describe('Optional filename label (default: session-<ISO timestamp>)'),
      },
    },
    async ({ label }) => {
      const { writeFileSync } = await import('fs');
      const { resolve }       = await import('path');

      const ts      = Date.now();
      const name    = label ?? `session-${new Date(ts).toISOString().slice(0, 19).replace(/:/g, '-')}`;
      const outPath = resolve(process.cwd(), `${name}.mergen-report.json`);

      const logs        = store.getLogs(200);
      const network     = store.getNetwork(200);
      const context     = store.getContext(20);
      const testResults = store.getTestResults(50);
      const diagnostics = store.getDiagnostics(50);
      const signals     = store.getSignals();

      const report = {
        exported_at: new Date(ts).toISOString(),
        label: name,
        summary: {
          total_events: store.size(),
          logs: logs.length,
          network_events: network.length,
          errors: logs.filter((l) => l.level === 'error').length,
          warnings: logs.filter((l) => l.level === 'warn').length,
          network_errors: network.filter((n) => n.status >= 400 || n.status === 0).length,
          signals: signals.length,
          test_failures: testResults.filter((t) => t.status === 'fail').length,
        },
        signals,
        logs,
        network,
        context,
        test_results: testResults,
        diagnostics,
      };

      writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

      const s = report.summary;
      return {
        content: [{
          type: 'text',
          text: [
            `## Session Exported`, '',
            `**File:** \`${outPath}\``, '',
            `**Summary:**`,
            `- ${s.logs} log events (${s.errors} errors, ${s.warnings} warnings)`,
            `- ${s.network_events} network events (${s.network_errors} failures)`,
            `- ${s.signals} active signals`,
            `- ${s.test_failures} test failure(s)`, '',
            `Share with your team: \`cat ${outPath} | pbcopy\``,
          ].join('\n'),
        }],
      };
    },
  );

  // ── get_diagnostics ────────────────────────────────────────────────────────
  server.registerTool(
    'get_diagnostics',
    {
      description:
        'Returns recent editor diagnostic events (TypeScript/ESLint errors and warnings) ' +
        'captured from VS Code. Use this to correlate compile-time errors with runtime crashes.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Max events (default 50)'),
        severity: z.enum(['error', 'warning', 'info', 'hint']).optional().describe('Filter by severity'),
        since: z.number().int().optional().describe('Only return events after this Unix ms timestamp'),
      },
    },
    async ({ limit = 50, severity, since }) => {
      trackCall('get_diagnostics');
      const events = store.getDiagnostics(limit, severity, since);

      if (events.length === 0) {
        return { content: [{ type: 'text', text: 'No editor diagnostics captured yet. Make sure the VS Code extension is installed and the Mergen server is running.' }] };
      }

      const lines = [`## Editor Diagnostics (${events.length} events)`, ''];
      for (const e of events) {
        const icon = e.severity === 'error' ? '🔴' : e.severity === 'warning' ? '🟡' : '🔵';
        lines.push(`${icon} **${e.severity.toUpperCase()}** \`${e.file}:${e.line}:${e.column}\``);
        lines.push(`   ${e.source ? `[${e.source}] ` : ''}${e.message}${e.code ? ` (${e.code})` : ''}`);
        lines.push(`   _${new Date(e.timestamp).toISOString()}_`, '');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── get_test_results ───────────────────────────────────────────────────────
  server.registerTool(
    'get_test_results',
    {
      description:
        'Returns recent test results streamed from Vitest/Jest reporters. ' +
        'Shows failing tests with error messages and stack traces.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Max events (default 50)'),
        status: z.enum(['pass', 'fail', 'skip', 'todo']).optional().describe('Filter by test status'),
        since: z.number().int().optional().describe('Only return events after this Unix ms timestamp'),
      },
    },
    async ({ limit = 50, status, since }) => {
      trackCall('get_test_results');
      const events = store.getTestResults(limit, status, since);

      if (events.length === 0) {
        return { content: [{ type: 'text', text: 'No test results captured yet. Add the Mergen reporter to your vitest.config.ts or jest.config.js.' }] };
      }

      const byStatus = { pass: 0, fail: 0, skip: 0, todo: 0 };
      for (const e of events) byStatus[e.status]++;

      const lines = [
        `## Test Results (${events.length} tests)`,
        `✅ ${byStatus.pass} passed · ❌ ${byStatus.fail} failed · ⏭ ${byStatus.skip} skipped`,
        '',
      ];
      const failing = events.filter((e) => e.status === 'fail');
      if (failing.length > 0) {
        lines.push('### Failing tests:', '');
        for (const e of failing) {
          lines.push(`❌ **${e.name}**`, `   File: \`${e.file}\``);
          if (e.error) {
            lines.push(`   Error: ${e.error.message}`);
            if (e.error.stack) lines.push(`   \`\`\`\n   ${e.error.stack.slice(0, 500)}\n   \`\`\``);
          }
          lines.push('');
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── create_ticket ──────────────────────────────────────────────────────────
  server.registerTool(
    'create_ticket',
    {
      description:
        'Creates a pre-filled bug ticket in Linear or Jira from the current hypothesis. ' +
        'Auto-fills: title (hypothesis summary), description, reproduction steps, affected SHA, CODEOWNERS, and a link to the Mergen dashboard. ' +
        'Requires LINEAR_API_KEY + LINEAR_TEAM_ID or JIRA_BASE_URL + JIRA_API_TOKEN + JIRA_EMAIL + JIRA_PROJECT_KEY env vars.',
      inputSchema: {
        provider: z.enum(['linear', 'jira']).describe('Ticket system to create in'),
        pid: z.string().optional().describe('Hypothesis pid to use (defaults to current top hypothesis)'),
      },
    },
    async ({ provider, pid }) => {
      trackCall('create_ticket');
      const port = process.env.PORT ?? '3000';

      try {
        const { default: http } = await import('http');
        const body = JSON.stringify({ pid });
        const resp = await new Promise<string>((resolve, reject) => {
          const req = http.request(
            { hostname: '127.0.0.1', port: Number(port), path: `/tickets/${provider}`, method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            (res) => { let d = ''; res.on('data', (c: Buffer) => { d += c; }); res.on('end', () => resolve(d)); },
          );
          req.on('error', reject);
          req.write(body);
          req.end();
        });

        const parsed = JSON.parse(resp) as { ok?: boolean; url?: string; id?: string; key?: string; error?: string };
        if (!parsed.ok) {
          return { content: [{ type: 'text', text: `Failed to create ${provider} ticket: ${parsed.error ?? 'unknown error'}` }] };
        }
        return {
          content: [{
            type: 'text',
            text: `✅ ${provider === 'linear' ? 'Linear' : 'Jira'} ticket created!\n\nURL: ${parsed.url}\nID: ${parsed.id ?? parsed.key}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error creating ticket: ${err instanceof Error ? err.message : String(err)}\n\nMake sure the Mergen server is running and the API keys are configured.` }] };
      }
    },
  );

  // ── get_snapshots ──────────────────────────────────────────────────────────
  server.registerTool(
    'get_snapshots',
    {
      description:
        'Returns diagnostic snapshots captured when a breakpoint was hit. ' +
        'Each snapshot bundles the triggering event with the 20 most recent console events, ' +
        '10 most recent network events, and the latest DOM/storage context snapshot. ' +
        'Download a full snapshot bundle via GET /snapshots/:id. ' +
        'Use after set_breakpoint fires to replay the exact state offline.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Max snapshots to return (default 10)'),
      },
    },
    async ({ limit }) => {
      trackCall('get_snapshots');
      const snaps = layer3Store.listSnapshots().slice(0, limit ?? 10);
      if (snaps.length === 0) {
        return { content: [{ type: 'text', text: 'No snapshots captured yet. Set a breakpoint with set_breakpoint, then trigger the condition in your browser.' }] };
      }

      const lines = snaps.map(s => {
        const ts         = new Date(s.capturedAt).toISOString();
        const errSummary = s.recentLogs.filter(e => e.level === 'error').length;
        const netFails   = s.recentNetwork.filter(n => n.status >= 400 || n.status === 0).length;
        return [
          `Snapshot ${s.id} @ ${ts}`,
          `  Trigger: [${s.trigger.eventType}] ${s.trigger.summary}`,
          `  Breakpoint: ${s.trigger.breakpointId}`,
          `  Context: ${s.recentLogs.length} logs (${errSummary} errors), ${s.recentNetwork.length} network (${netFails} failures)`,
          `  Stack: ${s.stack ? s.stack.split('\n')[0] : 'none'}`,
          `  Download: GET /snapshots/${s.id}`,
        ].join('\n');
      });

      return { content: [{ type: 'text', text: `${snaps.length} snapshot(s):\n\n${lines.join('\n\n')}` }] };
    },
  );

  // ── inject_logpoint ────────────────────────────────────────────────────────
  server.registerTool(
    'inject_logpoint',
    {
      description:
        'Injects a temporary log statement into the running browser page without restarting or redeploying. ' +
        'The logpoint attaches to a DOM element and fires on a given event, evaluating a JS expression. ' +
        'Results stream back via the ingest pipeline as console events. ' +
        'Use to add ad-hoc diagnostics to production-like sessions without modifying source code.',
      inputSchema: {
        selector:   z.string().describe('CSS selector of the element to attach to (e.g. "#login-btn", "form.checkout")'),
        event:      z.string().describe('DOM event to listen for (e.g. "click", "submit", "change")'),
        expression: z.string().describe('JS expression to evaluate and log when the event fires (e.g. "document.querySelector(\'input[name=email]\').value")'),
      },
    },
    async ({ selector, event, expression }) => {
      trackCall('inject_logpoint');
      const id = layer3Store.injectLog(selector, event, expression);
      return { content: [{ type: 'text', text: `Logpoint injected (id: ${id}).\nWaiting for "${event}" on "${selector}".\nExpression: ${expression}\nResults will appear in get_recent_logs within seconds of the event firing.` }] };
    },
  );

  // ── remove_logpoint ────────────────────────────────────────────────────────
  server.registerTool(
    'remove_logpoint',
    {
      description: 'Removes a previously injected logpoint by its id.',
      inputSchema: {
        id: z.string().describe('Logpoint id returned by inject_logpoint'),
      },
    },
    async ({ id }) => {
      trackCall('remove_logpoint');
      const removed = layer3Store.removeInjectedLog(id);
      return { content: [{ type: 'text', text: removed ? `Logpoint ${id} removed.` : `Logpoint ${id} not found (may have already fired and auto-removed).` }] };
    },
  );

}
