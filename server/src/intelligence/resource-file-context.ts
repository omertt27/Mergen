/**
 * resource-file-context.ts — Phase 2.5 Ambient IDE Context.
 *
 * Registers mergen://file/{+path} as an MCP Resource.
 * When an AI IDE opens a file and fetches this resource, it gets:
 *   1. Active incident warning (if any file implicated matches)
 *   2. Historical incidents that touched this file
 *   3. Benchmark MTTR stats for repeat patterns
 *   4. Production load from Datadog (if configured)
 *
 * The {+path} RFC 6570 reserved expansion allows slashes in the path segment,
 * so mergen://file/src/api/auth.ts works without encoding.
 *
 * Engineers never call this — the IDE polls it automatically as they navigate.
 * This achieves A=0 in P(Util) = e^{-λA}: zero-action ambient intelligence.
 */

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { memoryStore, formatMttr } from '../datadog/memory-store.js';
import { getActiveIncident } from '../datadog/incident-state.js';
import { getCurrentTraceContext } from '../datadog/otel-trace.js';
import logger from '../sensor/logger.js';

export function registerFileContextResource(server: McpServer): void {
  const template = new ResourceTemplate('mergen://file/{+path}', { list: undefined });

  server.resource(
    'file-context',
    template,
    async (uri, variables) => {
      const filePath = decodeURIComponent(String(variables['path'] ?? ''));
      if (!filePath) {
        return {
          contents: [{ uri: uri.href, mimeType: 'text/plain', text: '# No file path provided' }],
        };
      }

      const sections: string[] = [];

      // ── 1. Active incident warning ─────────────────────────────────────────
      const active = getActiveIncident();
      if (active) {
        const isImplicated =
          active.implicatedFile &&
          (active.implicatedFile.endsWith(filePath) ||
            filePath.endsWith(active.implicatedFile.split('/').pop() ?? ''));

        if (isImplicated) {
          sections.push(
            `## 🚨 ACTIVE INCIDENT — THIS FILE IS IMPLICATED\n\n` +
            `**Alert:** ${active.alertTitle}\n` +
            `**Trace:** \`${active.traceId}\`\n` +
            `**File/Line:** \`${active.implicatedFile}:${active.implicatedLine ?? '?'}\`\n` +
            `**Fired:** ${new Date(active.firedAt).toISOString()}\n\n` +
            `> Do not refactor this file while the incident is open.\n`,
          );
        } else {
          sections.push(
            `## ⚠️ ACTIVE INCIDENT (different file)\n\n` +
            `**Alert:** ${active.alertTitle} — implicated: \`${active.implicatedFile ?? 'unknown'}\`\n`,
          );
        }
      }

      // ── 2. Historical incidents for this file ──────────────────────────────
      const history = memoryStore.findByFile(filePath, 8);
      if (history.length > 0) {
        const lines: string[] = [`## Production Incident History for \`${filePath}\`\n`];
        for (const rec of history) {
          const age = formatAge(rec.firedAt);
          const mttr = rec.mttrMs ? formatMttr(rec.mttrMs) : 'open';
          const pr = rec.fixPrUrl ? ` → [fix PR](${rec.fixPrUrl})` : '';
          lines.push(
            `- **${rec.pdAlertTitle}** (${age} ago, MTTR ${mttr})  \n` +
            `  \`${rec.errorType}: ${truncate(rec.errorMessage, 80)}\`${pr}`,
          );
        }
        sections.push(lines.join('\n'));

        // ── 3. Benchmark stats for repeat patterns ─────────────────────────
        // Use the most-recent incident's fingerprint for benchmark lookup
        const topFp = history[0]?.fingerprint;
        if (topFp) {
          const bench = memoryStore.benchmarkStats(topFp);
          if (bench && bench.occurrences >= 2) {
            sections.push(
              `## Pattern Stats (fingerprint \`${topFp}\`)\n\n` +
              `- Occurrences: **${bench.occurrences}**\n` +
              `- p50 MTTR: **${bench.p50MttrMs ? formatMttr(bench.p50MttrMs) : 'n/a'}**\n` +
              `- p90 MTTR: **${bench.p90MttrMs ? formatMttr(bench.p90MttrMs) : 'n/a'}**\n` +
              `- Most common fix: **${bench.topResolutionType}** (${bench.topResolutionCount}×)\n`,
            );
          }
        }
      } else {
        sections.push(`## Production Incident History\n\nNo incidents on record for \`${filePath}\`.`);
      }

      // ── 4. Trace context (for downstream propagation) ──────────────────────
      const ctx = getCurrentTraceContext();
      sections.push(
        `## Mergen Trace Context\n\n` +
        `\`traceparent: ${ctx.traceparent}\``,
      );

      const text = sections.join('\n\n---\n\n');
      logger.debug({ filePath, historyCount: history.length }, 'file-context resource served');

      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
      };
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
