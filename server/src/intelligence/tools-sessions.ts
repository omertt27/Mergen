/**
 * tools-sessions.ts — MCP tools for session replay and audit access.
 *
 * get_session_replay  — fetch events from archived past sessions
 * get_audit_log       — read the enterprise audit log
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listSessionMetas, loadSessionsByTimeRange } from '../sensor/session-history.js';
import { getAuditLog } from '../sensor/audit-log.js';
import { trackCall, withTierGate } from './tools-state.js';
import { getTierForTool } from './tool-manifest.js';

export function registerSessionTools(server: McpServer): void {

  // ── get_session_replay ─────────────────────────────────────────────────────
  server.registerTool(
    'get_session_replay',
    {
      description:
        'Retrieves events from past debugging sessions archived to disk. ' +
        'Use when you need historical context: "what errors happened yesterday at 3pm?", ' +
        '"show me the session from this morning", "compare error counts across sessions". ' +
        'Sessions are auto-saved when the buffer is cleared or the server restarts. ' +
        'Tip: call with list_only:true first to see what sessions are available.',
      inputSchema: {
        since: z.number().int().optional()
          .describe('Start of time window as Unix ms timestamp (default: 24 h ago)'),
        until: z.number().int().optional()
          .describe('End of time window as Unix ms timestamp (default: now)'),
        limit: z.number().int().min(1).max(500).optional()
          .describe('Max events to return (default 200)'),
        list_only: z.boolean().optional()
          .describe('Return only session metadata without loading events (fast)'),
      },
    },
    async ({ since, until, limit = 200, list_only = false }) => {
      trackCall('get_session_replay');

      const metas = listSessionMetas();

      if (metas.length === 0) {
        return { content: [{ type: 'text', text: 'No past sessions found. Sessions are auto-saved on buffer clear and server restart. Capture some events first.' }] };
      }

      if (list_only) {
        const lines = [
          `## Past Sessions (${metas.length} total)`, '',
          ...metas.slice(0, 20).map(m =>
            `- **${new Date(m.savedAt).toISOString()}** — ${m.eventCount} events · _${m.label}_`,
          ),
        ];
        if (metas.length > 20) lines.push(`_…and ${metas.length - 20} more_`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      const now    = Date.now();
      const sinceMs = since ?? now - 24 * 60 * 60 * 1000;
      const untilMs = until ?? now;

      const events = loadSessionsByTimeRange(sinceMs, untilMs).slice(0, limit);

      if (events.length === 0) {
        const rangeStr = `${new Date(sinceMs).toISOString()} → ${new Date(untilMs).toISOString()}`;
        const available = metas.slice(0, 5).map(m => `  ${new Date(m.savedAt).toISOString()} (${m.eventCount} events)`).join('\n');
        return { content: [{ type: 'text', text: `No events found in range ${rangeStr}.\n\nMost recent sessions:\n${available}` }] };
      }

      const errors   = events.filter(e => e.type === 'console' && (e as { level?: string }).level === 'error');
      const netFails = events.filter(e => e.type === 'network' && ((e as { status?: number }).status ?? 0) >= 400);

      const lines: string[] = [
        `## Session Replay`, '',
        `**Range:** ${new Date(sinceMs).toISOString()} → ${new Date(untilMs).toISOString()}`,
        `**Events:** ${events.length} returned · ${errors.length} errors · ${netFails.length} network failures`,
        '',
        '### Console Errors',
      ];

      if (errors.length === 0) {
        lines.push('No errors in this window.');
      } else {
        for (const e of errors.slice(0, 20)) {
          const args = (e as { args?: unknown[] }).args ?? [];
          const msg  = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 200);
          lines.push(`- ${new Date(e.timestamp).toISOString()} — ${msg}`);
        }
        if (errors.length > 20) lines.push(`_…${errors.length - 20} more errors_`);
      }

      lines.push('', '### Network Failures');
      if (netFails.length === 0) {
        lines.push('No network failures in this window.');
      } else {
        for (const e of netFails.slice(0, 20)) {
          const n = e as { method?: string; url?: string; status?: number; duration?: number };
          lines.push(`- ${new Date(e.timestamp).toISOString()} — ${n.method ?? 'GET'} ${n.url} → ${n.status} (${n.duration}ms)`);
        }
        if (netFails.length > 20) lines.push(`_…${netFails.length - 20} more failures_`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── get_audit_log ──────────────────────────────────────────────────────────
  server.registerTool(
    'get_audit_log',
    {
      description:
        'Returns the enterprise audit log — a record of all API calls made to this Mergen instance. ' +
        'Each entry shows: timestamp, actor identity, HTTP method + path, response status, and duration. ' +
        'Use for security reviews, compliance audits, or investigating unexpected access patterns.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional()
          .describe('Max entries to return, newest first (default 100)'),
      },
    },
    withTierGate(getTierForTool('get_audit_log'), async ({ limit = 100 }) => {
      trackCall('get_audit_log');
      const entries = getAuditLog(limit);
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'Audit log is empty. Entries are written for all non-trivial API requests.' }] };
      }
      const lines = [
        `## Audit Log (last ${entries.length} entries)`, '',
        ...entries.map(e =>
          `${e.ts}  ${e.actor.padEnd(20)}  ${e.method.padEnd(6)}  ${e.path.padEnd(35)}  ${e.status}  ${e.durationMs}ms`,
        ),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }),
  );
}
