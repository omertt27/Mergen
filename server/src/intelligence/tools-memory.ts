import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { memoryStore, formatMttr, type IncidentMemoryRecord } from '../datadog/memory-store.js';
import { trackCall } from './tools-state.js';

function formatRecord(r: IncidentMemoryRecord, index: number): string {
  const firedAgo = Math.round((Date.now() - r.firedAt) / 60_000);
  const mttr = r.mttrMs ? formatMttr(r.mttrMs) : 'unresolved';
  const fix = r.fixPrTitle
    ? `Fix: [${r.fixPrTitle}](${r.fixPrUrl ?? '#'}) (${r.resolutionType})`
    : r.fixSummary
      ? `Fix: ${r.fixSummary}`
      : `Fix: not captured (${r.resolutionType})`;

  const location = r.implicatedFile
    ? `\`${r.implicatedFile}${r.implicatedLine ? ':' + r.implicatedLine : ''}\``
    : 'unknown';

  return [
    `**${index + 1}.** \`${new Date(r.firedAt).toISOString().slice(0, 16)}\` · ${firedAgo}m ago`,
    `   Service: \`${r.service}\` · Endpoint: \`${r.endpoint}\``,
    `   Error: ${r.errorMessage.slice(0, 120)}`,
    `   Location: ${location}`,
    `   MTTR: ${mttr} · ${fix}`,
    r.deployedSha ? `   Deploy: \`${r.deployedSha.slice(0, 7)}\`` : '',
  ].filter(Boolean).join('\n');
}

export function registerMemoryTools(server: McpServer): void {
  // ── get_incident_history ───────────────────────────────────────────────────
  server.registerTool(
    'get_incident_history',
    {
      description:
        'Returns the historical record of past incidents matching the current error pattern. ' +
        'Use this after get_incident_context to answer: "Have we seen this before? ' +
        'How was it fixed? How long did it take?" ' +
        'The fingerprint is a stable hash of error_type + service + endpoint — same class of bug, same fingerprint. ' +
        'Also returns benchmark statistics (p50 MTTR, most common fix type).',
      inputSchema: {
        fingerprint: z
          .string()
          .optional()
          .describe('16-char hex fingerprint from a previous incident (shown in get_incident_context output)'),
        service: z
          .string()
          .optional()
          .describe('Filter by Datadog service name instead of fingerprint'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Max past incidents to return (default 5)'),
      },
    },
    async ({ fingerprint, service, limit = 5 }) => {
      trackCall('get_incident_history');

      if (!fingerprint && !service) {
        return {
          content: [{
            type: 'text',
            text: [
              '## Incident History',
              '',
              'Provide either `fingerprint` (from a Runtime Fact) or `service` to look up history.',
              '',
              '**Open incidents right now:**',
              ...memoryStore.listOpen().slice(0, 5).map((r, i) => formatRecord(r, i)),
            ].join('\n'),
          }],
        };
      }

      let similar: IncidentMemoryRecord[];
      if (fingerprint) {
        similar = memoryStore.findSimilar(fingerprint, limit);
      } else {
        // Service filter: return recent records for that service regardless of fingerprint
        similar = memoryStore.listOpen()
          .filter((r) => r.service === service)
          .slice(0, limit);
        if (similar.length < limit) {
          // Also fetch resolved ones
          const fp = similar[0]?.fingerprint;
          if (fp) similar = memoryStore.findSimilar(fp, limit);
        }
      }

      if (similar.length === 0) {
        return {
          content: [{
            type: 'text',
            text: fingerprint
              ? `No historical incidents found for fingerprint \`${fingerprint}\`.\n\nThis is the first time Mergen has seen this error pattern.`
              : `No historical incidents found for service \`${service}\`.`,
          }],
        };
      }

      const fp = similar[0].fingerprint;
      const stats = memoryStore.benchmarkStats(fp);
      const lines: string[] = [
        `## Incident History — fingerprint \`${fp}\``,
        '',
      ];

      if (stats && stats.occurrences > 1) {
        const p50 = stats.p50MttrMs ? formatMttr(stats.p50MttrMs) : 'N/A';
        const p90 = stats.p90MttrMs ? formatMttr(stats.p90MttrMs) : 'N/A';
        const lastSeen = stats.lastSeenAt
          ? `${Math.round((Date.now() - stats.lastSeenAt) / 86_400_000)}d ago`
          : 'unknown';
        lines.push(
          `**Seen ${stats.occurrences} time${stats.occurrences !== 1 ? 's' : ''} · p50 MTTR: ${p50} · p90 MTTR: ${p90}**`,
          `Most common fix: **${stats.topResolutionType}** (${stats.topResolutionCount}/${stats.occurrences} times) · Last seen: ${lastSeen}`,
          '',
        );
      }

      lines.push('**Past incidents (most recent first):**', '');
      for (const [i, r] of similar.entries()) {
        lines.push(formatRecord(r, i), '');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── list_open_incidents ────────────────────────────────────────────────────
  server.registerTool(
    'list_open_incidents',
    {
      description:
        'Lists all currently open incidents tracked by Mergen (fired but not yet resolved). ' +
        'Use this to see what is actively burning and whether any GitHub PRs have been correlated.',
      inputSchema: {},
    },
    async () => {
      trackCall('list_open_incidents');

      const open = memoryStore.listOpen();
      if (open.length === 0) {
        return { content: [{ type: 'text', text: '## Open Incidents\n\nNo open incidents. All quiet.' }] };
      }

      const lines = [`## Open Incidents (${open.length})`, ''];
      for (const [i, r] of open.entries()) {
        lines.push(formatRecord(r, i), '');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
