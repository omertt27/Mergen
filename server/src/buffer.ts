import { z } from 'zod';

// ── Zod schemas ───────────────────────────────────────────────────────────────

export const LogLevelSchema = z.enum(['log', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const ConsoleEventSchema = z.object({
  type: z.literal('console'),
  level: LogLevelSchema,
  args: z.array(z.unknown()),
  stack: z.string().optional(),
  url: z.string(),
  timestamp: z.number(),
});

export const NetworkEventSchema = z.object({
  type: z.literal('network'),
  method: z.string(),
  url: z.string(),
  status: z.number().int(),
  statusText: z.string(),
  duration: z.number(),
  requestBody: z.unknown().optional(),
  requestHeaders: z.record(z.string()).optional(),
  responseBody: z.unknown().optional(),
  responseHeaders: z.record(z.string()).optional(),
  error: z.string().optional(),
  timestamp: z.number(),
});

export const ContextSnapshotSchema = z.object({
  type: z.literal('context'),
  trigger: z.enum(['error', 'warn']),
  timestamp: z.number(),
  url: z.string(),
  title: z.string(),
  activeElement: z.string().optional(),
  component: z.string().optional(),
  localStorage: z.record(z.string()).default({}),
  sessionStorage: z.record(z.string()).default({}),
});

export const BrowserEventSchema = z.discriminatedUnion('type', [
  ConsoleEventSchema,
  NetworkEventSchema,
  ContextSnapshotSchema,
]);

export type ConsoleEvent = z.infer<typeof ConsoleEventSchema>;
export type NetworkEvent = z.infer<typeof NetworkEventSchema>;
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export type BrowserEvent = z.infer<typeof BrowserEventSchema>;

// ── Session signal ────────────────────────────────────────────────────────────
// A lightweight nudge surfaced in the VS Code panel and MCP tool descriptions.
// Signals are computed on-read from the buffer — no extra state.
//
// Confidence (0–1) prevents noisy nudges:
//   < 0.45  →  suppressed (not returned)
//   0.45–0.69 → LOW — shown, no button
//   0.70–0.89 → MEDIUM — shown with action hint
//   ≥ 0.90  → HIGH — shown prominently
export interface SessionSignal {
  kind: 'repeated_network_error' | 'warn_spike' | 'repeated_error' | 'slow_requests';
  message: string;      // one-sentence human description
  count: number;        // how many events triggered this signal
  confidence: number;   // 0.0–1.0; signals below MIN_SIGNAL_CONFIDENCE are suppressed
  /** Which free MCP tool gives the first useful answer for this signal */
  suggestedTool: 'quick_check' | 'explain_warning' | 'session_summary';
}

/** Minimum confidence for a signal to be surfaced. Below this the signal is noise. */
const MIN_SIGNAL_CONFIDENCE = 0.45;

// ── BufferStore interface ──────────────────────────────────────────────────────

export interface BufferStore {
  push(event: BrowserEvent): void;
  getLogs(limit?: number, level?: LogLevel, since?: number): ConsoleEvent[];
  getNetwork(limit?: number, statusFilter?: number, since?: number): NetworkEvent[];
  getContext(limit?: number, since?: number): ContextSnapshot[];
  /** Lightweight pattern scan — no credit cost. Used by /health and quick_check. */
  getSignals(): SessionSignal[];
  clear(): void;
  size(): number;
}

// ── O(1) ring-buffer implementation ───────────────────────────────────────────
// Uses a fixed-size pre-allocated array with head + count pointers.
// push() is always O(1) — no Array.shift() / splice().

const MAX_SIZE = 200;

class RingBuffer implements BufferStore {
  private readonly _ring = new Array<BrowserEvent | undefined>(MAX_SIZE).fill(undefined);
  private _head = 0; // index of the oldest slot
  private _count = 0; // number of occupied slots

  push(event: BrowserEvent): void {
    const slot = (this._head + this._count) % MAX_SIZE;
    this._ring[slot] = event;
    if (this._count < MAX_SIZE) {
      this._count++;
    } else {
      // Buffer full: overwrite the oldest slot and advance head
      this._head = (this._head + 1) % MAX_SIZE;
    }
  }

  private *_iterate(): Iterable<BrowserEvent> {
    for (let i = 0; i < this._count; i++) {
      yield this._ring[(this._head + i) % MAX_SIZE] as BrowserEvent;
    }
  }

  getLogs(limit = 50, level?: LogLevel, since?: number): ConsoleEvent[] {
    const results: ConsoleEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'console') continue;
      if (level && e.level !== level) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-limit);
  }

  getNetwork(limit = 50, statusFilter?: number, since?: number): NetworkEvent[] {
    const results: NetworkEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'network') continue;
      if (statusFilter !== undefined && e.status !== statusFilter) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-limit);
  }

  getContext(limit = 10, since?: number): ContextSnapshot[] {
    const results: ContextSnapshot[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'context') continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-limit);
  }

  clear(): void {
    this._ring.fill(undefined);
    this._head = 0;
    this._count = 0;
  }

  getSignals(): SessionSignal[] {
    const candidates: SessionSignal[] = [];
    const logs    = this.getLogs(200);
    const network = this.getNetwork(200);

    // ── Repeated network errors — same URL failing 3+ times ──────────────────
    // Confidence scales with count: 3 hits = 0.55, 5+ = 0.80, 8+ = 0.95
    const netErrUrls = new Map<string, number>();
    for (const n of network) {
      if (n.status >= 400 || n.status === 0 || n.error) {
        netErrUrls.set(n.url, (netErrUrls.get(n.url) ?? 0) + 1);
      }
    }
    for (const [url, count] of netErrUrls) {
      if (count >= 3) {
        const confidence = Math.min(0.95, 0.45 + (count - 3) * 0.10);
        candidates.push({
          kind: 'repeated_network_error',
          message: `Repeated ${count}× failure on ${url}`,
          count,
          confidence,
          suggestedTool: 'quick_check',
        });
      }
    }

    // ── Warning spike — 5+ warnings ──────────────────────────────────────────
    // Low baseline — warnings alone don't guarantee a crash, but 10+ is notable
    const warns = logs.filter((e) => e.level === 'warn').length;
    if (warns >= 5) {
      const confidence = Math.min(0.80, 0.45 + (warns - 5) * 0.05);
      candidates.push({
        kind: 'warn_spike',
        message: `${warns} warnings in buffer — possible pre-crash state`,
        count: warns,
        confidence,
        suggestedTool: 'explain_warning',
      });
    }

    // ── Repeated identical errors — same message 3+ times ────────────────────
    // High confidence because deterministic repetition almost always = code bug
    const errMsgs = new Map<string, number>();
    for (const e of logs.filter((l) => l.level === 'error')) {
      const msg = e.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 120);
      errMsgs.set(msg, (errMsgs.get(msg) ?? 0) + 1);
    }
    for (const [msg, count] of errMsgs) {
      if (count >= 3) {
        const confidence = Math.min(0.95, 0.60 + (count - 3) * 0.08);
        candidates.push({
          kind: 'repeated_error',
          message: `"${msg}" fired ${count}× — recurring error`,
          count,
          confidence,
          suggestedTool: 'quick_check',
        });
      }
    }

    // ── Slow requests — 3+ requests over 2s ──────────────────────────────────
    // Medium confidence — might be external service latency, not a code bug
    const slowReqs = network.filter((n) => n.duration > 2000);
    if (slowReqs.length >= 3) {
      const confidence = Math.min(0.75, 0.45 + (slowReqs.length - 3) * 0.05);
      candidates.push({
        kind: 'slow_requests',
        message: `${slowReqs.length} requests >2s — possible waterfall or blocking fetch`,
        count: slowReqs.length,
        confidence,
        suggestedTool: 'session_summary',
      });
    }

    // Suppress weak signals; sort high-confidence first
    return candidates
      .filter((s) => s.confidence >= MIN_SIGNAL_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence);
  }

  size(): number {
    return this._count;
  }
}

export const store: BufferStore = new RingBuffer();
