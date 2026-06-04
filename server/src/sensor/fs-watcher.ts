/**
 * fs-watcher.ts — Watch source files for changes and auto-validate fixes.
 *
 * Workflow:
 *   1. Agent calls watch_for_fix(pid, since, paths) after diagnosing an issue.
 *   2. Developer saves the fix.
 *   3. After SETTLE_DELAY_MS of quiet (debounce), compare error counts before/after.
 *   4. Auto-record verdict to calibration corpus and push result to buffer.
 *   5. If resolved, stop watching automatically.
 *
 * One active watch at a time — starting a new watch stops the previous one.
 */

import fs from 'fs';
import { store } from './buffer.js';
import { getRecords, recordVerdict } from '../intelligence/calibration.js';
import logger from './logger.js';

const SETTLE_DELAY_MS = 2_000;

export interface ValidationResult {
  verdict: 'correct' | 'partial' | 'wrong';
  errsBefore: number;
  errsAfter: number;
  status: string;
  timestamp: number;
}

interface WatchState {
  pid: string;
  since: number;
  paths: string[];
  watchers: fs.FSWatcher[];
  lastChangedAt: number | null;
  validateTimer: ReturnType<typeof setTimeout> | null;
  lastValidation: ValidationResult | null;
}

let _state: WatchState | null = null;

export interface FileWatchOptions {
  pid: string;
  since: number;
  paths: string[];
}

export function startFileWatch(opts: FileWatchOptions): void {
  if (_state) stopFileWatch();

  const watchers: fs.FSWatcher[] = [];
  for (const p of opts.paths) {
    try {
      // Treat paths without an extension (or ending in /) as directories
      const recursive = p.endsWith('/') || !/\.[^/\\]+$/.test(p);
      const watcher = fs.watch(p, { recursive }, () => {
        if (!_state) return;
        _state.lastChangedAt = Date.now();
        scheduleValidation();
      });
      watcher.on('error', (err) => logger.warn({ path: p, err }, 'fs-watcher: watch error'));
      watchers.push(watcher);
    } catch (err) {
      logger.warn({ path: p, err }, 'fs-watcher: could not watch path — skipping');
    }
  }

  _state = {
    pid: opts.pid,
    since: opts.since,
    paths: opts.paths,
    watchers,
    lastChangedAt: null,
    validateTimer: null,
    lastValidation: null,
  };
  logger.info({ paths: opts.paths.length, pid: opts.pid }, 'fs-watcher: started');
}

function scheduleValidation(): void {
  if (!_state) return;
  if (_state.validateTimer) clearTimeout(_state.validateTimer);
  _state.validateTimer = setTimeout(runValidation, SETTLE_DELAY_MS);
  if (typeof _state.validateTimer.unref === 'function') _state.validateTimer.unref();
}

function runValidation(): void {
  if (!_state) return;
  const { pid, since } = _state;
  const windowStart = since - 60_000;

  const logsBefore = store.getLogs(200, 'error', windowStart).filter((e) => e.timestamp < since);
  const netBefore  = store.getNetwork(200, undefined, windowStart).filter((e) => e.timestamp < since && (e.status >= 400 || !!e.error));
  const logsAfter  = store.getLogs(200, 'error', since);
  const netAfter   = store.getNetwork(200, undefined, since).filter((e) => e.status >= 400 || !!e.error);

  const errsBefore = logsBefore.length + netBefore.length;
  const errsAfter  = logsAfter.length  + netAfter.length;

  let verdict: ValidationResult['verdict'];
  let status: string;

  if (errsAfter === 0) {
    verdict = 'correct';
    status  = errsBefore > 0 ? 'RESOLVED' : 'CLEAN';
  } else if (errsBefore > 0 && errsAfter < errsBefore * 0.5) {
    verdict = 'partial';
    status  = 'PARTIAL';
  } else {
    verdict = 'wrong';
    status  = errsAfter > errsBefore ? 'REGRESSED' : 'UNRESOLVED';
  }

  const records = getRecords();
  const prediction = records.find((r) => r.pid === pid);
  if (prediction && !prediction.verdict) recordVerdict(pid, verdict);

  const result: ValidationResult = { verdict, errsBefore, errsAfter, status, timestamp: Date.now() };
  if (_state) _state.lastValidation = result;

  store.push({
    type: 'terminal',
    terminalName: 'mergen:validate',
    data: `[fix-validation] verdict=${verdict} before=${errsBefore} after=${errsAfter} pid=${pid}`,
    timestamp: Date.now(),
  });

  logger.info({ pid, verdict, errsBefore, errsAfter }, 'fs-watcher: validation complete');

  if (verdict === 'correct') {
    // Defer stop so callers can still read lastValidation via getWatchState()
    const t = setTimeout(stopFileWatch, 200);
    if (typeof t.unref === 'function') t.unref();
  }
}

export function stopFileWatch(): void {
  if (!_state) return;
  if (_state.validateTimer) clearTimeout(_state.validateTimer);
  for (const w of _state.watchers) {
    try { w.close(); } catch { /* best-effort */ }
  }
  logger.info({ pid: _state.pid }, 'fs-watcher: stopped');
  _state = null;
}

export function getWatchState(): {
  pid: string;
  since: number;
  paths: string[];
  lastChangedAt: number | null;
  lastValidation: ValidationResult | null;
} | null {
  if (!_state) return null;
  return {
    pid: _state.pid,
    since: _state.since,
    paths: _state.paths,
    lastChangedAt: _state.lastChangedAt,
    lastValidation: _state.lastValidation,
  };
}