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

/** Registers only `get_incident_context` — used by slim (5-tool) MCP mode. */
export function registerGetIncidentContext(server: McpServer): void {
  registerDatadogTools(server, { onlyGetIncidentContext: true });
}

export function registerDatadogTools(
  server: McpServer,
  opts?: { onlyGetIncidentContext?: boolean },
): void {
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
        const parts: string[] = [
          `## Active Incident: ${active.alertTitle}`,
          `*Fired ${ageMin}m ago · Service: \`${active.service}\`*`,
          active.alertUrl ? `*PagerDuty: ${active.alertUrl}*` : '',
          '',
        ];

        // Blame attribution block
        const blame = active.blameAttribution;
        if (blame?.topCandidate) {
          const sha8 = blame.topCandidate.sha.slice(0, 8);
          const pct  = Math.round(blame.confidence * 100);
          const label = blame.confidenceLabel;
          parts.push('### Causal Attribution');
          parts.push(
            `**Deploy \`${sha8}\` — ${pct}% confidence [${label}]**  ` +
            (blame.lowConfidence ? '⚠️ Below threshold — investigate before acting.' : ''),
          );
          parts.push('');
          parts.push('**Signal breakdown:**');
          for (const [name, sig] of Object.entries(blame.signals) as [string, typeof blame.signals.timing][]) {
            const bar = sig.available ? `${Math.round(sig.score * 100)}%` : 'n/a';
            parts.push(`- **${name}** (${bar} × ${sig.weight} = +${sig.contribution.toFixed(2)}): ${sig.detail}`);
          }
          parts.push('');
          parts.push(`> ${blame.explanation}`);
          if (blame.changedFiles.length > 0) {
            parts.push('');
            parts.push(`**Files in deploy:** ${blame.changedFiles.slice(0, 8).join(', ')}${blame.changedFiles.length > 8 ? ` (+${blame.changedFiles.length - 8} more)` : ''}`);
          }
          if (blame.topCandidate.prUrl) parts.push(`**PR:** ${blame.topCandidate.prUrl}`);
          parts.push('', '---', '');
        }

        parts.push(active.runtimeFact);

        return {
          content: [{
            type: 'text' as const,
            text: parts.filter(Boolean).join('\n'),
          }],
        };
      }

      // Multi-service: MERGEN_SERVICES=svc1,svc2 — try each when no explicit service
      const configuredServices = (process.env.MERGEN_SERVICES ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);

      const targetService = service ?? active?.service;
      if (!targetService && configuredServices.length === 0) {
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
              'Or configure monitored services with:',
              '`MERGEN_SERVICES=payment-gateway,auth-service node dist/index.js`',
              '',
              'Or connect PagerDuty by adding this webhook URL to your PagerDuty service:',
              '`POST http://127.0.0.1:3000/webhooks/pagerduty`',
              '',
              'PagerDuty will then auto-trigger context fetching on every new incident.',
            ].join('\n'),
          }],
        };
      }

      // When no explicit service and no active PD incident, try all configured services
      // and return the first one that has errors.
      const servicesToTry: string[] = targetService
        ? [targetService]
        : configuredServices;

      try {
        const to = new Date();
        const from = new Date(to.getTime() - since_minutes * 60 * 1000);

        let result = null;
        let resolvedService = servicesToTry[0] ?? 'unknown';
        for (const svc of servicesToTry) {
          const r = await fetchLatestErrorTrace(svc, since_minutes);
          if (r) { result = r; resolvedService = svc; break; }
        }
        const checkedServices = servicesToTry.join(', ');
        if (!result) {
          return {
            content: [{
              type: 'text',
              text:
                `No error traces found for service(s) \`${checkedServices}\` in the last ${since_minutes} minutes.\n\n` +
                `Either the service is healthy or the service name doesn't match Datadog exactly.\n` +
                `Check your Datadog APM service list at: https://app.datadoghq.com/apm/services\n\n` +
                (servicesToTry.length > 1
                  ? `Checked ${servicesToTry.length} services. Add more with MERGEN_SERVICES=svc1,svc2.`
                  : `Set MERGEN_SERVICES=svc1,svc2 to auto-scan multiple services.`),
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

  if (opts?.onlyGetIncidentContext) return;

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
