/**
 * mcp-resources.ts — MCP Resource primitives for Mergen.
 *
 * Resources are read-only, file-like data sources that AI clients can pull
 * directly into their context without consuming a tool call budget.
 * They complement Tools: Resources supply ambient state; Tools perform queries.
 *
 * Registered resources:
 *   mergen://buffer/snapshot        — counters, signals, health state
 *   mergen://buffer/errors          — recent console.error events
 *   mergen://buffer/network-failures — recent failed network requests
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { store } from '../sensor/buffer.js';

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
}
