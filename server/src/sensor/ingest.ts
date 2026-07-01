import { Request, Response, Router } from 'express';
import { timingSafeSecretEqualAny } from './security-utils.js';
import type {} from './cloud-auth.js';
import { store, BrowserEventSchema, type BrowserEvent } from './buffer.js';
import { resolveFrameAndStack } from './sourcemap.js';
import { redact } from './redact.js';
import logger from './logger.js';
import type { BlunderType } from './agent-blunder-store.js';
import { getStores } from '../storage/store-registry.js';
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

  reset(): void {
    this._seen.clear();
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

// ── Per-tenant rate buckets (cloud mode) ──────────────────────────────────────
// In cloud mode, each tenant gets an independent token bucket so one noisy
// tenant cannot starve incident analysis for others. In local mode the global
// bucket below is used instead.
const _tenantBuckets = new Map<string, TokenBucket>();

function getTenantBucket(tenantId: string): TokenBucket {
  let bucket = _tenantBuckets.get(tenantId);
  if (!bucket) {
    bucket = new TokenBucket(100, 1_000);
    _tenantBuckets.set(tenantId, bucket);
  }
  return bucket;
}

/**
 * Build the /ingest router.
 *
 * @param localSecret - The server's local shared secret (from ~/.mergen/secret or
 *   MERGEN_SECRET env var). Always required; an event without a valid
 *   x-mergen-secret header is rejected with 401.
 */
export function createIngestRouter(localSecret: string): Router {
  const router = Router();
  // Prefer the explicitly configured MERGEN_SECRET for backwards-compat; fall
  // back to the auto-generated localSecret so auth is always enforced.
  const effectiveSecret = process.env.MERGEN_SECRET ?? localSecret;

  router.post('/ingest', async (req: Request, res: Response): Promise<void> => {
    if (!timingSafeSecretEqualAny(req.headers['x-mergen-secret'], effectiveSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // Per-tenant rate limiting in cloud mode; global bucket otherwise.
    const tenantId = req.tenantId;
    const limited  = tenantId
      ? getTenantBucket(tenantId).isRateLimited()
      : _bucket.isRateLimited();
    if (limited) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const result = BrowserEventSchema.safeParse(req.body);
    if (!result.success) {
      if (req.body && req.body.type === 'blunder') {
        const { id, recordedAt, blunderType, command, blockReason, service, tag, actor, pid, confidenceScore } = req.body;
        if (typeof blunderType !== 'string' || typeof blockReason !== 'string' || typeof actor !== 'string') {
          res.status(400).json({ error: 'invalid blunder event fields' });
          return;
        }
        try {
          await getStores().blunders.record({
            id: typeof id === 'string' ? id : undefined,
            recordedAt: typeof recordedAt === 'number' ? recordedAt : undefined,
            blunderType: blunderType as BlunderType,
            command: typeof command === 'string' ? command : null,
            blockReason,
            service: typeof service === 'string' ? service : null,
            tag: typeof tag === 'string' ? tag : null,
            actor,
            pid: typeof pid === 'string' ? pid : null,
            confidenceScore: typeof confidenceScore === 'number' ? confidenceScore : null,
          });
          res.status(204).end();
          return;
        } catch (err) {
          logger.warn({ err }, 'ingest: failed to record blunder');
          res.status(500).json({ error: 'failed to record blunder' });
          return;
        }
      }
      res.status(400).json({ error: 'invalid event', details: result.error.flatten() });
      return;
    }

    // Reject events with timestamps that are unreasonably far in the future.
    const tsFutureMs = result.data.timestamp - Date.now();
    if (tsFutureMs > 10 * 60 * 1_000) {
      // BrowserEvent is a union — not all members have `url`, so we use 'in' narrowing.
      const eventUrl = 'url' in result.data ? result.data.url : undefined;
      logger.warn({ tsFutureMs, url: eventUrl }, 'ingest: event timestamp is too far in the future — rejected');
      res.status(400).json({ error: 'event timestamp too far in the future' });
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

    _processEvent(event, req.tenantId);
  });

  return router;
}

// ── Legacy named export (backwards compat for any imports not yet updated) ────
// Will be removed in a future version. Prefer createIngestRouter(secret).
export const ingestRouter = Router();

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

/** Resets rate-limiter and dedup state. Call in test beforeEach to isolate tests. */
export function resetForTesting(): void {
  _bucket.reset();
  _dedup.reset();
}

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

// ── Shared event processing ───────────────────────────────────────────────────
// Extracted so both createIngestRouter and any future ingest paths share one
// implementation without duplicating the burst-detection / layer logic.
function _processEvent(event: BrowserEvent, tenantId: string | undefined): void {
  const isError    = event.type === 'console' && event.level === 'error';
  const isPageload = event.type === 'context' && event.trigger === 'pageload';
  const isHmr      = event.type === 'context' && event.trigger === 'hmr';
  const isFailedNet = event.type === 'network' && (event.status >= 400 || event.status === 0 || !!event.error);
  const isSlowNet   = event.type === 'network' && event.duration > 500;

  const burstReason = (): 'net_burst' | 'slow_burst' | null => {
    if (isFailedNet) {
      const w = store.getNetwork(50, undefined, Date.now() - 10_000);
      if (w.filter(n => n.status >= 400 || n.status === 0 || !!n.error).length >= 3) return 'net_burst';
    }
    if (isSlowNet) {
      const w = store.getNetwork(50, undefined, Date.now() - 10_000);
      if (w.filter(n => n.duration > 500).length >= 3) return 'slow_burst';
    }
    return null;
  };

  const triggerActivity = (): void => {
    if (!_notifier) return;
    if (isError)    { _notifier.notifyError();              return; }
    if (isPageload) { _notifier.notifyActivity('pageload'); return; }
    if (isHmr)      { _notifier.notifyActivity('hmr');      return; }
    const burst = burstReason();
    if (burst)      { _notifier.notifyActivity(burst);      return; }
  };

  // Layer 2: Index events for replay
  const eventId = layer2Store.indexEvent(event);

  // Layer 3: Check breakpoints and mocks
  const breakpoint = layer3Store.checkBreakpoint(event);
  if (breakpoint) logger.info({ breakpoint: breakpoint.id, eventId }, 'Breakpoint hit');

  // Layer 4: Record errors for history
  if (event.type === 'console' && event.level === 'error') {
    const message = event.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
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
        store.push(resolved_event, tenantId);
        historyStore.push(resolved_event);
        maybeTeamBroadcast(resolved_event);
        exportToOtel(resolved_event);
      })
      .catch((err) => {
        logger.warn({ err }, 'sourcemap resolution failed or timed out, storing raw event');
        store.push(event, tenantId);
        historyStore.push(event);
        maybeTeamBroadcast(event);
        exportToOtel(event);
      })
      .finally(triggerActivity);
  } else {
    store.push(event, tenantId);
    historyStore.push(event);
    maybeTeamBroadcast(event);
    exportToOtel(event);
    updateTopology(event);
    triggerActivity();
  }
}

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
