// All Zod schemas and inferred types live in buffer-schemas.ts.
// Re-exported here so existing imports from buffer.ts continue to work unchanged.
export {
  LogLevelSchema,
  ConsoleEventSchema, NetworkEventSchema, ContextSnapshotSchema,
  WebSocketFrameSchema, WebSocketEventSchema, SSEEventSchema,
  DiagnosticEventSchema, TerminalOutputEventSchema, TestResultEventSchema,
  ProcessExitEventSchema, CIEventSchema, DeploymentEventSchema,
  BackendSpanEventSchema, BrowserEventSchema,
} from './buffer-schemas.js';
export type {
  LogLevel,
  ConsoleEvent, NetworkEvent, ContextSnapshot,
  WebSocketFrame, WebSocketEvent, SSEEvent,
  DiagnosticEvent, TerminalOutputEvent, TestResultEvent,
  ProcessExitEvent, CIEvent, DeploymentEvent,
  BackendSpanEvent, BrowserEvent,
} from './buffer-schemas.js';
import type {
  LogLevel, ConsoleEvent, NetworkEvent, ContextSnapshot,
  WebSocketEvent, SSEEvent, DiagnosticEvent,
  TerminalOutputEvent, TestResultEvent, ProcessExitEvent,
  CIEvent, DeploymentEvent, BackendSpanEvent, BrowserEvent,
} from './buffer-schemas.js';

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

export interface BlastRadiusReport {
  /** Unique browser sessions (sessionId) that saw at least one matching error. */
  affectedSessions: number;
  /** Unique authenticated users (userId) — subset of sessions with identity set. */
  affectedUsers: number;
  /** Users who appeared in more than one session during the window (multi-tab openers).
   *  affectedSessions - returningUserSessions ≈ deduplicated session count. */
  returningUserSessions: number;
  /** Total error event count in the window. */
  errorCount: number;
  /** Unix ms of the earliest matching error. */
  firstSeenAt: number | null;
  /** Unix ms of the most recent matching error. */
  lastSeenAt: number | null;
  /** Browser breakdown — { 'Safari': 847, 'Chrome': 12 }. */
  browserSegments: Record<string, number>;
  /** OS breakdown — { 'iOS': 301, 'macOS': 546 }. */
  osSegments: Record<string, number>;
  /** Top distinct error messages with counts. */
  topErrors: Array<{ message: string; count: number }>;
  /** SHA of the deploy event closest (and prior) to firstSeenAt, if one exists. */
  correlatedDeploy: string | null;
  /** How long the error has been active (ms from firstSeenAt to now). */
  durationMs: number | null;
}

export interface LocalStorageDiff {
  full: Record<string, string>;
  changed: Set<string>;
}

// ── Tenant context ────────────────────────────────────────────────────────────
// In cloud mode (MERGEN_CLOUD_MODE=true) each dedicated server instance sets
// MERGEN_DEFAULT_TENANT_ID so MCP tools (which have no HTTP context) still
// query the correct tenant's events. HTTP routes pass req.tenantId explicitly.
export function getDefaultTenantId(): string | undefined {
  return process.env.MERGEN_DEFAULT_TENANT_ID ?? undefined;
}

export interface BufferStore {
  /** Tag the event with tenantId for cloud-mode isolation. Undefined = local mode (no filtering). */
  push(event: BrowserEvent, tenantId?: string): void;
  getLogs(limit?: number, level?: LogLevel, since?: number, tenantId?: string): ConsoleEvent[];
  getNetwork(limit?: number, statusFilter?: number, since?: number, tenantId?: string): NetworkEvent[];
  /** Aggregate blast radius for matching errors in the time window. */
  getBlastRadius(opts?: { since?: number; errorPattern?: string; tenantId?: string }): BlastRadiusReport;
  getContext(limit?: number, since?: number, tenantId?: string): ContextSnapshot[];
  getWebSockets(limit?: number, connectionUrl?: string, since?: number, tenantId?: string): WebSocketEvent[];
  /** Count of distinct WebSocket connections in the buffer — used by /health. */
  getWebSocketCount(tenantId?: string): number;
  getSSE(limit?: number, connectionUrl?: string, since?: number, tenantId?: string): SSEEvent[];
  getDiagnostics(limit?: number, severity?: DiagnosticEvent['severity'], since?: number, tenantId?: string): DiagnosticEvent[];
  getTerminalOutput(limit?: number, terminalName?: string, since?: number, tenantId?: string): TerminalOutputEvent[];
  getTestResults(limit?: number, status?: TestResultEvent['status'], since?: number, tenantId?: string): TestResultEvent[];
  getProcessExits(limit?: number, reason?: ProcessExitEvent['reason'], since?: number, tenantId?: string): ProcessExitEvent[];
  getCIEvents(limit?: number, status?: CIEvent['status'], since?: number, tenantId?: string): CIEvent[];
  getDeployments(limit?: number, environment?: string, since?: number, tenantId?: string): DeploymentEvent[];
  getBackendSpans(limit?: number, service?: string, since?: number, tenantId?: string): BackendSpanEvent[];
  /** Lightweight pattern scan — no credit cost. Used by /health and quick_check. */
  getSignals(tenantId?: string): SessionSignal[];
  /** O(1) counters for health endpoint — no iteration needed. */
  getCounters(tenantId?: string): BufferCounters;
  /** Returns localStorage with changed keys since last snapshot for this URL */
  getLocalStorageDiff(current: Record<string, string>, url: string): LocalStorageDiff;
  clear(tenantId?: string): void;
  size(tenantId?: string): number;
  /** Unix ms timestamp of the most recent event pushed, or null if empty. */
  lastEventAt(tenantId?: string): number | null;
  /** Unix ms timestamp of the most recent clear(), or null if never cleared. */
  clearedAt(): number | null;
  /** Return all events in insertion order. Used for session persistence. */
  serialize(tenantId?: string): BrowserEvent[];
  /** Bulk-load events (e.g. from a persisted session). Calls push() for each. */
  rehydrate(events: BrowserEvent[], tenantId?: string): void;
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

  push(event: BrowserEvent, tenantId?: string): void {
    if (tenantId !== undefined) (event as any)._tenantId = tenantId;
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

  getCounters(tenantId?: string): BufferCounters {
    if (tenantId === undefined) {
      return { errors: this._errors, warnings: this._warnings, networkErrors: this._networkErrors };
    }
    let errors = 0, warnings = 0, networkErrors = 0;
    for (const e of this._iterate()) {
      if ((e as any)._tenantId !== tenantId) continue;
      if (e.type === 'console') {
        if (e.level === 'error') errors++;
        else if (e.level === 'warn') warnings++;
      } else if (e.type === 'network' && (e.status >= 400 || e.status === 0 || e.error)) {
        networkErrors++;
      }
    }
    return { errors, warnings, networkErrors };
  }

  private *_iterate(): Iterable<BrowserEvent> {
    for (let i = 0; i < this._count; i++) {
      yield this._ring[(this._head + i) % MAX_SIZE] as BrowserEvent;
    }
  }

  getLogs(limit = 50, level?: LogLevel, since?: number, tenantId?: string): ConsoleEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: ConsoleEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'console') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (level && e.level !== level) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getNetwork(limit = 50, statusFilter?: number, since?: number, tenantId?: string): NetworkEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: NetworkEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'network') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (statusFilter !== undefined && e.status !== statusFilter) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getContext(limit = 10, since?: number, tenantId?: string): ContextSnapshot[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: ContextSnapshot[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'context') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getWebSockets(limit = 50, connectionUrl?: string, since?: number, tenantId?: string): WebSocketEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: WebSocketEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'websocket') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (connectionUrl && !e.url.includes(connectionUrl)) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getWebSocketCount(tenantId?: string): number {
    let count = 0;
    for (const e of this._iterate()) {
      if (e.type !== 'websocket') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      count++;
    }
    return count;
  }

  getSSE(limit = 50, connectionUrl?: string, since?: number, tenantId?: string): SSEEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: SSEEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'sse') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (connectionUrl && !e.url.includes(connectionUrl)) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getDiagnostics(limit = 50, severity?: DiagnosticEvent['severity'], since?: number, tenantId?: string): DiagnosticEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: DiagnosticEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'diagnostic') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (severity && e.severity !== severity) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getTerminalOutput(limit = 50, terminalName?: string, since?: number, tenantId?: string): TerminalOutputEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: TerminalOutputEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'terminal') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (terminalName && e.terminalName !== terminalName) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getTestResults(limit = 50, status?: TestResultEvent['status'], since?: number, tenantId?: string): TestResultEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: TestResultEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'test_result') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (status && e.status !== status) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getProcessExits(limit = 50, reason?: ProcessExitEvent['reason'], since?: number, tenantId?: string): ProcessExitEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: ProcessExitEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'process_exit') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (reason && e.reason !== reason) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getCIEvents(limit = 50, status?: CIEvent['status'], since?: number, tenantId?: string): CIEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: CIEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'ci') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (status && e.status !== status) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getDeployments(limit = 50, environment?: string, since?: number, tenantId?: string): DeploymentEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: DeploymentEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'deployment') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (environment && e.environment !== environment) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getBackendSpans(limit = 50, service?: string, since?: number, tenantId?: string): BackendSpanEvent[] {
    const cap = Math.min(limit, _getEffectiveBufferSize());
    const results: BackendSpanEvent[] = [];
    for (const e of this._iterate()) {
      if (e.type !== 'backend_span') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (service && e.service !== service) continue;
      if (since !== undefined && e.timestamp < since) continue;
      results.push(e);
    }
    return results.slice(-cap);
  }

  getBlastRadius(opts: { since?: number; errorPattern?: string; tenantId?: string } = {}): BlastRadiusReport {
    const { since, errorPattern, tenantId } = opts;
    const patternRe = errorPattern ? new RegExp(errorPattern, 'i') : null;

    const sessions = new Set<string>();
    const users    = new Set<string>();
    // Map: userId → Set of sessionIds — detects multi-tab same user
    const userSessions = new Map<string, Set<string>>();
    const browserCounts: Record<string, number> = {};
    const osCounts: Record<string, number>      = {};
    const errorMsgCounts: Record<string, number> = {};
    let firstSeenAt: number | null = null;
    let lastSeenAt: number | null  = null;
    let errorCount = 0;

    for (const e of this._iterate()) {
      if (e.type !== 'console' || e.level !== 'error') continue;
      if (tenantId !== undefined && (e as any)._tenantId !== tenantId) continue;
      if (since !== undefined && e.timestamp < since) continue;

      if (patternRe) {
        const msgText = e.args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ');
        if (!patternRe.test(msgText)) continue;
      }

      errorCount++;
      if (firstSeenAt === null || e.timestamp < firstSeenAt) firstSeenAt = e.timestamp;
      if (lastSeenAt === null  || e.timestamp > lastSeenAt)  lastSeenAt  = e.timestamp;

      if (e.sessionId) sessions.add(e.sessionId);
      if (e.userId) {
        users.add(e.userId);
        // Track which sessions each userId appears in
        if (e.sessionId) {
          let set = userSessions.get(e.userId);
          if (!set) { set = new Set(); userSessions.set(e.userId, set); }
          set.add(e.sessionId);
        }
      }

      if (e.userAgent) {
        const browser = parseBrowser(e.userAgent);
        const os      = parseOS(e.userAgent);
        browserCounts[browser] = (browserCounts[browser] ?? 0) + 1;
        osCounts[os]           = (osCounts[os] ?? 0) + 1;
      }

      const msg = e.args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
        .slice(0, 120);
      errorMsgCounts[msg] = (errorMsgCounts[msg] ?? 0) + 1;
    }

    // Count extra sessions from returning users (userId in 2+ sessions = N-1 duplicates)
    let returningUserSessions = 0;
    for (const sessionSet of userSessions.values()) {
      if (sessionSet.size > 1) returningUserSessions += sessionSet.size - 1;
    }

    // Correlated deploy: most recent successful deployment prior to firstSeenAt
    let correlatedDeploy: string | null = null;
    if (firstSeenAt !== null) {
      const deploys = this.getDeployments(50);
      const prior = deploys
        .filter((d) => d.timestamp <= firstSeenAt! && d.status === 'success')
        .sort((a, b) => b.timestamp - a.timestamp);
      correlatedDeploy = prior[0]?.sha ?? null;
    }

    const topErrors = Object.entries(errorMsgCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([message, count]) => ({ message, count }));

    return {
      affectedSessions: sessions.size,
      affectedUsers: users.size,
      returningUserSessions,
      errorCount,
      firstSeenAt,
      lastSeenAt,
      browserSegments: browserCounts,
      osSegments: osCounts,
      topErrors,
      correlatedDeploy,
      durationMs: firstSeenAt !== null ? Date.now() - firstSeenAt : null,
    };
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

  getSignals(tenantId?: string): SessionSignal[] {
    const candidates: SessionSignal[] = [];
    const logs     = this.getLogs(200, undefined, undefined, tenantId);
    const network  = this.getNetwork(200, undefined, undefined, tenantId);
    const contexts = this.getContext(20, undefined, tenantId);

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
          action: `Use reconstruct_context to find the root cause — this error fires on every execution of a specific path`,
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

  size(tenantId?: string): number {
    if (tenantId === undefined) return this._count;
    let n = 0;
    for (const e of this._iterate()) { if ((e as any)._tenantId === tenantId) n++; }
    return n;
  }

  serialize(tenantId?: string): BrowserEvent[] {
    if (tenantId === undefined) return Array.from(this._iterate());
    return Array.from(this._iterate()).filter((e) => (e as any)._tenantId === tenantId);
  }

  rehydrate(events: BrowserEvent[], tenantId?: string): void {
    for (const event of events) this.push(event, tenantId);
  }

  lastEventAt(tenantId?: string): number | null {
    if (tenantId === undefined) return this._lastEventAt;
    let last: number | null = null;
    for (const e of this._iterate()) {
      if ((e as any)._tenantId !== tenantId) continue;
      if (last === null || e.timestamp > last) last = e.timestamp;
    }
    return last;
  }
  clearedAt(): number | null { return this._clearedAt; }
}

// ── User-agent parsers (no deps — regex only) ─────────────────────────────────

export function parseBrowser(ua: string): string {
  if (/Edg\//.test(ua))         return 'Edge';
  if (/OPR\//.test(ua))         return 'Opera';
  if (/Firefox\//.test(ua))     return 'Firefox';
  if (/Chrome\//.test(ua))      return 'Chrome';
  if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return 'Safari';
  if (/MSIE|Trident/.test(ua))  return 'IE';
  return 'Other';
}

export function parseOS(ua: string): string {
  if (/iPhone|iPad/.test(ua))            return 'iOS';
  if (/Android/.test(ua))                return 'Android';
  if (/Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua)) return 'macOS';
  if (/Windows/.test(ua))                return 'Windows';
  if (/Linux/.test(ua))                  return 'Linux';
  return 'Other';
}

export let store: BufferStore = new RingBuffer();

/** Swap the active store implementation (used by the Redis persistence layer). */
export function setStore(s: BufferStore): void {
  store = s;
}
