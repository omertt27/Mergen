import { Request, Response, Router } from 'express';
import { store, BrowserEventSchema, type BrowserEvent } from './buffer.js';
import { resolveFrameAndStack } from './sourcemap.js';
import { redact } from './redact.js';
import logger from './logger.js';
import { layer2Store } from './layer2-store.js';
import { layer3Store } from './layer3-store.js';
import { layer4Store } from './layer4-store.js';
import { historyStore } from './sqlite-store.js';
import { exportToOtel } from './otel-exporter.js';
import { serviceTopology } from './service-topology.js';

// ── Team broadcast hook ───────────────────────────────────────────────────────
// Registered by intelligence/team.ts at startup to avoid a circular import.
type TeamBroadcaster = (events: BrowserEvent[], member: string) => void;
let _teamBroadcast: TeamBroadcaster | null = null;
export function registerTeamBroadcaster(fn: TeamBroadcaster): void {
  _teamBroadcast = fn;
}
function maybeTeamBroadcast(event: BrowserEvent): void {
  if (_teamBroadcast) {
    try { _teamBroadcast([event], 'self'); } catch { /* non-fatal */ }
  }
}

// ── Diagnostic activity hooks ─────────────────────────────────────────────────
// The intelligence layer registers these at startup so the sensor layer
// stays free of closed-source imports.
export type ActivityNotifier = {
  notifyError(): void;
  notifyActivity(reason: string): void;
};
let _notifier: ActivityNotifier | null = null;
export function registerActivityNotifier(n: ActivityNotifier): void {
  _notifier = n;
}

class DedupWindow {
  private readonly _seen = new Map<string, { count: number; lastTs: number }>();
  private readonly _windowMs: number;

  constructor(windowMs = 5_000) {
    this._windowMs = windowMs;
  }

  /** Returns true if this fingerprint was seen within the window (duplicate).
   *  Side effect: records the fingerprint and increments its count. */
  isDuplicate(fp: string, ts: number): boolean {
    const entry = this._seen.get(fp);
    if (entry && ts - entry.lastTs < this._windowMs) {
      entry.count++;
      entry.lastTs = ts;
      return true;
    }
    this._seen.set(fp, { count: 1, lastTs: ts });
    if (this._seen.size > 500) {
      const cutoff = ts - this._windowMs * 2;
      for (const [k, v] of this._seen) {
        if (v.lastTs < cutoff) this._seen.delete(k);
      }
    }
    return false;
  }
}

const _dedup = new DedupWindow(5_000);

function eventFingerprint(event: BrowserEvent): string | null {
  if (event.type === 'network') {
    return `net:${event.method}:${event.url}:${event.status}`;
  }
  if (event.type === 'console' && event.level === 'error') {
    const msg = typeof event.args[0] === 'string' ? event.args[0].slice(0, 100) : '';
    return `err:${msg}`;
  }
  return null;
}

export const ingestRouter = Router();

const SHARED_SECRET = process.env.MERGEN_SECRET;

// ── Rate limiter: token-bucket, max 100 events / second ──────────────────────
// P1.3: Replaced the leaky O(n) Array.shift() approach with an O(1)
// counter+timer bucket. The bucket refills every second; no array scanning.

export class TokenBucket {
  private _count = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly limit: number = 100,
    public readonly windowMs: number = 1_000,
  ) {}

  isRateLimited(): boolean {
    if (this._count >= this.limit) return true;
    this._count++;
    if (!this._timer) {
      this._timer = setTimeout(() => {
        this._count = 0;
        this._timer = null;
      }, this.windowMs);
    }
    return false;
  }

  reset(): void {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._count = 0;
  }
}

const _bucket = new TokenBucket();

function isRateLimited(): boolean {
  return _bucket.isRateLimited();
}

// ── Sourcemap resolution timeout ──────────────────────────────────────────────
// P2.1: Guard against hung disk scans blocking the event loop indefinitely.
const SOURCEMAP_TIMEOUT_MS = 2_000;

// ── Per-field body cap (D1 — buffer-bloat hardening) ─────────────────────────
// The Express body limit is 1MB, but a single 800KB JSON response body would
// crowd out ~100 useful events. We cap each request/response body at 8KB
// before the event reaches the ring buffer. Truncated payloads keep a marker
// so the LLM knows the data was clipped and doesn't reason on partial JSON
// as if it were complete.
const MAX_BODY_BYTES = 8 * 1024;
const TRUNC_MARKER = '[…truncated by mergen]';

function clampBody(body: unknown): unknown {
  if (body == null) return body;
  if (typeof body === 'string') {
    return body.length > MAX_BODY_BYTES
      ? body.slice(0, MAX_BODY_BYTES) + ` ${TRUNC_MARKER} (+${body.length - MAX_BODY_BYTES} bytes)`
      : body;
  }
  // Objects/arrays: stringify, measure, slice. We return a string in the
  // truncated case (the schema accepts unknown), which keeps downstream code
  // single-path.
  let s: string;
  try { s = JSON.stringify(body); } catch { return TRUNC_MARKER; }
  if (s.length <= MAX_BODY_BYTES) return body;
  return s.slice(0, MAX_BODY_BYTES) + ` ${TRUNC_MARKER} (+${s.length - MAX_BODY_BYTES} bytes)`;
}

function clampNetworkBodies(event: BrowserEvent): BrowserEvent {
  if (event.type !== 'network') return event;
  return {
    ...event,
    requestBody: clampBody(event.requestBody),
    responseBody: clampBody(event.responseBody),
  };
}

// ── PII redaction (D2) ────────────────────────────────────────────────────────
// Always-on. Scrubs JWTs / Bearer tokens / emails / cards from string fields,
// and replaces sensitive object keys (Authorization, Cookie, password, …)
// with [REDACTED] before the event hits the ring buffer.
function redactEvent(event: BrowserEvent): BrowserEvent {
  if (event.type === 'network') {
    return {
      ...event,
      url: typeof event.url === 'string' ? (redact(event.url) as string) : event.url,
      requestBody: redact(event.requestBody),
      responseBody: redact(event.responseBody),
      requestHeaders: event.requestHeaders
        ? (redact(event.requestHeaders) as Record<string, string>)
        : event.requestHeaders,
      responseHeaders: event.responseHeaders
        ? (redact(event.responseHeaders) as Record<string, string>)
        : event.responseHeaders,
    };
  }
  if (event.type === 'console') {
    return { ...event, args: (redact(event.args) as unknown[]) };
  }
  if (event.type === 'context') {
    return {
      ...event,
      localStorage: redact(event.localStorage) as Record<string, string>,
      sessionStorage: redact(event.sessionStorage) as Record<string, string>,
    };
  }
  return event;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`sourcemap resolution timed out after ${ms}ms`)), ms),
    ),
  ]);
}

ingestRouter.post('/ingest', (req: Request, res: Response): void => {
  if (SHARED_SECRET && req.headers['x-mergen-secret'] !== SHARED_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (isRateLimited()) {
    res.status(429).json({ error: 'rate limit exceeded' });
    return;
  }

  const result = BrowserEventSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: 'invalid event', details: result.error.flatten() });
    return;
  }

  const event = redactEvent(clampNetworkBodies(result.data));
  const fp = eventFingerprint(event);
  if (fp && _dedup.isDuplicate(fp, event.timestamp)) {
    res.status(204).end();
    return;
  }

  // Respond immediately so the extension is never blocked on sourcemap I/O
  res.status(204).end();

  // ── Continuous diagnostic triggers ────────────────────────────────────────
  // The original product fired the causal engine ONLY on console.error.
  // That made Mergen a fire alarm. We now fire on every meaningful change so
  // it becomes a continuous watcher — see hypothesis-history.RebuildReason.
  //
  //   • console.error                → 'error'
  //   • context.trigger === 'pageload' → 'pageload' (baseline analysis)
  //   • context.trigger === 'hmr'      → 'hmr'      (post-save analysis)
  //   • network failure                → checked via burst detector below
  //   • slow request (> 500 ms)        → checked via burst detector below
  const isError =
    event.type === 'console' && event.level === 'error';
  const isPageload =
    event.type === 'context' && event.trigger === 'pageload';
  const isHmr =
    event.type === 'context' && event.trigger === 'hmr';
  const isFailedNet =
    event.type === 'network' && (event.status >= 400 || event.status === 0 || !!event.error);
  const isSlowNet =
    event.type === 'network' && event.duration > 500;

  // Burst detection: count failures / slow requests in the last 10 s window.
  // Fires once per burst — the debounce in hypothesis-history collapses
  // multiple notifications inside the 2 s window into a single rebuild.
  const burstReason = (() => {
    if (isFailedNet) {
      const window = store.getNetwork(50, undefined, Date.now() - 10_000);
      const fails = window.filter(n => n.status >= 400 || n.status === 0 || !!n.error).length;
      if (fails >= 3) return 'net_burst' as const;
    }
    if (isSlowNet) {
      const window = store.getNetwork(50, undefined, Date.now() - 10_000);
      const slow = window.filter(n => n.duration > 500).length;
      if (slow >= 3) return 'slow_burst' as const;
    }
    return null;
  });

  const triggerActivity = (): void => {
    if (!_notifier) return;
    if (isError) { _notifier.notifyError(); return; }
    if (isPageload) { _notifier.notifyActivity('pageload'); return; }
    if (isHmr)      { _notifier.notifyActivity('hmr'); return; }
    const burst = burstReason();
    if (burst)      { _notifier.notifyActivity(burst); return; }
  };

  // Layer 2: Index events for replay
  const eventId = layer2Store.indexEvent(event);

  // Layer 3: Check breakpoints and mocks
  const breakpoint = layer3Store.checkBreakpoint(event);
  if (breakpoint) {
    logger.info({ breakpoint: breakpoint.id, eventId }, 'Breakpoint hit');
  }

  // Layer 4: Record errors for history
  if (event.type === 'console' && event.level === 'error') {
    const message = event.args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    layer4Store.recordError(message, event.stack);
  }

  if (event.type === 'console' && typeof event.stack === 'string') {
    withTimeout(resolveFrameAndStack(event.stack), SOURCEMAP_TIMEOUT_MS)
      .then(({ resolvedStack, primaryFrame }) => {
        const resolved_event = {
          ...event,
          stack: resolvedStack,
          ...(primaryFrame?.gitSuspect ? { gitSuspect: primaryFrame.gitSuspect } : {}),
        };
        store.push(resolved_event);
        historyStore.push(resolved_event);
        maybeTeamBroadcast(resolved_event);
        exportToOtel(resolved_event);
      })
      .catch((err) => {
        logger.warn({ err }, 'sourcemap resolution failed or timed out, storing raw event');
        store.push(event);
        historyStore.push(event);
        maybeTeamBroadcast(event);
        exportToOtel(event);
      })
      .finally(triggerActivity);
  } else {
    store.push(event);
    historyStore.push(event);
    maybeTeamBroadcast(event);
    exportToOtel(event);
    updateTopology(event);
    triggerActivity();
  }
});

function updateTopology(event: BrowserEvent): void {
  if (event.type === 'backend_span') {
    serviceTopology.updateFromSpan(event);

    // Resolve service-to-service edges within this trace (parentSpanId links).
    const siblings = store.getBackendSpans(50).filter(s => s.traceId === event.traceId);
    if (siblings.length > 1) serviceTopology.updateFromTraceGroup(siblings);
    return;
  }

  if (event.type === 'network' && event.traceId) {
    // Look for a backend span that was instrumented on the other side of this request.
    const matchingSpan = store.getBackendSpans(50).find(s => s.traceId === event.traceId);
    if (matchingSpan) {
      serviceTopology.updateFromTraceJoin(
        event.url,
        matchingSpan.service,
        event.duration,
        event.status >= 500 || !!event.error,
        event.traceId,
        event.timestamp,
      );
    }
  }
}

// Exported for unit tests.
export { clampBody, clampNetworkBodies, MAX_BODY_BYTES };
