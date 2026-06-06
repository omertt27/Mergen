/**
 * tools-blast-radius.ts — Move 3: Session Identity & Blast Radius Quantification.
 *
 * get_blast_radius answers the question a CTO asks in a P1 war room:
 *   "How many users are affected, what browser, and which deploy caused it?"
 *
 * Output format is deliberately board-deck-ready:
 *   "847 users affected (Safari 17.2 only), first seen 14:32:07,
 *    correlated to deploy abc123, active for 23 minutes."
 *
 * Confidence model:
 *   - sessionId present → count is exact (unique tab sessions)
 *   - userId present → user count is exact (authenticated identities)
 *   - Neither present → count reflects event occurrences, not unique users
 *     (noted explicitly in the output so the AI doesn't overclaim)
 *
 * The correlatedDeploy is probabilistic: the most recent successful deploy
 * prior to firstSeenAt. Display it as a hypothesis, not a fact, until
 * Move 1 (blame attribution with confidence score) is implemented.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { store, type BlastRadiusReport } from '../sensor/buffer.js';

export function registerBlastRadiusTools(server: McpServer): void {
  server.tool(
    'get_blast_radius',
    'Quantify the user impact of current errors: unique sessions affected, user count, browser/OS segments, first-seen time, and the likely causal deploy. Use this to answer "how many users are broken right now?" during an incident.',
    {
      since: z.number().optional().describe('Unix ms — only count errors after this timestamp. Omit to use all buffered events.'),
      error_pattern: z.string().optional().describe('Regex pattern to filter errors by message text (case-insensitive). Omit for all errors.'),
    },
    async ({ since, error_pattern }) => {
      const report = store.getBlastRadius({
        since,
        errorPattern: error_pattern,
      });

      const text = formatBlastRadius(report, { since, errorPattern: error_pattern });
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}

// ── Formatter ─────────────────────────────────────────────────────────────────

function formatBlastRadius(
  r: BlastRadiusReport,
  opts: { since?: number; errorPattern?: string },
): string {
  if (r.errorCount === 0) {
    const window = opts.since
      ? `since ${new Date(opts.since).toISOString()}`
      : 'in the current buffer';
    const pattern = opts.errorPattern ? ` matching \`${opts.errorPattern}\`` : '';
    return `## Blast Radius\n\nNo errors found${pattern} ${window}.`;
  }

  const lines: string[] = ['## Blast Radius'];

  // ── Primary numbers ────────────────────────────────────────────────────────
  const hasSessionIds = r.affectedSessions > 0;
  const hasUserIds    = r.affectedUsers > 0;

  if (hasSessionIds) {
    lines.push(`**${r.affectedSessions} session${r.affectedSessions !== 1 ? 's' : ''} affected**` +
      (hasUserIds ? ` (${r.affectedUsers} authenticated user${r.affectedUsers !== 1 ? 's' : ''})` : ''));
  } else {
    lines.push(`**${r.errorCount} error event${r.errorCount !== 1 ? 's' : ''}** (no session IDs — count is occurrences, not unique users)`);
  }

  // ── Timing ─────────────────────────────────────────────────────────────────
  if (r.firstSeenAt) {
    const firstStr = new Date(r.firstSeenAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const duration = r.durationMs !== null ? ` — active for **${formatDuration(r.durationMs)}**` : '';
    lines.push(`First seen: **${firstStr}**${duration}`);
  }

  // ── Browser/OS segments ────────────────────────────────────────────────────
  const browsers = Object.entries(r.browserSegments).sort((a, b) => b[1] - a[1]);
  const oses     = Object.entries(r.osSegments).sort((a, b) => b[1] - a[1]);

  if (browsers.length > 0) {
    const browserStr = browsers.map(([b, n]) => `${b}: ${n}`).join(', ');
    lines.push(`Browsers: ${browserStr}`);
  }
  if (oses.length > 0) {
    const osStr = oses.map(([o, n]) => `${o}: ${n}`).join(', ');
    lines.push(`OS: ${osStr}`);
  }

  if (browsers.length === 0 && oses.length === 0) {
    lines.push('_No userAgent data — update extension or SDK to enable browser segmentation_');
  }

  // ── Correlated deploy ──────────────────────────────────────────────────────
  if (r.correlatedDeploy) {
    lines.push(`Likely causal deploy: **\`${r.correlatedDeploy}\`** ` +
      `_(most recent successful deploy before first error — hypothesis, not confirmed)_`);
  } else {
    lines.push('No deploy event found prior to first error — check CI integration.');
  }

  // ── Top errors ─────────────────────────────────────────────────────────────
  if (r.topErrors.length > 0) {
    lines.push('');
    lines.push('### Top Errors');
    for (const { message, count } of r.topErrors) {
      lines.push(`- \`${message}\` — ${count}×`);
    }
  }

  // ── Confidence note ────────────────────────────────────────────────────────
  if (!hasSessionIds) {
    lines.push('');
    lines.push('> **Note:** Session IDs not present. Numbers reflect event count, not unique user count.');
    lines.push('> Ensure the Mergen extension is updated (v1.1+) or the production SDK is injected.');
  }

  return lines.join('\n');
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
