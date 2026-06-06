/**
 * otel-trace.ts — W3C traceparent generation and propagation for Mergen.
 *
 * Implements the OTel MCP semantic conventions (merged Jan 2026):
 *   mcp.client span — when an AI agent calls a Mergen tool
 *   mcp.server span — when Mergen handles the call and fans out to Datadog
 *
 * By injecting traceparent into every outbound Datadog API call, we create
 * an unbroken trace chain: Claude/Cursor → Mergen → Datadog → your backend.
 * This makes Mergen the mandatory audit layer for AI agent actions.
 *
 * Traceparent format (W3C): "00-{traceId_32hex}-{spanId_16hex}-01"
 */

import crypto from 'crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
  tracestate?: string;
}

// Session-level trace ID — stable for the lifetime of the Mergen process.
// Provides a stable root span for all activity in one server session.
const SESSION_TRACE_ID = crypto.randomBytes(16).toString('hex');

let _traceId = SESSION_TRACE_ID;
let _spanId  = crypto.randomBytes(8).toString('hex');

/**
 * Start a new MCP server span. Call this when handling an incoming tool call.
 * If the caller passed a traceparent in `_meta`, continue that trace.
 * Otherwise begin a new child span under the session trace.
 */
export function startServerSpan(incomingTraceparent?: string | null): TraceContext {
  if (incomingTraceparent) {
    const parsed = parseTraceparent(incomingTraceparent);
    if (parsed) {
      // Continue the caller's trace, new span
      _traceId = parsed.traceId;
      _spanId  = crypto.randomBytes(8).toString('hex');
      return build();
    }
  }
  // New child span under session trace
  _spanId = crypto.randomBytes(8).toString('hex');
  return build();
}

/**
 * Start a fresh client span for an outbound call to Datadog.
 * This span is a child of whatever server span is currently active.
 */
export function startClientSpan(): TraceContext {
  const childSpan = crypto.randomBytes(8).toString('hex');
  return {
    traceId: _traceId,
    spanId: childSpan,
    traceparent: `00-${_traceId}-${childSpan}-01`,
  };
}

/** Returns the current active trace context without creating a new span. */
export function getCurrentTraceContext(): TraceContext {
  return build();
}

/**
 * Extract a traceparent string from MCP _meta (the JSON-RPC param bag).
 * Handles both flat `_meta.traceparent` and nested `_meta.traceContext.traceparent`.
 */
export function extractTraceparentFromMeta(meta?: Record<string, unknown>): string | null {
  if (!meta) return null;
  if (typeof meta['traceparent'] === 'string') return meta['traceparent'];
  const tc = meta['traceContext'] as Record<string, unknown> | undefined;
  if (typeof tc?.['traceparent'] === 'string') return tc['traceparent'];
  return null;
}

/**
 * Parse a traceparent string into its components.
 * Returns null if the string is malformed.
 */
export function parseTraceparent(tp: string): { traceId: string; spanId: string; flags: string } | null {
  const parts = tp.split('-');
  if (parts.length < 4) return null;
  const [version, traceId, spanId, flags] = parts;
  if (version !== '00') return null;
  if (!/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (!/^[0-9a-f]{16}$/.test(spanId)) return null;
  return { traceId, spanId, flags: flags ?? '01' };
}

/**
 * Build the _meta traceContext block to inject into MCP JSON-RPC responses
 * and downstream requests — following the OTel MCP semantic convention.
 */
export function buildMetaTraceContext(): Record<string, unknown> {
  const ctx = build();
  return {
    traceContext: {
      traceparent: ctx.traceparent,
      // tracestate intentionally omitted unless we have vendor-specific state
    },
  };
}

function build(): TraceContext {
  return {
    traceId: _traceId,
    spanId: _spanId,
    traceparent: `00-${_traceId}-${_spanId}-01`,
  };
}
