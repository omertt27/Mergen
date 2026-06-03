/**
 * mcp-prompts.ts — MCP Prompt primitives for Mergen.
 *
 * Prompts are pre-filled message templates that wire live telemetry directly
 * into a structured debugging question. They give AI clients a guided entry
 * point for the most common debugging workflows — no manual copy-paste needed.
 *
 * Registered prompts:
 *   debug_auth_failure    — diagnose broken login / token storage
 *   debug_network_error   — diagnose a failing API request
 *   debug_page_error      — diagnose the most recent JavaScript crash
 *   summarize_session     — summarize what happened in this session
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store } from '../sensor/buffer.js';

export function registerPrompts(server: McpServer): void {
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
}
