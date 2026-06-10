/**
 * otlp-receiver.ts — Local OTLP HTTP receiver (ports 4318 + 3000).
 *
 * Any OpenTelemetry-instrumented service can point its OTLP exporter at
 * http://localhost:4318 and Mergen will ingest its spans and logs without
 * any Mergen-specific SDK changes.
 *
 * Supported:
 *   POST /v1/traces  — OTLP JSON trace data → BackendSpanEvent per server span
 *   POST /v1/logs    — OTLP JSON log data   → ConsoleEvent
 *   POST /v1/metrics — OTLP JSON metrics    → acknowledged, not stored (future)
 *
 * Format: application/json (OTLP JSON encoding).
 * Protobuf (application/x-protobuf) returns 415 with a helpful message.
 *
 * OTLP JSON spec: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
 */

import { Router, type Request, type Response } from 'express';
import { store } from '../sensor/buffer.js';
import { historyStore } from '../sensor/sqlite-store.js';
import { serviceGraph, extractCalleeService } from '../sensor/service-graph.js';
import logger from '../sensor/logger.js';

export const otlpReceiverRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract string value from an OTLP AnyValue. */
function anyStr(v: OtlpAnyValue | undefined): string {
  if (!v) return '';
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.intValue !== 'undefined') return String(v.intValue);
  if (typeof v.doubleValue !== 'undefined') return String(v.doubleValue);
  if (typeof v.boolValue !== 'undefined') return String(v.boolValue);
  return '';
}

/** Extract number from an OTLP AnyValue. */
function anyNum(v: OtlpAnyValue | undefined): number {
  if (!v) return 0;
  if (typeof v.intValue !== 'undefined') return Number(v.intValue);
  if (typeof v.doubleValue !== 'undefined') return Number(v.doubleValue);
  return 0;
}

/** Build a flat attribute map from OTLP KeyValue array. */
function attrMap(attrs: OtlpKeyValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of attrs ?? []) {
    if (kv.key) out[kv.key] = anyStr(kv.value);
  }
  return out;
}

/** Convert nanosecond unix timestamp string to milliseconds. */
function nanoToMs(nano: string | number | undefined): number {
  if (!nano) return Date.now();
  const n = typeof nano === 'string' ? BigInt(nano) : BigInt(Math.round(Number(nano)));
  return Number(n / 1_000_000n);
}

/** Normalize traceId — handle both hex strings and base64. */
function normalizeId(id: string | undefined, expectedHexLen: number): string {
  if (!id) return '0'.repeat(expectedHexLen);
  // Already hex
  if (/^[0-9a-f]+$/i.test(id) && id.length === expectedHexLen) return id.toLowerCase();
  // Base64 — decode and re-encode as hex
  try {
    const buf = Buffer.from(id, 'base64');
    return buf.toString('hex').padStart(expectedHexLen, '0').slice(0, expectedHexLen);
  } catch {
    return id.slice(0, expectedHexLen).toLowerCase();
  }
}

// ── OTLP JSON type stubs ──────────────────────────────────────────────────────

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtlpKeyValue { key?: string; value?: OtlpAnyValue; }
interface OtlpStatus  { code?: number; message?: string; }
interface OtlpSpan {
  traceId?: string; spanId?: string; parentSpanId?: string;
  name?: string; kind?: number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?:   string | number;
  status?: OtlpStatus;
  attributes?: OtlpKeyValue[];
}
interface OtlpScopeSpans { spans?: OtlpSpan[]; }
interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
}
interface OtlpTracesPayload { resourceSpans?: OtlpResourceSpans[]; }

interface OtlpLogRecord {
  timeUnixNano?: string | number;
  severityNumber?: number;
  severityText?: string;
  body?: OtlpAnyValue;
  traceId?: string; spanId?: string;
  attributes?: OtlpKeyValue[];
}
interface OtlpScopeLogs { logRecords?: OtlpLogRecord[]; }
interface OtlpResourceLogs {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeLogs?: OtlpScopeLogs[];
}
interface OtlpLogsPayload { resourceLogs?: OtlpResourceLogs[]; }

// ── SPAN_KIND: only SERVER (2) spans become backend_span events ───────────────
// CLIENT (3) spans become network events; internal/producer/consumer are skipped.
const SPAN_KIND_SERVER   = 2;
const SPAN_KIND_CLIENT   = 3;

// ── Severity mapping ──────────────────────────────────────────────────────────
function severityToLevel(n: number | undefined, text: string | undefined): 'log' | 'warn' | 'error' {
  const t = (text ?? '').toLowerCase();
  if (n !== undefined) {
    if (n >= 17) return 'error'; // ERROR, FATAL
    if (n >= 13) return 'warn';  // WARN
  }
  if (t.includes('error') || t.includes('fatal') || t.includes('crit')) return 'error';
  if (t.includes('warn')) return 'warn';
  return 'log';
}

// ── POST /v1/traces ───────────────────────────────────────────────────────────
otlpReceiverRouter.post('/v1/traces', (req: Request, res: Response): void => {
  if (req.headers['content-type']?.includes('application/x-protobuf')) {
    res.status(415).json({
      error: 'Mergen OTLP receiver accepts JSON only. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json in your service.',
    });
    return;
  }

  const payload = req.body as OtlpTracesPayload;
  if (!payload?.resourceSpans) {
    res.status(400).json({ error: 'missing resourceSpans' });
    return;
  }

  let ingested = 0;

  for (const rs of payload.resourceSpans ?? []) {
    const resourceAttrs = attrMap(rs.resource?.attributes);
    const serviceName = resourceAttrs['service.name'] ?? 'unknown';

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const traceId  = normalizeId(span.traceId,  32);
        const spanId   = normalizeId(span.spanId,   16);
        const parentId = span.parentSpanId ? normalizeId(span.parentSpanId, 16) : undefined;

        const startMs = nanoToMs(span.startTimeUnixNano);
        const endMs   = nanoToMs(span.endTimeUnixNano);
        const durMs   = Math.max(0, endMs - startMs);

        const attrs   = attrMap(span.attributes);
        const method  = attrs['http.method'] ?? attrs['rpc.method'] ?? 'UNKNOWN';
        const route   = attrs['http.route']  ?? attrs['http.target'] ?? attrs['url.path'] ?? span.name ?? '/';
        const status  = parseInt(attrs['http.status_code'] ?? attrs['http.response.status_code'] ?? '0', 10) || 0;
        const isError = (span.status?.code === 2) || status >= 500;

        if (span.kind === SPAN_KIND_SERVER || span.kind === undefined) {
          const event = {
            type: 'backend_span' as const,
            service:    serviceName,
            route,
            method:     method.toUpperCase(),
            statusCode: status || (isError ? 500 : 200),
            durationMs: durMs,
            traceId,
            spanId,
            parentSpanId: parentId,
            sdk:       'node' as const, // OTLP source — treat as node for badge display
            timestamp: startMs,
            ...(isError || span.status?.message ? { error: span.status?.message ?? `HTTP ${status}` } : {}),
          };
          store.push(event);
          historyStore.push(event);
          ingested++;
        } else if (span.kind === SPAN_KIND_CLIENT) {
          // Outbound HTTP client span → network event
          const url = attrs['http.url'] ?? attrs['url.full'] ?? attrs['http.target'] ?? route;
          const event = {
            type:       'network' as const,
            method:     method.toUpperCase(),
            url,
            status:     status || 0,
            statusText: isError ? 'Error' : 'OK',
            duration:   durMs,
            timestamp:  startMs,
            traceId,
            ...(span.status?.message ? { error: span.status.message } : {}),
          };
          store.push(event);
          historyStore.push(event);
          ingested++;

          // Update service dependency graph from CLIENT spans
          const callee = extractCalleeService(attrs, span.name ?? '');
          if (callee) serviceGraph.recordCall(serviceName, callee, isError);
        }
        // Producer/consumer/internal spans: silently acknowledged
      }
    }
  }

  logger.debug({ ingested }, 'OTLP traces ingested');
  res.status(200).json({ partialSuccess: {} });
});

// ── POST /v1/logs ─────────────────────────────────────────────────────────────
otlpReceiverRouter.post('/v1/logs', (req: Request, res: Response): void => {
  if (req.headers['content-type']?.includes('application/x-protobuf')) {
    res.status(415).json({
      error: 'Mergen OTLP receiver accepts JSON only. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json.',
    });
    return;
  }

  const payload = req.body as OtlpLogsPayload;
  if (!payload?.resourceLogs) {
    res.status(400).json({ error: 'missing resourceLogs' });
    return;
  }

  let ingested = 0;

  for (const rl of payload.resourceLogs ?? []) {
    const resourceAttrs = attrMap(rl.resource?.attributes);
    const serviceName   = resourceAttrs['service.name'] ?? 'unknown';
    const processUrl    = `mergen://node/${serviceName}`;

    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const ts    = nanoToMs(rec.timeUnixNano);
        const level = severityToLevel(rec.severityNumber, rec.severityText);
        const body  = anyStr(rec.body) || '(empty log)';
        const attrs = attrMap(rec.attributes);

        const traceId = rec.traceId ? normalizeId(rec.traceId, 32) : undefined;
        const stack   = attrs['exception.stacktrace'] ?? attrs['error.stack'] ?? undefined;

        const event = {
          type:      'console' as const,
          level,
          args:      [body],
          stack,
          url:       processUrl,
          timestamp: ts,
          sdk:       'node' as const,
          ...(traceId ? { traceId } : {}),
        };
        store.push(event);
        historyStore.push(event);
        ingested++;
      }
    }
  }

  logger.debug({ ingested }, 'OTLP logs ingested');
  res.status(200).json({ partialSuccess: {} });
});

// ── POST /v1/metrics ─────────────────────────────────────────────────────────
// Acknowledge but don't store — metrics visualization is out of scope for Mergen.
otlpReceiverRouter.post('/v1/metrics', (_req: Request, res: Response): void => {
  res.status(200).json({ partialSuccess: {} });
});
