import { msToNano } from './trace.js';

export interface ExporterConfig {
  endpoint: string;
  service: string;
}

export interface LogRecord {
  timestampMs: number;
  level: 'log' | 'warn' | 'error';
  body: string;
  traceId?: string;
  spanId?: string;
  stack?: string;
  url: string;
}

export interface SpanRecord {
  traceId: string;
  spanId: string;
  name: string;
  startMs: number;
  endMs: number;
  statusCode: number;
  method: string;
  url: string;
  error?: string;
}

// OTLP severity numbers: INFO=9, WARN=13, ERROR=17
const SEVERITY: Record<string, number> = { log: 9, warn: 13, error: 17 };
// SPAN_KIND_CLIENT = 3
const SPAN_KIND_CLIENT = 3;

function attr(key: string, value: string): object {
  return { key, value: { stringValue: value } };
}

export class OtlpExporter {
  private readonly logsEndpoint: string;
  private readonly tracesEndpoint: string;
  private readonly resource: object;

  constructor(config: ExporterConfig) {
    const base = config.endpoint.replace(/\/$/, '');
    this.logsEndpoint   = `${base}/v1/logs`;
    this.tracesEndpoint = `${base}/v1/traces`;
    this.resource       = { attributes: [attr('service.name', config.service)] };
  }

  sendLog(rec: LogRecord): void {
    const record: Record<string, unknown> = {
      timeUnixNano:   msToNano(rec.timestampMs),
      severityNumber: SEVERITY[rec.level] ?? 9,
      severityText:   rec.level.toUpperCase(),
      body:           { stringValue: rec.body },
      attributes:     [
        attr('browser.url', rec.url),
        ...(rec.stack ? [attr('exception.stacktrace', rec.stack)] : []),
      ],
    };
    if (rec.traceId) record['traceId'] = rec.traceId;
    if (rec.spanId)  record['spanId']  = rec.spanId;

    this._post(this.logsEndpoint, {
      resourceLogs: [{
        resource: this.resource,
        scopeLogs: [{ logRecords: [record] }],
      }],
    });
  }

  sendSpan(span: SpanRecord): void {
    const isError     = span.statusCode >= 400 || !!span.error;
    const startNano   = msToNano(span.startMs);
    const endNano     = msToNano(span.endMs);

    this._post(this.tracesEndpoint, {
      resourceSpans: [{
        resource: this.resource,
        scopeSpans: [{
          spans: [{
            traceId:            span.traceId,
            spanId:             span.spanId,
            name:               `${span.method} ${new URL(span.url, location.href).pathname}`,
            kind:               SPAN_KIND_CLIENT,
            startTimeUnixNano:  startNano,
            endTimeUnixNano:    endNano,
            status: {
              code:    isError ? 2 : 1,
              message: span.error ?? '',
            },
            attributes: [
              attr('http.method',          span.method),
              attr('http.url',             span.url),
              attr('http.status_code',     String(span.statusCode)),
              attr('url.full',             span.url),
            ],
          }],
        }],
      }],
    });
  }

  private _post(url: string, body: unknown): void {
    // Use sendBeacon for reliability during page unload; fall back to fetch.
    const json = JSON.stringify(body);
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([json], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return;
      }
    } catch { /* ignore */ }
    // Fetch fallback — fire and forget, never reject.
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      // keepalive keeps the request alive after page navigation
      keepalive: true,
    }).catch(() => {});
  }
}
