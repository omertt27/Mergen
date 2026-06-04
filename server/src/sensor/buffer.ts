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
  buildSha: z.string().optional(),
  /** SDK that produced this event — 'node' or 'python' for backend events. */
  sdk: z.enum(['node', 'python']).optional(),
  /** Identity of the engineer whose browser captured this event. Set once in the
   *  extension popup or auto-read from VS Code git config. Enables per-engineer
   *  filtering in team mode. */
  userId: z.string().optional(),
  /** The git commit that last touched the primary error frame — populated
   *  automatically after sourcemap resolution when a .git repo is present. */
  gitSuspect: z.object({
    sha: z.string(),
    author: z.string(),
    summary: z.string(),
  }).optional(),
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
  buildSha: z.string().optional(),
  userId: z.string().optional(),
  /** W3C traceparent or X-Trace-ID extracted from the response headers.
   *  Links browser network events to backend OTel spans across service boundaries. */
  traceId: z.string().optional(),
  /** W3C tracestate header value, preserved verbatim.
   *  Carries vendor-specific routing metadata (e.g. Datadog sampling, Lightstep flags).
   *  Required for multi-vendor trace propagation to survive service boundary crossings. */
  tracestate: z.string().optional(),
  /** W3C Baggage key-value pairs parsed from the baggage request header.
   *  Propagates custom metadata across hops: userId, deploymentEnv, featureFlags, etc.
   *  Only present when the outgoing request carried a baggage header. */
  baggage: z.record(z.string()).optional(),
});

export const ContextSnapshotSchema = z.object({
  type: z.literal('context'),
  trigger: z.enum(['error', 'warn', 'pageload', 'hmr', 'baseline', 'manual']),
  timestamp: z.number(),
  url: z.string(),
  title: z.string(),
  activeElement: z.string().optional(),
  component: z.string().optional(),
  localStorage: z.record(z.string()).default({}),
  sessionStorage: z.record(z.string()).default({}),
  // Layer 1 extensions (optional, backward-compatible)
  componentTree: z.unknown().optional(),
  stateDiff: z.unknown().optional(),
  performanceTrace: z.array(z.unknown()).optional(),
});

export const WebSocketFrameSchema = z.object({
  direction: z.enum(['sent', 'received']),
  data: z.string(),
  timestamp: z.number(),
});

export const WebSocketEventSchema = z.object({
  type: z.literal('websocket'),
  connectionId: z.string(),
  url: z.string(),
  status: z.enum(['open', 'closed', 'error']),
  code: z.number().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  frames: z.array(WebSocketFrameSchema).optional().default([]),
  timestamp: z.number(),
});

export const SSEEventSchema = z.object({
  type: z.literal('sse'),
  connectionId: z.string(),
  url: z.string(),
  status: z.enum(['open', 'error']),
  messages: z.array(z.object({
    data: z.string(),
    timestamp: z.number(),
  })).optional().default([]),
  timestamp: z.number(),
});

export const DiagnosticEventSchema = z.object({
  type: z.literal('diagnostic'),
  source: z.string(),
  file: z.string(),
  severity: z.enum(['error', 'warning', 'info', 'hint']),
  message: z.string(),
  code: z.union([z.string(), z.number()]).optional(),
  line: z.number().int(),
  column: z.number().int(),
  timestamp: z.number(),
});

export const TerminalOutputEventSchema = z.object({
  type: z.literal('terminal'),
  terminalName: z.string(),
  data: z.string(),
  timestamp: z.number(),
  /** W3C traceId (32 hex chars) extracted from the log line by the process-watcher.
   *  Present when the backend logged a traceparent header or a known trace ID key.
   *  Enables deterministic browser↔backend joins in get_unified_timeline. */
  traceId: z.string().optional(),
});

export const TestResultEventSchema = z.object({
  type: z.literal('test_result'),
  runner: z.enum(['vitest', 'jest', 'playwright', 'unknown']),
  file: z.string(),
  name: z.string(),
  status: z.enum(['pass', 'fail', 'skip', 'todo']),
  duration: z.number().optional(),
  error: z.object({
    message: z.string(),
    stack: z.string().optional(),
  }).optional(),
  timestamp: z.number(),
});

export const ProcessExitEventSchema = z.object({
  type: z.literal('process_exit'),
  process: z.string(),
  exitCode: z.number().int(),
  reason: z.enum(['oom', 'signal', 'crash', 'normal']),
  signal: z.string().optional(),
  memoryLimitBytes: z.number().optional(),
  timestamp: z.number(),
});

export const CIEventSchema = z.object({
  type: z.literal('ci'),
  provider: z.enum(['github_actions', 'gitlab_ci', 'circleci', 'jenkins', 'azure_devops', 'unknown']).default('unknown'),
  sha: z.string(),
  shortSha: z.string().optional(),
  branch: z.string().optional(),
  workflow: z.string().optional(),
  job: z.string(),
  status: z.enum(['success', 'failure', 'cancelled', 'skipped']),
  durationMs: z.number().optional(),
  url: z.string().optional(),
  failedTests: z.array(z.object({
    name: z.string(),
    error: z.string().optional(),
    file: z.string().optional(),
  })).optional().default([]),
  timestamp: z.number(),
});

export const DeploymentEventSchema = z.object({
  type: z.literal('deployment'),
  environment: z.string(),
  sha: z.string(),
  shortSha: z.string().optional(),
  version: z.string().optional(),
  service: z.string().optional(),
  status: z.enum(['started', 'success', 'failure', 'rollback']),
  url: z.string().optional(),
  actor: z.string().optional(),
  timestamp: z.number(),
});

export const BackendSpanEventSchema = z.object({
  type: z.literal('backend_span'),
  /** Service name — set via MERGEN_NAME env var or auto-detected from package.json */
  service: z.string(),
  /** Matched route pattern, e.g. "/api/users/:id" */
  route: z.string(),
  method: z.string(),
  statusCode: z.number().int(),
  durationMs: z.number(),
  /** W3C traceId (32 hex chars) — the join key linking this span to a browser network event */
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  userId: z.string().optional(),
  error: z.string().optional(),
  sdk: z.enum(['node', 'python']),
  timestamp: z.number(),
});

export const BrowserEventSchema = z.discriminatedUnion('type', [
  ConsoleEventSchema,
  NetworkEventSchema,
  ContextSnapshotSchema,
  WebSocketEventSchema,
  SSEEventSchema,
  DiagnosticEventSchema,
  TerminalOutputEventSchema,
  TestResultEventSchema,
  ProcessExitEventSchema,
  CIEventSchema,
  DeploymentEventSchema,
  BackendSpanEventSchema,
]);

export type ConsoleEvent = z.infer<typeof ConsoleEventSchema>;
export type NetworkEvent = z.infer<typeof NetworkEventSchema>;
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export type WebSocketEvent = z.infer<typeof WebSocketEventSchema>;
export type SSEEvent = z.infer<typeof SSEEventSchema>;
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;
export type TerminalOutputEvent = z.infer<typeof TerminalOutputEventSchema>;
export type TestResultEvent = z.infer<typeof TestResultEventSchema>;
export type ProcessExitEvent = z.infer<typeof ProcessExitEventSchema>;
export type CIEvent = z.infer<typeof CIEventSchema>;
export type DeploymentEvent = z.infer<typeof DeploymentEventSchema>;
export type BackendSpanEvent = z.infer<typeof BackendSpanEventSchema>;
export type WebSocketFrame = z.infer<typeof WebSocketFrameSchema>;
export type BrowserEvent = z.infer<typeof BrowserEventSchema>;

// ── Session signal ────────────────────────────────────────────────────────────
// A lightweight nudge surfaced in the VS Code panel and MCP tool descriptions.
// Signals are computed on-read from the buffer — no extra state.
//
// ⚠️  Design contract:
//   message  — must answer "what will break, and why" not just "what was detected"
//              BAD:  "Repeated network errors on /api/auth"
//              GOOD: "POST /api/auth returns 200 but token not stored → reads will get null"
//   action   — one imperative sentence the dev can act on immediately
//   confidence < MIN_SIGNAL_CONFIDENCE → suppressed entirely (no noise)
//
// Confidence bands:
//   ≥ 0.80  HIGH   — shown with warning background in panel + status bar
//   ≥ 0.55  MEDIUM — shown in panel, neutral styling
//   ≥ 0.45  LOW    — shown in panel, muted styling
//   < 0.45  →  dropped
export interface SessionSignal {
  kind: 'auth_token_not_stored' | 'repeated_network_error' | 'warn_spike'
      | 'repeated_error' | 'slow_requests' | 'auth_500' | 'storage_cleared';
  message: string;      // specific finding: "what will break and why"
  action: string;       // one imperative sentence: "what to do right now"
  count: number;        // how many events triggered this signal
  confidence: number;   // 0.0–1.0
  /** Which free MCP tool gives the first useful answer for this signal */
  suggestedTool: 'quick_check' | 'explain_warning' | 'session_summary';
}

/** Auth-related localStorage keys checked by signal detectors and causal engine. */
export const AUTH_KEYS: readonly string[] = ['token', 'userToken', 'accessToken', 'authToken', 'jwt', 'user', 'session'];

/** Regex matching auth-related URLs. */
export const AUTH_URL_RE = /login|auth|signin|token/i;

/** Minimum confidence for a signal to be surfaced. Below this the signal is noise. */
const MIN_SIGNAL_CONFIDENCE = 0.45;

// ── BufferStore interface ──────────────────────────────────────────────────────

export interface BufferCounters {
  errors: number;
  warnings: number;
  networkErrors: number;
}

export interface LocalStorageDiff {
  full: Record<string, string>;
  changed: Set<string>;
}

export interface BufferStore {
  push(event: BrowserEvent): void;
  getLogs(limit?: number, level?: LogLevel, since?: number): ConsoleEvent[];
  getNetwork(limit?: number, statusFilter?: number, since?: number): NetworkEvent[];
  getContext(limit?: number, since?: number): ContextSnapshot[];
  getWebSockets(limit?: number, connectionUrl?: string, since?: number): WebSocketEvent[];
  /** Count of distinct WebSocket connections in the buffer — used by /health. */
  getWebSocketCount(): number;
  getSSE(limit?: number, connectionUrl?: string, since?: number): SSEEvent[];
  getDiagnostics(limit?: number, severity?: DiagnosticEvent['severity'], since?: number): DiagnosticEvent[];
  getTerminalOutput(limit?: number, terminalName?: string, since?: number): TerminalOutputEvent[];
  getTestResults(limit?: number, status?: TestResultEvent['status'], since?: number): TestResultEvent[];
  getProcessExits(limit?: number, reason?: ProcessExitEvent['reason'], since?: number): ProcessExitEvent[];
  getCIEvents(limit?: number, status?: CIEvent['status'], since?: number): CIEvent[];
  getDeployments(limit?: number, environment?: string, since?: number): DeploymentEvent[];
  getBackendSpans(limit?: number, service?: string, since?: number): BackendSpanEvent[];
  /** Lightweight pattern scan — no credit cost. Used by /health and quick_check. */
  getSignals(): SessionSignal[];
  /** O(1) counters for health endpoint — no iteration needed. */
  getCounters(): BufferCounters;
  /** Returns localStorage with changed keys since last snapshot for this URL */
  getLocalStorageDiff(current: Record<string, string>, url: string): LocalStorageDiff;
  clear(): void;
  size(): number;
  /** Unix ms timestamp of the most recent event pushed, or null if empty. */
  lastEventAt(): number | null;
  /** Unix ms timestamp of the most recent clear(), or null if never cleared. */
  clearedAt(): number | null;
  /** Return all events in insertion order. Used for session persistence. */
  serialize(): BrowserEvent[];
  /** Bulk-load events (e.g. from a persisted session). Calls push() for each. */
  rehydrate(events: BrowserEvent[]): void;
}

// ── Plan-aware read limit ─────────────────────────────────────────────────────
// Free plan defines bufferSize: 50 but the ring buffer always stores 200.
// We enforce the plan limit at read time so paid upgrades take effect instantly.
// The getter is injected by index.ts after license init to avoid circular imports.
let _getEffectiveBufferSize: () => number = () => MAX_BUFFER_SIZE;

export function setBufferSizeGetter(fn: () => number): void {
  _getEffectiveBufferSize = fn;
}

// ── O(1) ring-buffer implementation ───────────────────────────────────────────
// Uses a fixed-size pre-allocated array with head + count pointers.
// push() is always O(1) — no Array.shift() / splice().

const MAX_BUFFER_SIZE = (() => {
  const env = parseInt(process.env.MERGEN_BUFFER_SIZE ?? '', 10);
  if (!Number.isFinite(env) || env < 1) return 2_000; // default raised: 200 was too small for real sessions
  return Math.min(env, 10_000);
})();
const MAX_SIZE = MAX_BUFFER_SIZE;

class RingBuffer implements BufferStore {
  private readonly _ring = new Array<BrowserEvent | undefined>(MAX_SIZE).fill(undefined);
  private _head = 0; // index of the oldest slot
  private _count = 0; // number of occupied slots

  // O(1) running counters — updated on push() and clear()
  private _errors = 0;
  private _warnings = 0;
  private _networkErrors = 0;

  // Track last localStorage snapshot per URL for diffing
  private readonly _lastLocalStorageByUrl = new Map<string, Record<string, string>>();

  private _lastEventAt: number | null = null;
  private _clearedAt: number | null = null;

  private _incrementCounters(event: BrowserEvent): void {
    if (event.type === 'console') {
      if (event.level === 'error') this._errors++;
      else if (event.level === 'warn') this._warnings++;
    } else if (event.type === 'network' && (event.status >= 400 || event.status === 0 || event.error)) {
      this._networkErrors++;
    }
  }

  private _decrementCounters(event: BrowserEvent): void {
    if (event.type === 'console') {
      if (event.level === 'error') this._errors--;
      else if (event.level === 'warn') this._warnings--;
    } else if (event.type === 'network' && (event.status >= 400 || event.status === 0 || event.error)) {
      this._networkErrors--;
    }
  }

  push(event: BrowserEvent): void {
    this._lastEventAt = event.timestamp;
    if (this._count < MAX_SIZE) {
      // Buffer has space — append normally
      const slot = (this._head + this._count) % MAX_SIZE;
      this._ring[slot] = event;
      this._count++;
      this._incrementCounters(event);
      return;
    }

    // Buffer full — priority eviction: prefer evicting console.log over
    // warnings/errors/network events so important signals survive longer.
    const isHighPriority = event.type !== 'console' || event.level !== 'log';
    let evictIdx = this._head; // default: evict oldest

    if (isHighPriority) {
      // Scan from oldest for the first low-priority (console.log) event to evict
      for (let i = 0; i < this._count; i++) {
        const idx = (this._head + i) % MAX_SIZE;
        const candidate = this._ring[idx];
        if (candidate?.type === 'console' && candidate.level === 'log') {
          evictIdx = idx;
          break;
        }
      }
    }

    const evicted = this._ring[evictIdx];
    if (evicted) this._decrementCounters(evicted);

    this._ring[evictIdx] = event;
    this._incrementCounters(event);

    // If we evicted the head slot, advance head
    if (evictIdx === this._head) {
      this._head = (this._head + 1) % MAX_SIZE;
    }
  }

  getCounters(): BufferCounters {
    return { errors: this._errors, warnings: this._warnings, networkErrors: this._networkErrors };
  }

  private *_iterate(): Iterable<BrowserEvent> {
    for (let i = 0; i < this._count; i++) {
      yield this._ring[(this._head + i) % MAX_SIZE] as BrowserEvent;
    }
  }

  getLogs(limit = 50, level?: LogLevel, since?: number): ConsoleEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: ConsoleEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'console') continue;
      if (level && e.level !== level) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getNetwork(limit = 50, statusFilter?: number, since?: number): NetworkEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: NetworkEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'network') continue;
      if (statusFilter !== undefined && e.status !== statusFilter) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getContext(limit = 10, since?: number): ContextSnapshot[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: ContextSnapshot[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'context') continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getWebSockets(limit = 50, connectionUrl?: string, since?: number): WebSocketEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: WebSocketEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'websocket') continue;
      if (connectionUrl && !e.url.includes(connectionUrl)) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getWebSocketCount(): number {
    let count = 0;
    for (const e of this._iterate()) {
      if (e.type === 'websocket') count++;
    }
    return count;
  }

  getSSE(limit = 50, connectionUrl?: string, since?: number): SSEEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: SSEEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'sse') continue;
      if (connectionUrl && !e.url.includes(connectionUrl)) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getDiagnostics(limit = 50, severity?: DiagnosticEvent['severity'], since?: number): DiagnosticEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: DiagnosticEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'diagnostic') continue;
      if (severity && e.severity !== severity) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getTerminalOutput(limit = 50, terminalName?: string, since?: number): TerminalOutputEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: TerminalOutputEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'terminal') continue;
      if (terminalName && e.terminalName !== terminalName) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getTestResults(limit = 50, status?: TestResultEvent['status'], since?: number): TestResultEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: TestResultEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'test_result') continue;
      if (status && e.status !== status) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getProcessExits(limit = 50, reason?: ProcessExitEvent['reason'], since?: number): ProcessExitEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: ProcessExitEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'process_exit') continue;
      if (reason && e.reason !== reason) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getCIEvents(limit = 50, status?: CIEvent['status'], since?: number): CIEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: CIEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'ci') continue;
      if (status && e.status !== status) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getDeployments(limit = 50, environment?: string, since?: number): DeploymentEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: DeploymentEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'deployment') continue;
      if (environment && e.environment !== environment) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getBackendSpans(limit = 50, service?: string, since?: number): BackendSpanEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: BackendSpanEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'backend_span') continue;
      if (service && e.service !== service) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  clear(): void {
    this._ring.fill(undefined);
    this._head = 0;
    this._count = 0;
    this._errors = 0;
    this._warnings = 0;
    this._networkErrors = 0;
    this._lastLocalStorageByUrl.clear();
    this._lastEventAt = null;
    this._clearedAt = Date.now();
  }

  getLocalStorageDiff(current: Record<string, string>, url: string): LocalStorageDiff {
    const prev = this._lastLocalStorageByUrl.get(url) || {};
    const changed = new Set<string>();

    // Find changed or new keys
    for (const [key, val] of Object.entries(current)) {
      if (prev[key] !== val) {
        changed.add(key);
      }
    }

    // Find deleted keys
    for (const key of Object.keys(prev)) {
      if (!(key in current)) {
        changed.add(key);
      }
    }

    // Update tracking
    this._lastLocalStorageByUrl.set(url, { ...current });

    return { full: current, changed };
  }

  getSignals(): SessionSignal[] {
    const candidates: SessionSignal[] = [];
    const logs     = this.getLogs(200);
    const network  = this.getNetwork(200);
    const contexts = this.getContext(20);

    // Latest storage snapshot — used by cross-correlation detectors below.
    const latestCtx = contexts.length > 0
      ? contexts[contexts.length - 1]
      : null;
    const ls = latestCtx?.localStorage ?? {};

    // ── S1: Auth endpoint succeeds but token not stored ───────────────────────
    // Cross-correlation: POST auth/login/signin → 200, but token keys absent/null
    // in the most recent storage snapshot. This is the #1 real-world conversion
    // bug — surfaces it before it ever throws an error.
    const authOk = network.filter((n) => AUTH_URL_RE.test(n.url) && n.status === 200);
    if (authOk.length > 0 && latestCtx) {
      const missingKeys = AUTH_KEYS.filter(
        (k) => !(k in ls) || ls[k] === 'null' || ls[k] === '' || ls[k] === 'undefined',
      );
      if (missingKeys.length > 0) {
        const call = authOk[authOk.length - 1]; // most recent
        const key  = missingKeys[0];
        // Higher confidence when there are also errors in the buffer
        const hasErrors = logs.some((e) => e.level === 'error');
        const confidence = hasErrors ? 0.90 : 0.72;
        candidates.push({
          kind: 'auth_token_not_stored',
          message: `${call.method} ${call.url} → 200 but \`localStorage.${key}\` is null — reads will get null`,
          action: `Check the ${call.url} response handler: call \`localStorage.setItem('${key}', ...)\` before navigating away`,
          count: authOk.length,
          confidence,
          suggestedTool: 'quick_check',
        });
      }
    }

    // ── S2: Auth endpoint returning 4xx/5xx ───────────────────────────────────
    // Any auth/login call failing hard — not just slow, actually erroring.
    // Immediately actionable: the URL and status are in the message.
    const authFail = network.filter(
      (n) => AUTH_URL_RE.test(n.url) && (n.status >= 400 || n.status === 0 || !!n.error),
    );
    for (const call of authFail) {
      const label = call.status === 0
        ? `network error (${call.error ?? 'no response'})`
        : `HTTP ${call.status}`;
      const confidence = call.status >= 500 || call.status === 0 ? 0.85 : 0.65;
      candidates.push({
        kind: 'auth_500',
        message: `${call.method} ${call.url} failed with ${label} — users cannot log in`,
        action: `Check the server logs for ${call.url} — ${call.status >= 500 ? 'server-side error' : 'client sent bad request'}`,
        count: 1,
        confidence,
        suggestedTool: 'quick_check',
      });
    }

    // ── S3: Storage keys reset to null between snapshots ─────────────────────
    // Two or more context snapshots, and a key that was set is now null.
    // Pattern: something is clearing state (logout, navigation, bug).
    if (contexts.length >= 2) {
      const prev = contexts[contexts.length - 2].localStorage;
      const curr = ls;
      const clearedKeys = Object.keys(prev).filter(
        (k) => prev[k] && prev[k] !== 'null' && prev[k] !== 'undefined'
              && (!(k in curr) || curr[k] === 'null' || curr[k] === '' || curr[k] === 'undefined'),
      );
      if (clearedKeys.length > 0) {
        const key = clearedKeys[0];
        const confidence = AUTH_KEYS.includes(key) ? 0.80 : 0.55;
        candidates.push({
          kind: 'storage_cleared',
          message: `\`localStorage.${key}\` was set, then cleared between page events — may cause null-read crash`,
          action: `Find where \`localStorage.removeItem('${key}')\` or \`localStorage.clear()\` is called and guard it`,
          count: clearedKeys.length,
          confidence,
          suggestedTool: 'quick_check',
        });
      }
    }

    // ── S4: Repeated network errors — same URL failing 3+ times ─────────────
    // Kept but message is now specific: includes URL, status, and implication.
    const netErrUrls = new Map<string, { count: number; status: number; error: string | null | undefined }>();
    for (const n of network) {
      if (n.status >= 400 || n.status === 0 || n.error) {
        const prev = netErrUrls.get(n.url);
        netErrUrls.set(n.url, {
          count: (prev?.count ?? 0) + 1,
          status: n.status,
          error: n.error,
        });
      }
    }
    for (const [url, { count, status, error }] of netErrUrls) {
      if (count >= 3) {
        // Skip if already covered by S2 (auth failure)
        if (AUTH_URL_RE.test(url)) continue;
        const label = status === 0 ? `network error (${error ?? 'no response'})` : `HTTP ${status}`;
        const confidence = Math.min(0.88, 0.50 + (count - 3) * 0.08);
        candidates.push({
          kind: 'repeated_network_error',
          message: `${url} failing ${count}× with ${label} — dependent state will be uninitialised`,
          action: `Guard every read of the response data with a null/error check, or retry with back-off`,
          count,
          confidence,
          suggestedTool: 'quick_check',
        });
      }
    }

    // ── S5: Warning spike — 5+ warnings ──────────────────────────────────────
    // Message now includes the first unique warning text so it's not generic.
    const warnEvents = logs.filter((e) => e.level === 'warn');
    if (warnEvents.length >= 5) {
      const firstMsg = warnEvents[0].args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 80);
      const confidence = Math.min(0.75, 0.45 + (warnEvents.length - 5) * 0.04);
      candidates.push({
        kind: 'warn_spike',
        message: `${warnEvents.length} warnings — e.g. "${firstMsg}" — may escalate to crash`,
        action: `Run explain_warning on the first warning to understand the escalation path`,
        count: warnEvents.length,
        confidence,
        suggestedTool: 'explain_warning',
      });
    }

    // ── S6: Repeated identical errors ────────────────────────────────────────
    // Message includes the actual error text — not just "recurring error".
    const errMsgs = new Map<string, number>();
    for (const e of logs.filter((l) => l.level === 'error')) {
      const msg = e.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 100);
      errMsgs.set(msg, (errMsgs.get(msg) ?? 0) + 1);
    }
    for (const [msg, count] of errMsgs) {
      if (count >= 3) {
        const confidence = Math.min(0.92, 0.62 + (count - 3) * 0.08);
        candidates.push({
          kind: 'repeated_error',
          message: `"${msg}" — thrown ${count}× — not a one-off, it's a code path bug`,
          action: `Use analyze_runtime to find the root cause — this error fires on every execution of a specific path`,
          count,
          confidence,
          suggestedTool: 'quick_check',
        });
      }
    }

    // ── S7: Slow requests ────────────────────────────────────────────────────
    // Message names the slowest endpoint, not just a count.
    const slowReqs = network.filter((n) => n.duration > 2000)
      .sort((a, b) => b.duration - a.duration);
    if (slowReqs.length >= 3) {
      const worst = slowReqs[0];
      const confidence = Math.min(0.72, 0.45 + (slowReqs.length - 3) * 0.04);
      candidates.push({
        kind: 'slow_requests',
        message: `${slowReqs.length} slow requests — worst: ${worst.method} ${worst.url} (${worst.duration}ms) — may cause race conditions`,
        action: `Run session_summary to see all slow endpoints, then check for sequential fetches that could run in parallel`,
        count: slowReqs.length,
        confidence,
        suggestedTool: 'session_summary',
      });
    }

    // Suppress weak signals; sort high-confidence first; deduplicate by kind
    // (take the highest-confidence signal per kind to avoid flooding the panel)
    const seen = new Set<string>();
    return candidates
      .filter((s) => s.confidence >= MIN_SIGNAL_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)
      .filter((s) => {
        if (seen.has(s.kind)) return false;
        seen.add(s.kind);
        return true;
      });
  }

  size(): number {
    return this._count;
  }

  serialize(): BrowserEvent[] {
    return Array.from(this._iterate());
  }

  rehydrate(events: BrowserEvent[]): void {
    for (const event of events) this.push(event);
  }

  lastEventAt(): number | null { return this._lastEventAt; }
  clearedAt(): number | null { return this._clearedAt; }
}

export const store: BufferStore = new RingBuffer();
