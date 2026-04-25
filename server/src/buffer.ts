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
  trigger: z.enum(['error']),
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

// ── BufferStore interface ──────────────────────────────────────────────────────

export interface BufferStore {
  push(event: BrowserEvent): void;
  getLogs(limit?: number, level?: LogLevel, since?: number): ConsoleEvent[];
  getNetwork(limit?: number, statusFilter?: number, since?: number): NetworkEvent[];
  getContext(limit?: number, since?: number): ContextSnapshot[];
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

  size(): number {
    return this._count;
  }
}

export const store: BufferStore = new RingBuffer();
