/**
 * gate-analytics.ts — Four in-memory feedback trackers for the policy gate.
 *
 *  1. Retry Success Rate  — after a BLOCK, did the agent's next call pass?
 *  2. Policy Coverage     — which tool calls hit no rule? which rules never fire?
 *  3. HITL Decision       — approve/deny ratios + latency per rule
 *  4. Gate Event Ring     — rolling 500-event log for policy replay + agent forensics
 *
 * All state is in-memory (no disk). This is operational telemetry, not audit log.
 * Consumers: GET /gate-analytics, POST /policies/simulate, GET /agents/:id/timeline
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface RetryStats {
  fired: number;
  retryPassed: number;
  retryBlocked: number;
}

export interface HitlStats {
  approvals: number;
  denials: number;
  totalApprovalLatencyMs: number;
  totalDenialLatencyMs: number;
}

// ── 1. Retry Success Rate ──────────────────────────────────────────────────

const _retryStats = new Map<string, RetryStats>();

interface PendingRetry {
  triggeredRules: string[];
  firedAt: number;
}

const _pendingRetries: PendingRetry[] = [];
const RETRY_WINDOW_MS = 60_000;

function _mostRecentRetryIdx(now: number): number {
  for (let i = _pendingRetries.length - 1; i >= 0; i--) {
    if (now - _pendingRetries[i].firedAt <= RETRY_WINDOW_MS) return i;
  }
  return -1;
}

function _ensureRetryStats(ruleId: string): RetryStats {
  if (!_retryStats.has(ruleId)) _retryStats.set(ruleId, { fired: 0, retryPassed: 0, retryBlocked: 0 });
  return _retryStats.get(ruleId)!;
}

/**
 * Call when the gate issues a BLOCK verdict.
 * Resolves any pending retry as retryBlocked, then pushes a new pending entry.
 */
export function recordGateBlock(triggeredRules: string[]): void {
  const now = Date.now();
  const idx = _mostRecentRetryIdx(now);
  if (idx !== -1) {
    const pending = _pendingRetries.splice(idx, 1)[0];
    for (const ruleId of pending.triggeredRules) {
      _ensureRetryStats(ruleId).retryBlocked++;
    }
  }
  for (const ruleId of triggeredRules) {
    _ensureRetryStats(ruleId).fired++;
  }
  _pendingRetries.push({ triggeredRules, firedAt: now });
  _schedulePersist();
}

/**
 * Call when the gate issues a PASS verdict.
 * Resolves any pending retry as retryPassed.
 */
export function recordGatePass(): void {
  const now = Date.now();
  const idx = _mostRecentRetryIdx(now);
  if (idx === -1) return;
  const pending = _pendingRetries.splice(idx, 1)[0];
  for (const ruleId of pending.triggeredRules) {
    _ensureRetryStats(ruleId).retryPassed++;
  }
}

export function getRetryStats(): Map<string, RetryStats> {
  return _retryStats;
}

// ── 2. Policy Coverage ─────────────────────────────────────────────────────

const _toolCallCounts = new Map<string, number>();
const _unguardedCounts = new Map<string, number>();
const _ruleFirings    = new Map<string, number>();

/**
 * Call on every gate evaluation regardless of verdict.
 */
export function recordGateCoverage(toolName: string, triggeredRules: string[]): void {
  _toolCallCounts.set(toolName, (_toolCallCounts.get(toolName) ?? 0) + 1);
  if (triggeredRules.length === 0) {
    _unguardedCounts.set(toolName, (_unguardedCounts.get(toolName) ?? 0) + 1);
  }
  for (const ruleId of triggeredRules) {
    _ruleFirings.set(ruleId, (_ruleFirings.get(ruleId) ?? 0) + 1);
  }
  _schedulePersist();
}

export function getToolCallCounts(): Map<string, number> { return _toolCallCounts; }
export function getUnguardedCounts(): Map<string, number> { return _unguardedCounts; }
export function getRuleFirings(): Map<string, number>    { return _ruleFirings; }

// ── 3. HITL Decision Patterns ──────────────────────────────────────────────

const _hitlStats = new Map<string, HitlStats>();

function _ensureHitlStats(ruleId: string): HitlStats {
  if (!_hitlStats.has(ruleId)) {
    _hitlStats.set(ruleId, { approvals: 0, denials: 0, totalApprovalLatencyMs: 0, totalDenialLatencyMs: 0 });
  }
  return _hitlStats.get(ruleId)!;
}

export function recordHitlDecision(
  triggeredRules: string[],
  decision: 'approve' | 'deny',
  heldAt: number,
): void {
  const latencyMs = Date.now() - heldAt;
  for (const ruleId of triggeredRules) {
    const stats = _ensureHitlStats(ruleId);
    if (decision === 'approve') {
      stats.approvals++;
      stats.totalApprovalLatencyMs += latencyMs;
    } else {
      stats.denials++;
      stats.totalDenialLatencyMs += latencyMs;
    }
  }
}

export function getHitlStats(): Map<string, HitlStats> { return _hitlStats; }

// ── 4. Gate Event Ring Buffer ──────────────────────────────────────────────

export interface GateEvent {
  ts: number;
  toolName: string;
  /** Primary command string extracted from args (first 400 chars). */
  command: string | null;
  actor: string;
  agentId: string | null;
  service: string;
  environment: string | null;
  verdict: 'pass' | 'block' | 'hold';
  triggeredRules: string[];
  /** The block reason text returned to the agent — used to measure guided-alternative quality. */
  guidedAlternative: string | null;
}

const RING_CAP = 500;
const _gateRing: GateEvent[] = [];

export function recordGateEvent(event: GateEvent): void {
  _gateRing.push(event);
  if (_gateRing.length > RING_CAP) _gateRing.shift();
  // Feature 5: trigger behavior-baseline recompute every N events (async, non-blocking)
  if (event.agentId) {
    void import('./behavior-baseline.js').then(({ onGateEvent }) => onGateEvent(event.agentId));
  }
  _schedulePersist();
}

export function getGateEvents(): GateEvent[] { return [..._gateRing]; }

/**
 * Reformulation success rate per rule: after this rule blocked a call,
 * what fraction of agents reformulated and passed within the retry window?
 * Derived from existing retryPassed / fired counts.
 */
export function getReformulationRates(): Map<string, { rate: number; fired: number; reformulated: number }> {
  const result = new Map<string, { rate: number; fired: number; reformulated: number }>();
  for (const [ruleId, stats] of _retryStats) {
    const reformulated = stats.retryPassed;
    result.set(ruleId, {
      fired: stats.fired,
      reformulated,
      rate: stats.fired > 0 ? reformulated / stats.fired : 0,
    });
  }
  return result;
}

// ── 5. HITL Fatigue Tracking ───────────────────────────────────────────────

const FATIGUE_WINDOW_MS = 60 * 60 * 1_000; // 1 hour
const FATIGUE_THRESHOLD = 5;               // holds per hour before flagging
const _holdTimestamps: number[] = [];

export function recordHitlHold(): void {
  const now = Date.now();
  _holdTimestamps.push(now);
  // Evict entries outside the rolling window
  const cutoff = now - FATIGUE_WINDOW_MS;
  while (_holdTimestamps.length > 0 && _holdTimestamps[0] < cutoff) _holdTimestamps.shift();
}

export function getHitlFatigueStatus(): {
  holdsLastHour: number;
  fatigued: boolean;
  threshold: number;
  recommendation: string | null;
} {
  const now = Date.now();
  const cutoff = now - FATIGUE_WINDOW_MS;
  const holdsLastHour = _holdTimestamps.filter((t) => t >= cutoff).length;
  const fatigued = holdsLastHour >= FATIGUE_THRESHOLD;
  return {
    holdsLastHour,
    fatigued,
    threshold: FATIGUE_THRESHOLD,
    recommendation: fatigued
      ? `${holdsLastHour} HITL holds in the last hour — consider tightening the policy to auto-block these patterns rather than holding them for approval.`
      : null,
  };
}

// ── Persistence ────────────────────────────────────────────────────────────────
// Survives server restarts via agent-context-store (SQLite-backed).
// Loaded on startup so the Policy Suggester always has longitudinal signal.

interface AnalyticsSnapshot {
  version: 1;
  retryStats:     Array<[string, RetryStats]>;
  toolCallCounts: Array<[string, number]>;
  unguardedCounts: Array<[string, number]>;
  ruleFirings:    Array<[string, number]>;
  hitlStats:      Array<[string, HitlStats]>;
  events:         GateEvent[];
}

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

export function persistGateAnalytics(): void {
  import('../sensor/agent-context-store.js').then(({ agentContextStore }) => {
    const snapshot: AnalyticsSnapshot = {
      version:         1,
      retryStats:      [..._retryStats.entries()],
      toolCallCounts:  [..._toolCallCounts.entries()],
      unguardedCounts: [..._unguardedCounts.entries()],
      ruleFirings:     [..._ruleFirings.entries()],
      hitlStats:       [..._hitlStats.entries()],
      events:          _gateRing.slice(-500),
    };
    agentContextStore.store('__gate', 'gate_analytics_v1', JSON.stringify(snapshot), 0);
  }).catch(() => { /* non-critical */ });
}

function _schedulePersist(): void {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persistGateAnalytics();
  }, 60_000);
  if (_persistTimer && typeof _persistTimer === 'object' && 'unref' in _persistTimer) {
    (_persistTimer as { unref(): void }).unref();
  }
}

export async function hydrateGateAnalytics(): Promise<void> {
  try {
    const { agentContextStore } = await import('../sensor/agent-context-store.js');
    const entries = agentContextStore.recall('__gate', 'gate_analytics_v1', 1);
    if (entries.length === 0) return;
    const snap = JSON.parse(entries[0].value) as AnalyticsSnapshot;
    if (snap?.version !== 1) return;
    for (const [k, v] of snap.retryStats ?? [])     _retryStats.set(k, v);
    for (const [k, v] of snap.toolCallCounts ?? [])  _toolCallCounts.set(k, v);
    for (const [k, v] of snap.unguardedCounts ?? []) _unguardedCounts.set(k, v);
    for (const [k, v] of snap.ruleFirings ?? [])     _ruleFirings.set(k, v);
    for (const [k, v] of snap.hitlStats ?? [])       _hitlStats.set(k, v);
    if (Array.isArray(snap.events)) {
      _gateRing.length = 0;
      _gateRing.push(...snap.events.slice(-RING_CAP));
    }
  } catch { /* non-critical */ }
}

