import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fetchLatestErrorTrace, fetchSpans, isConfigured } from '../datadog/client.js';
import { compact, type RuntimeFact } from '../datadog/compactor.js';
import { getActiveIncident } from '../datadog/incident-state.js';
import { fingerprintFromFact } from '../datadog/fingerprinter.js';
import { memoryStore, formatMttr } from '../datadog/memory-store.js';
import { trackCall } from './tools-state.js';

function buildPatternHeader(fact: RuntimeFact): string {
  const fingerprint = fingerprintFromFact(fact);
  const stats = memoryStore.benchmarkStats(fingerprint);
  const similar = memoryStore.findSimilar(fingerprint, 3);

  if (!stats || stats.occurrences < 2) return '';

  const p50 = stats.p50MttrMs ? formatMttr(stats.p50MttrMs) : 'N/A';
  const lastSeen = stats.lastSeenAt
    ? `${Math.round((Date.now() - stats.lastSeenAt) / 86_400_000)}d ago`
    : 'unknown';

  const lines = [
    `## Pattern Memory — seen ${stats.occurrences} time${stats.occurrences !== 1 ? 's' : ''} before`,
    `**p50 MTTR: ${p50}** · Most common fix: **${stats.topResolutionType}** (${stats.topResolutionCount}/${stats.occurrences}) · Last seen: ${lastSeen}`,
    `Fingerprint: \`${fingerprint}\``,
  ];

  const withFix = similar.filter((r) => r.fixPrTitle || r.fixSummary).slice(0, 2);
  if (withFix.length > 0) {
    lines.push('', '**Previous fixes:**');
    for (const r of withFix) {
      const fix = r.fixPrTitle ? `[${r.fixPrTitle}](${r.fixPrUrl ?? '#'})` : r.fixSummary ?? '';
      const when = `${Math.round((Date.now() - r.firedAt) / 86_400_000)}d ago`;
      lines.push(`- ${when} · ${r.resolutionType} · ${fix}`);
    }
  }

  lines.push('', '---', '');
  return lines.join('\n');
}

const NOT_CONFIGURED_MSG = [
  '## Datadog not configured',
  '',
  'Run the following to connect Mergen to Datadog:',
  '```',
  'mergen-server init',
  '```',
  '',
  'Or set environment variables before starting the server:',
  '```',
  'export DD_API_KEY=<your-api-key>',
  'export DD_APP_KEY=<your-app-key>',
  'mergen-server start',
  '```',
].join('\n');

export function registerDatadogTools(server: McpServer): void {
  // ── get_incident_context ──────────────────────────────────────────────────────
  server.registerTool(
    'get_incident_context',
    {
      description:
        'PRIMARY on-call tool. Fetches the current production incident from Datadog, ' +
        'compacts raw trace telemetry (500KB → 1KB Runtime Fact), and maps the error ' +
        'to your local source code so the AI can propose an immediate fix. ' +
        'If a PagerDuty alert fired recently the context is pre-fetched and returned instantly. ' +
        'Call this first whenever a production error is reported.',
      inputSchema: {
        service: z
          .string()
          .optional()
          .describe(
            'Datadog service name (e.g. "payment-gateway"). ' +
            'Auto-detected from active PagerDuty alert if omitted.',
          ),
        since_minutes: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Look-back window in minutes (default 10)'),
      },
    },
    async ({ service, since_minutes = 10 }) => {
      trackCall('get_incident_context');

      if (!isConfigured()) {
        return { content: [{ type: 'text', text: NOT_CONFIGURED_MSG }] };
      }

      // Return pre-computed fact if a PagerDuty alert fired and Datadog fetch is done
      const active = getActiveIncident();
      if (active?.runtimeFact) {
        const ageMin = Math.round((Date.now() - active.firedAt) / 60_000);
        return {
          content: [{
            type: 'text',
            text: [
              `## Active Incident: ${active.alertTitle}`,
              `*Fired ${ageMin}m ago · Service: \`${active.service}\`*`,
              active.alertUrl ? `*PagerDuty: ${active.alertUrl}*` : '',
              '',
              active.runtimeFact,
            ].filter(Boolean).join('\n'),
          }],
        };
      }

      const targetService = service ?? active?.service;
      if (!targetService) {
        return {
          content: [{
            type: 'text',
            text: [
              '## No active incident detected',
              '',
              'Provide a `service` name to query Datadog directly:',
              '```',
              'get_incident_context(service: "payment-gateway")',
              '```',
              '',
              'Or connect PagerDuty by adding this webhook URL to your PagerDuty service:',
              '`POST http://127.0.0.1:3000/webhooks/pagerduty`',
              '',
              'PagerDuty will then auto-trigger context fetching on every new incident.',
            ].join('\n'),
          }],
        };
      }

      try {
        const to = new Date();
        const from = new Date(to.getTime() - since_minutes * 60 * 1000);

        const result = await fetchLatestErrorTrace(targetService, since_minutes);
        if (!result) {
          return {
            content: [{
              type: 'text',
              text:
                `No error traces found for service \`${targetService}\` in the last ${since_minutes} minutes.\n\n` +
                `Either the service is healthy or the service name doesn't match Datadog exactly.\n` +
                `Check your Datadog APM service list at: https://app.datadoghq.com/apm/services`,
            }],
          };
        }

        const { fact } = await compact({
          spans: result.spans,
          traceId: result.traceId,
          timeWindow: { from, to },
        });

        const patternHeader = buildPatternHeader(fact);
        return { content: [{ type: 'text', text: patternHeader + fact.markdown }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Failed to fetch Datadog data: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ── get_datadog_trace ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_datadog_trace',
    {
      description:
        'Fetches and compacts a specific Datadog trace by trace ID. ' +
        'Use this when you already have a trace ID from a Datadog URL, a log line, ' +
        'or a Sentry event. Returns the same 1KB Runtime Fact as get_incident_context.',
      inputSchema: {
        trace_id: z
          .string()
          .describe('Datadog trace ID (from a URL like /apm/traces?query=trace_id:XXX)'),
        service: z
          .string()
          .optional()
          .describe('Service name to scope the search (improves speed)'),
        since_minutes: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('How far back to look for this trace (default 15 minutes)'),
      },
    },
    async ({ trace_id, service, since_minutes = 15 }) => {
      trackCall('get_datadog_trace');

      if (!isConfigured()) {
        return {
          content: [{ type: 'text', text: NOT_CONFIGURED_MSG }],
          isError: true,
        };
      }

      try {
        const to = new Date();
        const from = new Date(to.getTime() - since_minutes * 60 * 1000);

        const allSpans = await fetchSpans({ service, from, to, limit: 200 });

        // Flexible match: exact, suffix, or prefix
        const traceSpans = allSpans.filter(
          (s) =>
            s.traceId === trace_id ||
            s.traceId.endsWith(trace_id) ||
            trace_id.endsWith(s.traceId),
        );

        if (traceSpans.length === 0) {
          return {
            content: [{
              type: 'text',
              text:
                `No spans found for trace \`${trace_id}\` in the last ${since_minutes} minutes.\n\n` +
                `Try increasing \`since_minutes\` or verify the trace ID is correct.`,
            }],
          };
        }

        const { fact } = await compact({
          spans: traceSpans,
          traceId: trace_id,
          timeWindow: { from, to },
        });

        return { content: [{ type: 'text', text: fact.markdown }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Failed to fetch trace: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
