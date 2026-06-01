/**
 * debug-sessions.ts — Iterative debug session tracking with before/after diffs.
 *
 * Core idea: capture error fingerprints at session start (baseline), then on
 * every checkpoint compare against that baseline to produce a precise 3-way
 * diff:  resolved | persisted | new
 *
 * This closes the feedback loop the current toolchain is missing: the AI knows
 * whether its last fix worked without the developer having to describe it.
 */

import { randomUUID } from 'crypto';
import type { ConsoleEvent, NetworkEvent } from '../sensor/buffer.js';

// ── Fingerprinting ────────────────────────────────────────────────────────────
// Stable identity for an error/warning/network failure across reproductions.
// Intentionally lossy (truncated message) so slightly-reworded errors still
// match — this catches 95% of real-world "is it fixed?" cases.

function fingerprintConsole(e: ConsoleEvent): string {
  const msg = e.args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
    .trim()
    .slice(0, 120);
  return `${e.level}::${msg}`;
}

function fingerprintNetwork(n: NetworkEvent): string {
  // Omit query params — same endpoint failing with different params is still
  // the same failure pattern for our diff purposes.
  const url = n.url.split('?')[0];
  return `${n.method}::${url}::${n.status}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ErrorEntry {
  fingerprint: string;
  message: string;
  level: string;
  timestamp: number;
}

export interface NetworkFailureEntry {
  fingerprint: string;
  summary: string;
  status: number;
  timestamp: number;
}

export interface SessionSnapshot {
  capturedAt: number;
  errors: ErrorEntry[];
  warnings: ErrorEntry[];
  networkFailures: NetworkFailureEntry[];
}

export interface IterationDiff {
  /** Baseline errors that did NOT reappear after the fix — likely resolved. */
  resolved: ErrorEntry[];
  /** Baseline errors that DID reappear — fix didn't work for these. */
  persisted: ErrorEntry[];
  /** Errors that weren't in baseline but appeared after the fix — regressions. */
  newErrors: ErrorEntry[];
  resolvedNetworkFailures: NetworkFailureEntry[];
  newNetworkFailures: NetworkFailureEntry[];
  /** True when all baseline errors are resolved and no new errors were introduced. */
  isFixed: boolean;
}

export interface DebugIteration {
  index: number;
  note: string;
  timestamp: number;
  diff: IterationDiff;
}

export interface DebugSession {
  id: string;
  description: string;
  targetComponent?: string;
  baseline: SessionSnapshot;
  iterations: DebugIteration[];
  startedAt: number;
  endedAt?: number;
  resolved: boolean;
}

// ── In-memory store ───────────────────────────────────────────────────────────

const sessions = new Map<string, DebugSession>();

// ── Helpers ───────────────────────────────────────────────────────────────────

export function captureSnapshot(
  errors: ConsoleEvent[],
  warnings: ConsoleEvent[],
  networkFailures: NetworkEvent[],
): SessionSnapshot {
  return {
    capturedAt: Date.now(),
    errors: errors.map(e => ({
      fingerprint: fingerprintConsole(e),
      message: e.args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 200),
      level: e.level,
      timestamp: e.timestamp,
    })),
    warnings: warnings.map(e => ({
      fingerprint: fingerprintConsole(e),
      message: e.args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 200),
      level: e.level,
      timestamp: e.timestamp,
    })),
    networkFailures: networkFailures.map(n => ({
      fingerprint: fingerprintNetwork(n),
      summary: `${n.method} ${n.url.split('?')[0]} → ${n.status || 'NET_ERR'}`,
      status: n.status,
      timestamp: n.timestamp,
    })),
  };
}

export function diffSnapshots(baseline: SessionSnapshot, current: SessionSnapshot): IterationDiff {
  const baseErrFPs = new Set(baseline.errors.map(e => e.fingerprint));
  const baseNetFPs = new Set(baseline.networkFailures.map(n => n.fingerprint));
  const curErrFPs  = new Set(current.errors.map(e => e.fingerprint));
  const curNetFPs  = new Set(current.networkFailures.map(n => n.fingerprint));

  const resolved              = baseline.errors.filter(e => !curErrFPs.has(e.fingerprint));
  const persisted             = baseline.errors.filter(e =>  curErrFPs.has(e.fingerprint));
  const newErrors             = current.errors.filter(e => !baseErrFPs.has(e.fingerprint));
  const resolvedNetworkFailures = baseline.networkFailures.filter(n => !curNetFPs.has(n.fingerprint));
  const newNetworkFailures    = current.networkFailures.filter(n => !baseNetFPs.has(n.fingerprint));

  return {
    resolved,
    persisted,
    newErrors,
    resolvedNetworkFailures,
    newNetworkFailures,
    isFixed: persisted.length === 0 && newErrors.length === 0 && baseline.errors.length > 0,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startDebugSession(
  description: string,
  baseline: SessionSnapshot,
  targetComponent?: string,
): DebugSession {
  const session: DebugSession = {
    id: randomUUID(),
    description,
    targetComponent,
    baseline,
    iterations: [],
    startedAt: Date.now(),
    resolved: false,
  };
  sessions.set(session.id, session);
  return session;
}

export function checkpointSession(
  sessionId: string,
  current: SessionSnapshot,
  note: string,
): { session: DebugSession; diff: IterationDiff } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;

  // Always diff against the original baseline so every checkpoint gives the
  // full picture relative to where we started, not just the last step.
  const diff = diffSnapshots(session.baseline, current);
  session.iterations.push({
    index: session.iterations.length + 1,
    note,
    timestamp: Date.now(),
    diff,
  });
  if (diff.isFixed) session.resolved = true;
  return { session, diff };
}

export function endDebugSession(
  sessionId: string,
  current: SessionSnapshot,
): { session: DebugSession; diff: IterationDiff } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const diff = diffSnapshots(session.baseline, current);
  session.endedAt = Date.now();
  session.resolved = diff.isFixed;
  sessions.delete(sessionId);
  return { session, diff };
}

export function getSession(sessionId: string): DebugSession | undefined {
  return sessions.get(sessionId);
}

export function listActiveSessions(): DebugSession[] {
  return Array.from(sessions.values());
}

export function clearAllSessions(): number {
  const count = sessions.size;
  sessions.clear();
  return count;
}
