/**
 * session-metrics.ts — Tracks first-attempt fix success rate.
 *
 * The board-slide metric: "AI fix success rate on first attempt, with Mergen."
 * A session opens when analyze_runtime is called. It closes when validate_fix
 * records its first verdict for that pid.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../sensor/paths.js';

const METRICS_FILE = path.join(DATA_DIR, 'session-metrics.json');
const MAX_SESSIONS = 500;

export type SessionOutcome = 'resolved' | 'partial' | 'unresolved';

export interface DebugSession {
  pid: string;
  tag: string;
  startedAt: number;
  firstValidateAt?: number;
  firstOutcome?: SessionOutcome;
}

interface MetricsFile {
  version: 1;
  sessions: DebugSession[];
}

let _sessions: DebugSession[] = [];
let _loaded = false;

function load(): void {
  if (_loaded) return;
  _loaded = true;
  try {
    if (!fs.existsSync(METRICS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8')) as MetricsFile;
    if (parsed?.version === 1 && Array.isArray(parsed.sessions)) {
      _sessions = parsed.sessions.slice(-MAX_SESSIONS);
    }
  } catch { /* start fresh */ }
}

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(METRICS_FILE, JSON.stringify({ version: 1, sessions: _sessions }), 'utf8');
  } catch { /* non-fatal */ }
}

export function startSession(pid: string, tag: string): void {
  load();
  if (_sessions.some((s) => s.pid === pid)) return; // idempotent
  _sessions.push({ pid, tag, startedAt: Date.now() });
  if (_sessions.length > MAX_SESSIONS) _sessions = _sessions.slice(-MAX_SESSIONS);
  persist();
}

export function closeSession(pid: string, outcome: SessionOutcome): void {
  load();
  const session = _sessions.find((s) => s.pid === pid && !s.firstOutcome);
  if (!session) return;
  session.firstValidateAt = Date.now();
  session.firstOutcome = outcome;
  persist();
}

export interface SessionMetrics {
  total: number;
  withOutcome: number;
  firstAttemptResolved: number;
  firstAttemptPartial: number;
  firstAttemptUnresolved: number;
  /** null when fewer than 3 sessions have outcomes — too noisy to report */
  firstAttemptSuccessRate: number | null;
  recentSessions: Array<{ tag: string; outcome: SessionOutcome; startedAt: number }>;
}

export function getSessionMetrics(): SessionMetrics {
  load();
  const withOutcome = _sessions.filter((s) => s.firstOutcome);
  const resolved   = withOutcome.filter((s) => s.firstOutcome === 'resolved').length;
  const partial    = withOutcome.filter((s) => s.firstOutcome === 'partial').length;
  const unresolved = withOutcome.filter((s) => s.firstOutcome === 'unresolved').length;

  return {
    total: _sessions.length,
    withOutcome: withOutcome.length,
    firstAttemptResolved: resolved,
    firstAttemptPartial: partial,
    firstAttemptUnresolved: unresolved,
    firstAttemptSuccessRate: withOutcome.length >= 3
      ? (resolved + partial * 0.5) / withOutcome.length
      : null,
    recentSessions: _sessions
      .filter((s) => s.firstOutcome)
      .slice(-10)
      .reverse()
      .map((s) => ({ tag: s.tag, outcome: s.firstOutcome!, startedAt: s.startedAt })),
  };
}

/** Test-only reset. */
export function _resetSessionMetricsForTesting(): void {
  _sessions = [];
  _loaded = true;
}