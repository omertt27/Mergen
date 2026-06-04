import { OtlpExporter, SpanRecord } from './exporter.js';
import { generateTraceId, generateSpanId, makeTraceparent } from './trace.js';

export function patchFetch(exporter: OtlpExporter): () => void {
  const _origFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url      = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method   = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : undefined) ?? 'GET').toUpperCase();
    const traceId  = generateTraceId();
    const spanId   = generateSpanId();
    const startMs  = Date.now();

    // Inject W3C traceparent so the backend can correlate this request.
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers as HeadersInit : {}));
    headers.set('traceparent', makeTraceparent(traceId, spanId));

    const patchedInit: RequestInit = { ...(init ?? {}), headers };
    // When input is a Request, rebuild it with the patched headers.
    const patchedInput = typeof input === 'string' || input instanceof URL
      ? input
      : new Request(input, patchedInit);

    let status = 0;
    let errorMsg: string | undefined;

    try {
      const response = await _origFetch(patchedInput, typeof patchedInput === 'string' || patchedInput instanceof URL ? patchedInit : undefined);
      status = response.status;
      if (!response.ok) errorMsg = response.statusText || `HTTP ${status}`;
      _sendSpan(exporter, { traceId, spanId, method, url, startMs, endMs: Date.now(), statusCode: status, error: errorMsg });
      return response;
    } catch (err: unknown) {
      errorMsg = err instanceof Error ? err.message : String(err);
      _sendSpan(exporter, { traceId, spanId, method, url, startMs, endMs: Date.now(), statusCode: 0, error: errorMsg });
      throw err;
    }
  };

  return (): void => { window.fetch = _origFetch; };
}

export function patchXHR(exporter: OtlpExporter): () => void {
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;
  const _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  // Track per-XHR metadata in a WeakMap.
  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string; traceId: string; spanId: string; startMs: number }>();

  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...rest: unknown[]): void {
    const traceId = generateTraceId();
    const spanId  = generateSpanId();
    meta.set(this, { method: method.toUpperCase(), url: String(url), traceId, spanId, startMs: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_origOpen as any).call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null): void {
    const m = meta.get(this);
    if (m) {
      m.startMs = Date.now();
      try { _origSetHeader.call(this, 'traceparent', makeTraceparent(m.traceId, m.spanId)); } catch { /* ignore */ }

      this.addEventListener('loadend', () => {
        if (!m) return;
        _sendSpan(exporter, {
          traceId:    m.traceId,
          spanId:     m.spanId,
          method:     m.method,
          url:        m.url,
          startMs:    m.startMs,
          endMs:      Date.now(),
          statusCode: this.status,
          error:      this.status >= 400 ? this.statusText || `HTTP ${this.status}` : undefined,
        });
      }, { once: true });
    }
    return _origSend.call(this, body);
  };

  return (): void => {
    XMLHttpRequest.prototype.open = _origOpen;
    XMLHttpRequest.prototype.send = _origSend;
  };
}

function _sendSpan(exporter: OtlpExporter, s: Omit<SpanRecord, 'name'>): void {
  try {
    exporter.sendSpan({ ...s, name: `${s.method} ${s.url}` });
  } catch { /* never crash the host page */ }
}
