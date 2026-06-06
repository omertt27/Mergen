/**
 * mcp-resources.ts — MCP Resource primitives for Mergen.
 *
 * Resources are read-only, file-like data sources that AI clients can pull
 * directly into their context without consuming a tool call budget.
 * They complement Tools: Resources supply ambient state; Tools perform queries.
 *
 * Registered resources:
 *   mergen://buffer/snapshot         — counters, signals, health state
 *   mergen://buffer/errors           — recent console.error events
 *   mergen://buffer/network-failures — recent failed network requests
 *   mergen://agent/trace-context     — current W3C traceparent for propagation
 *   mergen://file/{+path}            — production context for the open file
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { store } from '../sensor/buffer.js';
import { getCurrentTraceContext } from '../datadog/otel-trace.js';
import { registerFileContextResource } from './resource-file-context.js';

export function registerResources(server: McpServer): void {
  // ── Buffer snapshot ──────────────────────────────────────────────────────────
  // Zero-cost ambient context: error counts, active signals, and timing metadata.
  // AI clients should read this first to decide whether a deeper tool call is needed.
  server.registerResource(
    'mergen-buffer-snapshot',
    'mergen://buffer/snapshot',
    {
      description:
        'Current ring buffer statistics and session health signals. ' +
        'Read this before calling any tool to get error/warning counts, ' +
        'active signals (auth failures, network bursts, etc.), ' +
        'and the timestamp of the most recent event.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          size: store.size(),
          counters: store.getCounters(),
          lastEventAt: store.lastEventAt(),
          clearedAt: store.clearedAt(),
          signals: store.getSignals(),
        }, null, 2),
      }],
    }),
  );

  // ── Recent errors ────────────────────────────────────────────────────────────
  // The 20 most recent console.error events with resolved stack traces and
  // git-blame suspects. Avoids a get_recent_logs tool call for the common case.
  server.registerResource(
    'mergen-recent-errors',
    'mergen://buffer/errors',
    {
      description:
        'Most recent console.error events (up to 20). ' +
        'Includes de-minified stack traces and git-blame suspects where available. ' +
        'Use as a quick read before calling analyze_runtime.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(store.getLogs(20, 'error'), null, 2),
      }],
    }),
  );

  // ── Network failures ─────────────────────────────────────────────────────────
  // Only 4xx, 5xx, and network errors — noise-filtered view of the network panel.
  // Includes request/response bodies, traceId, tracestate, and baggage.
  server.registerResource(
    'mergen-network-failures',
    'mergen://buffer/network-failures',
    {
      description:
        'Recent failed network requests: 4xx, 5xx, and connection errors. ' +
        'Includes request/response bodies and W3C trace context (traceId, tracestate, baggage). ' +
        'Read this when diagnosing API failures before calling get_network_activity.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(
          store.getNetwork(20).filter(e => e.status >= 400 || e.status === 0 || !!e.error),
          null, 2,
        ),
      }],
    }),
  );

  // ── Agent trace context ───────────────────────────────────────────────────────
  // Exposes the current W3C traceparent so any AI agent can propagate the trace
  // into its own outbound calls — creating an unbroken Claude→Mergen→backend chain.
  server.registerResource(
    'mergen-agent-trace-context',
    'mergen://agent/trace-context',
    {
      description:
        'Current W3C traceparent for this Mergen session. ' +
        'Inject into your own HTTP calls via the traceparent header to extend the trace chain. ' +
        'Changes each time a new MCP tool call starts a server span.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const ctx = getCurrentTraceContext();
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({
            traceparent: ctx.traceparent,
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            usage: 'Inject as HTTP header: traceparent: <value>',
          }, null, 2),
        }],
      };
    },
  );

  // ── File production context ───────────────────────────────────────────────────
  // mergen://file/{+path} — ambient context for the file currently open in the IDE.
  // The IDE polls this as the developer navigates; no tool call needed.
  registerFileContextResource(server);
}
