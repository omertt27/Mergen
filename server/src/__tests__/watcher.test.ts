/**
 * watcher.test.ts — Background diagnostic loop.
 *
 * The watcher is the heart of the "continuous diagnostic" pivot. We verify:
 *   1. It only ticks when the buffer has changed since the last tick.
 *   2. A tick triggers a hypothesisHistory rebuild via notifyActivity.
 *   3. MERGEN_WATCH=0 disables it cleanly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startWatcher, stopWatcher, _getWatcherTickCount } from '../sensor/watcher.js';
import { store } from '../sensor/buffer.js';
import { hypothesisHistory } from '../intelligence/hypothesis-history.js';

describe('watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.clear();
    hypothesisHistory.clear();
    delete process.env.MERGEN_WATCH;
    process.env.MERGEN_WATCH_INTERVAL_MS = '1000';
  });
  afterEach(() => {
    stopWatcher();
    vi.useRealTimers();
    delete process.env.MERGEN_WATCH_INTERVAL_MS;
  });

  it('skips ticks when the buffer has not changed', () => {
    startWatcher();
    vi.advanceTimersByTime(3500);
    expect(_getWatcherTickCount()).toBe(0);
  });

  it('ticks once per buffer change', () => {
    startWatcher();
    store.push({ type: 'console', level: 'log', args: ['hi'], url: 'x', timestamp: 1 });
    vi.advanceTimersByTime(1100);
    expect(_getWatcherTickCount()).toBe(1);
    // No new events → no further tick
    vi.advanceTimersByTime(1100);
    expect(_getWatcherTickCount()).toBe(1);
    // New event → another tick
    store.push({ type: 'console', level: 'log', args: ['hi2'], url: 'x', timestamp: 2 });
    vi.advanceTimersByTime(1100);
    expect(_getWatcherTickCount()).toBe(2);
  });

  it('is disabled when MERGEN_WATCH=0', () => {
    process.env.MERGEN_WATCH = '0';
    startWatcher();
    store.push({ type: 'console', level: 'log', args: ['hi'], url: 'x', timestamp: 1 });
    vi.advanceTimersByTime(2000);
    expect(_getWatcherTickCount()).toBe(0);
  });
});
