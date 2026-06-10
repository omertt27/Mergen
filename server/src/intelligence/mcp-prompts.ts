/**
 * mcp-prompts.ts — MCP Prompt primitives for Mergen.
 *
 * Prompts are pre-filled message templates that wire live telemetry directly
 * into a structured debugging question. They give AI clients a guided entry
 * point for the most common debugging workflows — no manual copy-paste needed.
 *
 * Registered prompts:
 *   debug                 — UNIVERSAL: one prompt that handles any active error (use this first)
 *   debug_auth_failure    — diagnose broken login / token storage
 *   debug_network_error   — diagnose a failing API request
 *   debug_page_error      — diagnose the most recent JavaScript crash
 *   summarize_session     — summarize what happened in this session
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store } from '../sensor/buffer.js';
import { hypothesisHistory } from './hypothesis-history.js';

export function registerPrompts(server: McpServer): void {
  // ── debug — universal entry point, works for any active error ────────────────
  // This is the prompt enterprise developers will muscle-memorise.
  // Typing "/debug" in any MCP-enabled AI chat pre-fills the full causal context:
  //   - current error/warning/network counts
  //   - top hypothesis (if one exists with confidence >= 45%)
  //   - the most recent errors and failing network calls
  //   - explicit instructions to call analyze_runtime for the root cause
  //
  // Design contract: always produce an actionable message even when the buffer
  // is empty (guide the developer to capture events first).
  server.registerPrompt(
    'debug',
    {
      description:
        'Universal debugging prompt — use this when something is broken. ' +
        'Pre-fills the AI with your live browser telemetry so you skip the copy-paste step. ' +
        'Works for any error type: JavaScript crashes, auth failures, network errors, performance issues.',
      argsSchema: {
        focus: z.enum(['errors', 'network', 'auth', 'all']).optional()
          .describe('Narrow the focus (default: all). Use "auth" for login issues, "network" for API failures.'),
      },
    },
    async ({ focus = 'all' }) => {
      const errors   = store.getLogs(10, 'error');
      const warns    = store.getLogs(5,  'warn');
      const network  = store.getNetwork(10);
      const netFails = network.filter(n => n.status >= 400 || n.status === 0 || !!n.error);
      const contexts = store.getContext(3);
      const signals  = store.getSignals();
      const latest   = hypothesisHistory.latest();
      const topHyp   = latest?.topHypothesis ?? null;

      const total = errors.length + netFails.length;

      // ── Buffer empty — guide the developer ──────────────────────────────────
      if (total === 0 && warns.length === 0) {
        return {
          messages: [{
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                'I want to debug my app with Mergen, but the buffer is currently empty.',
                '',
                'Steps to capture events:',
                '1. Make sure the Mergen Chrome extension is active on this tab (check the toolbar — icon should be lit, not greyed out)',
                '   Alternative: add `<script src="http://localhost:3000/sdk.js"></script>` to your page HTML',
                '2. Reproduce the issue in your browser',
                '3. Come back and ask me again',
                '',
                'Or run: `npx mergen-server demo` for an instant demo.',
                '',
                'Once events are captured, call `quick_check` to see what\'s in the buffer.',
              ].join('\n'),
            },
          }],
        };
      }

      // ── Build context snapshot ───────────────────────────────────────────────
      const lines: string[] = [];

      // Prior hypothesis — if confident, lead with it
      if (topHyp && topHyp.confidenceScore >= 0.45) {
        const pct = Math.round(topHyp.confidenceScore * 100);
        lines.push(`## Prior hypothesis (${pct}% confidence)`);
        lines.push(`**${topHyp.summary}**`);
        if (topHyp.fixHint) lines.push(`Fix hint: ${topHyp.fixHint}`);
        lines.push('');
      }

      // Signal summary
      lines.push(`## Live buffer state`);
      lines.push(`- Console errors: ${errors.length}`);
      lines.push(`- Warnings: ${warns.length}`);
      lines.push(`- Network failures: ${netFails.length}`);
      if (signals.length > 0) {
        lines.push(`- Detected patterns: ${signals.map(s => s.message).join('; ')}`);
      }
      lines.push('');

      // Errors
      if ((focus === 'all' || focus === 'errors') && errors.length > 0) {
        lines.push('## Recent console errors');
        for (const e of errors.slice(0, 5)) {
          const msg = e.args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 200);
          lines.push(`- [${new Date(e.timestamp).toISOString()}] ${msg}`);
          if (e.stack) lines.push(`  Stack: ${e.stack.split('\n')[0]}`);
        }
        lines.push('');
      }

      // Network failures
      if ((focus === 'all' || focus === 'network' || focus === 'auth') && netFails.length > 0) {
        lines.push('## Failing network requests');
        for (const n of netFails.slice(0, 5)) {
          const traceNote = n.traceId ? ` [traceId: ${n.traceId.slice(0, 8)}…]` : '';
          lines.push(`- ${n.method} ${n.url} → ${n.status || 'ERR'} (${n.duration}ms)${traceNote}`);
          if (n.error) lines.push(`  Error: ${n.error}`);
        }
        lines.push('');
      }

      // Auth-specific: localStorage state
      if ((focus === 'auth' || focus === 'all') && contexts.length > 0) {
        const ctx = contexts[contexts.length - 1];
        const authKeys = Object.entries(ctx.localStorage)
          .filter(([k]) => /token|auth|session|jwt|user/i.test(k));
        if (authKeys.length > 0) {
          lines.push('## Auth-related localStorage');
          for (const [k, v] of authKeys) lines.push(`- ${k}: ${v.slice(0, 100)}`);
          lines.push('');
        }
      }

      lines.push('## Task');
      lines.push(
        'Call `reconstruct_context` to get the root cause with source-mapped stack frames and a fix. ' +
        'If there are network failures with traceIds, call `get_unified_timeline` first — ' +
        '`EXACT` joins mean the browser request and backend log share the same trace ID (deterministic, not a guess). ' +
        'Lead your response with: what broke, why, and the exact code change needed.'
      );

      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: lines.join('\n') },
        }],
      };
    },
  );

  // ── debug_auth_failure ───────────────────────────────────────────────────────
  server.registerPrompt(
    'debug_auth_failure',
    {
      description:
        'Diagnose why login or authentication is broken. ' +
        'Use when users cannot sign in, tokens are missing after login, ' +
        'or auth endpoints are returning 4xx/5xx. ' +
        'Injects live error logs, auth network calls, and localStorage state.',
    },
    async () => {
      const errors = store.getLogs(10, 'error');
      const authNetwork = store.getNetwork(10).filter(
        (e) => /login|auth|signin|token|session/i.test(e.url),
      );
      const contexts = store.getContext(3);
      const storage = contexts.length > 0 ? contexts[contexts.length - 1].localStorage : {};
      const telemetry = { errors, authNetwork, localStorage: storage };

      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Authentication is broken in my app. Here is the live browser telemetry:\n\n' +
              JSON.stringify(telemetry, null, 2) +
              '\n\nDiagnose:\n' +
              '1. Which auth endpoint is failing and the HTTP status/error\n' +
              '2. Whether the token is being stored in localStorage after a successful response\n' +
              '3. The exact code fix (before/after diff)',
          },
        }],
      };
    },
  );

  // ── debug_network_error ──────────────────────────────────────────────────────
  server.registerPrompt(
    'debug_network_error',
    {
      description:
        'Diagnose a failing network request. ' +
        'Use when a specific API call returns 4xx/5xx or a network error. ' +
        'Optionally filter to a specific URL pattern.',
      argsSchema: {
        url_pattern: z.string().optional()
          .describe('URL substring to focus on, e.g. /api/users or checkout'),
      },
    },
    async ({ url_pattern }) => {
      let failed = store.getNetwork(20).filter(
        (e) => e.status >= 400 || e.status === 0 || !!e.error,
      );
      if (url_pattern) failed = failed.filter((e) => e.url.includes(url_pattern));

      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'A network request is failing. Failed requests from the live buffer:\n\n' +
              JSON.stringify(failed, null, 2) +
              '\n\nDiagnose:\n' +
              '1. Root cause of the failure\n' +
              '2. Whether this is a client error (bad request) or server error\n' +
              '3. The exact code fix',
          },
        }],
      };
    },
  );

  // ── debug_page_error ─────────────────────────────────────────────────────────
  server.registerPrompt(
    'debug_page_error',
    {
      description:
        'Diagnose the most recent JavaScript error or page crash. ' +
        'Use immediately after reproducing a bug to get a structured diagnosis ' +
        'with the stack trace, storage state, and network context.',
    },
    async () => {
      const errors = store.getLogs(5, 'error');
      const network = store.getNetwork(5);
      const contexts = store.getContext(2);
      const telemetry = { errors, lastNetworkCalls: network, dom: contexts };

      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'The page just showed an error. Live telemetry at the moment of crash:\n\n' +
              JSON.stringify(telemetry, null, 2) +
              '\n\nDiagnose:\n' +
              '1. Root cause with the exact source file and line\n' +
              '2. What application state triggered it\n' +
              '3. The fix as a before/after code diff',
          },
        }],
      };
    },
  );

  // ── summarize_session ────────────────────────────────────────────────────────
  server.registerPrompt(
    'summarize_session',
    {
      description:
        'Summarize the entire current debugging session. ' +
        'Use at end of session or when picking up after a break. ' +
        'Returns top issues found, what is healthy, and next actions.',
    },
    async () => {
      const counters = store.getCounters();
      const signals = store.getSignals();
      const errors = store.getLogs(10, 'error');
      const network = store.getNetwork(10);
      const telemetry = { counters, signals, recentErrors: errors, recentNetwork: network };

      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Please summarize this debugging session:\n\n' +
              JSON.stringify(telemetry, null, 2) +
              '\n\nProvide:\n' +
              '1. Top 3 issues found (with root causes)\n' +
              '2. What is healthy and working correctly\n' +
              '3. Recommended next actions in priority order',
          },
        }],
      };
    },
  );

  // ── fix — "did my fix work?" ─────────────────────────────────────────────────
  // The most common post-coding question. Developer applies a change, reloads the app,
  // types /fix — gets a binary answer: resolved / still broken / introduced regression.
  // Works best after start_debug_session has been called, but degrades gracefully
  // to a simple current-vs-nothing diff when no session is active.
  server.registerPrompt(
    'fix',
    {
      description:
        'Check if your last code change fixed the problem. ' +
        'Call this after applying a fix and reloading the app. ' +
        'Returns: what was resolved, what still persists, and any new regressions.',
      argsSchema: {
        session_id: z.string().optional()
          .describe('Debug session ID from start_debug_session (if you started one). Skip if you just want to check current error state.'),
      },
    },
    async ({ session_id }) => {
      const errors   = store.getLogs(200, 'error');
      const warns    = store.getLogs(50,  'warn');
      const netFails = store.getNetwork(200).filter(n => n.status >= 400 || n.status === 0 || !!n.error);
      const signals  = store.getSignals();

      const lines: string[] = [];

      if (session_id) {
        // If there's an active session, use checkpoint_debug_session for a precise diff
        lines.push(
          `I applied a fix. Check the current state against the debug session baseline.\n` +
          `Call \`checkpoint_debug_session\` with session_id: "${session_id}" and note: "applied fix".\n` +
          `Then tell me: what resolved, what persists, any new regressions.`,
        );
      } else {
        // No session — just report current state with a clear binary verdict
        const total = errors.length + netFails.length;

        lines.push(`I just applied a fix and reloaded the app. Current Mergen state:\n`);
        lines.push(`- Console errors: ${errors.length}`);
        lines.push(`- Network failures: ${netFails.length}`);
        lines.push(`- Warnings: ${warns.length}`);
        lines.push(`- Active signals: ${signals.length}`);
        lines.push('');

        if (errors.length > 0) {
          lines.push('**Current errors (may or may not be the same as before the fix):**');
          for (const e of errors.slice(0, 3)) {
            const msg = e.args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 150);
            lines.push(`- ${msg}`);
          }
          lines.push('');
        }

        if (netFails.length > 0) {
          lines.push('**Current network failures:**');
          for (const n of netFails.slice(0, 3)) {
            lines.push(`- ${n.method} ${n.url} → ${n.status || 'ERR'}`);
          }
          lines.push('');
        }

        lines.push(
          total === 0
            ? `**Give me a verdict: ✅ Buffer is clean — the fix appears to have worked. Tell me clearly: "Fixed" or "Not fixed" and what to do next.**`
            : `**Give me a verdict: is this the same error as before, or is it different? Clearly state: "Fixed", "Partially fixed" (describe what changed), or "Not fixed" (describe what\'s the same). Then tell me the next step.**`,
        );

        lines.push('');
        lines.push('Call `get_recent_logs` and `get_network_activity` to get the fresh events if needed.');
      }

      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: lines.join('\n') },
        }],
      };
    },
  );

  // ── why — "why is this broken?" — fastest path to root cause ─────────────────
  // Equivalent to typing "why is [current error] happening?" but with live telemetry
  // pre-attached. Skips the context-building step entirely.
  // The developer types /why when they see an error and don't understand it.
  // They get a root cause + fix suggestion in one response.
  server.registerPrompt(
    'why',
    {
      description:
        'Get the root cause of the current error — fastest path from symptom to fix. ' +
        'Use when you see an error but don\'t know why it\'s happening. ' +
        'Pre-fills the AI with the full error context so you skip description entirely.',
      argsSchema: {
        symptom: z.string().optional()
          .describe('Optional: one sentence describing what you see (e.g. "login button does nothing", "page goes blank", "500 from /api/users"). Skip to use whatever is in the buffer.'),
      },
    },
    async ({ symptom }) => {
      const errors   = store.getLogs(5,  'error');
      const netFails = store.getNetwork(5).filter(n => n.status >= 400 || n.status === 0 || !!n.error);
      const contexts = store.getContext(2);
      const latest   = hypothesisHistory.latest();
      const topHyp   = latest?.topHypothesis;

      if (errors.length === 0 && netFails.length === 0 && !symptom) {
        return {
          messages: [{
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: 'I want to diagnose a bug but the Mergen buffer is empty. Reproduce the issue in your browser first, then run /why again. Or describe the symptom: /why "login page goes blank after submit"',
            },
          }],
        };
      }

      const lines: string[] = [];

      if (symptom) lines.push(`**Symptom:** ${symptom}\n`);

      if (topHyp && topHyp.confidenceScore >= 0.50) {
        const pct = Math.round(topHyp.confidenceScore * 100);
        lines.push(`**Prior hypothesis (${pct}% confidence):** ${topHyp.summary}`);
        if (topHyp.fixHint) lines.push(`**Prior fix hint:** ${topHyp.fixHint}`);
        lines.push('');
      }

      lines.push('**Live telemetry:**');

      for (const e of errors.slice(0, 3)) {
        const msg = e.args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 300);
        lines.push(`\n[ERROR] ${msg}`);
        if (e.stack) lines.push(`Stack: ${e.stack.split('\n').slice(0, 4).join('\n  ')}`);
        if (e.gitSuspect) lines.push(`Git: ${e.gitSuspect.sha.slice(0, 7)} by ${e.gitSuspect.author} — "${e.gitSuspect.summary}"`);
      }

      for (const n of netFails.slice(0, 3)) {
        lines.push(`\n[NETWORK] ${n.method} ${n.url} → ${n.status || 'ERR'} (${n.duration}ms)`);
        if (n.error) lines.push(`  Error: ${n.error}`);
        if (n.traceId) lines.push(`  TraceId: ${n.traceId} — call get_correlated_trace if you have backend spans`);
      }

      if (contexts.length > 0) {
        const ctx = contexts[contexts.length - 1];
        lines.push(`\n[STATE] URL: ${ctx.url} | Component: ${ctx.component ?? 'none'} | Focused: ${ctx.activeElement ?? 'none'}`);
        const authKeys = Object.entries(ctx.localStorage).filter(([k]) => /token|auth|user|session/i.test(k));
        if (authKeys.length > 0) lines.push(`Auth state: ${authKeys.map(([k, v]) => `${k}=${v.slice(0, 30)}`).join(', ')}`);
      }

      lines.push('');
      lines.push(
        '**Task:** Explain WHY this is broken. One clear sentence: "This is broken because [specific cause]." ' +
        'Then give the exact file + line + code change that fixes it. ' +
        'Call `reconstruct_context` for source-mapped stack frames if you need more context. ' +
        'Do NOT ask clarifying questions — diagnose from what you have.',
      );

      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: lines.join('\n') },
        }],
      };
    },
  );
}
