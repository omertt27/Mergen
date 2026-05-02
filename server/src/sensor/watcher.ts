/**
 * watcher.ts — Continuous background diagnostic loop.
 *
 * Most observability tools wait for the developer to ask "what's wrong?".
 * Mergen flips that: a low-frequency timer ticks every WATCHER_INTERVAL_MS,
 * inspects the buffer, and asks the hypothesis engine to build a Context Pack
 * if anything *interesting* has happened since the last tick.
 *
 * This is what turns Mergen from a fire alarm into a watcher. The user does
 * nothing; the sidebar updates on its own; the AI host gets a fresh pack to
 * read on demand.
 *
 * Cost model:
 *   • The build runs against the in-memory buffer — no I/O, no LLM call.
 *   • The hypothesis-history debounce collapses the tick + any concurrent
 *     event-driven trigger (error/pageload/burst) into a single rebuild.
 *   • A tick that finds *no new events* since the previous tick exits early.
 *
 * Tunables:
 *   MERGEN_WATCH_INTERVAL_MS — override the tick rate (default 15 s).
 *   MERGEN_WATCH=0           — disable the loop (useful in tests / CI).
 */

import { store } from './buffer.js';
import logger from './logger.js';

// ── Diagnostic hook ───────────────────────────────────────────────────────────
// The intelligence layer registers this at startup so the watcher stays
// free of closed-source imports.
let _onActivity: ((reason: string) => void) | null = null;
export function registerWatcherNotifier(fn: (reason: string) => void): void {
  _onActivity = fn;
}

const DEFAULT_INTERVAL_MS = 15_000;

let _timer: ReturnType<typeof setInterval> | null = null;
let _lastSeenSize = 0;
let _ticks = 0;

export function startWatcher(): void {
  if (process.env.MERGEN_WATCH === '0') {
    logger.info('background watcher disabled via MERGEN_WATCH=0');
    return;
  }
  if (_timer) return;
  const interval = Number(process.env.MERGEN_WATCH_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  _timer = setInterval(() => {
    try {
      const size = store.size();
      // Skip ticks where nothing new has been ingested — keeps the engine
      // quiet on idle tabs so we never spam the panel with identical baselines.
      if (size === _lastSeenSize) return;
      _lastSeenSize = size;
      _ticks++;
      _onActivity?.('periodic');
    } catch (err) {
      logger.warn({ err }, 'background watcher tick failed (non-fatal)');
    }
  }, interval);

  // Don't keep the event loop alive solely for the watcher.
  if (typeof _timer.unref === 'function') _timer.unref();

  logger.info({ intervalMs: interval }, 'background watcher started');
}

export function stopWatcher(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _lastSeenSize = 0;
  _ticks = 0;
}

/** Test introspection. */
export function _getWatcherTickCount(): number {
  return _ticks;
}
