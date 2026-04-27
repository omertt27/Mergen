/**
 * hypothesis-history.test.ts — B2/C1: caching of causal chain results.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { hypothesisHistory } from '../hypothesis-history.js';
import { store } from '../buffer.js';

beforeEach(() => {
  store.clear();
  hypothesisHistory.clear();
});

function pushError(msg: string, ts = Date.now()): void {
  store.push({
    type: 'console',
    level: 'error',
    args: [msg],
    url: 'http://localhost/',
    timestamp: ts,
  });
}

describe('hypothesisHistory', () => {
  it('starts empty', () => {
    expect(hypothesisHistory.size()).toBe(0);
    expect(hypothesisHistory.latest()).toBeNull();
    expect(hypothesisHistory.list()).toEqual([]);
  });

  it('builds an entry after notifyError when buffer has errors', async () => {
    pushError('TypeError: cannot read x');
    await hypothesisHistory._rebuildNowForTesting();

    expect(hypothesisHistory.size()).toBe(1);
    const latest = hypothesisHistory.latest();
    expect(latest).not.toBeNull();
    expect(latest!.triggerMessage).toContain('TypeError');
    expect(latest!.chain.contextPack).toBeTruthy();
  });

  it('skips build when buffer has no error events', async () => {
    store.push({
      type: 'console', level: 'log', args: ['hello'], url: 'http://x', timestamp: 1,
    });
    await hypothesisHistory._rebuildNowForTesting();
    expect(hypothesisHistory.size()).toBe(0);
  });

  it('replaces (not appends) when same trigger fires again', async () => {
    pushError('TypeError: cannot read x', 100);
    await hypothesisHistory._rebuildNowForTesting();
    pushError('TypeError: cannot read x', 200);
    await hypothesisHistory._rebuildNowForTesting();
    expect(hypothesisHistory.size()).toBe(1);
  });

  it('appends a new entry when the trigger message changes', async () => {
    pushError('Error A', 100);
    await hypothesisHistory._rebuildNowForTesting();
    // Simulate a fresh diagnosis context (e.g. after /clear) before the next error.
    store.clear();
    pushError('Error B — totally different', 200);
    await hypothesisHistory._rebuildNowForTesting();
    expect(hypothesisHistory.size()).toBe(2);
  });

  it('list() returns newest-first without the heavy chain field', async () => {
    pushError('Error A', 100);
    await hypothesisHistory._rebuildNowForTesting();
    store.clear();
    pushError('Error B — totally different', 200);
    await hypothesisHistory._rebuildNowForTesting();
    const list = hypothesisHistory.list();
    expect(list).toHaveLength(2);
    expect(list[0].triggerMessage).toContain('Error B');
    expect(list[1].triggerMessage).toContain('Error A');
    expect((list[0] as Record<string, unknown>).chain).toBeUndefined();
  });

  it('clear() drops all entries', async () => {
    pushError('Error A');
    await hypothesisHistory._rebuildNowForTesting();
    expect(hypothesisHistory.size()).toBe(1);
    hypothesisHistory.clear();
    expect(hypothesisHistory.size()).toBe(0);
  });

  it('builds a baseline entry on pageload when only network events exist (no error)', async () => {
    store.push({
      type: 'network', method: 'GET', url: 'https://api/x',
      status: 200, statusText: 'OK', duration: 30, timestamp: Date.now(),
    });
    await hypothesisHistory._rebuildNowForTesting('pageload');
    expect(hypothesisHistory.size()).toBe(1);
    const latest = hypothesisHistory.latest()!;
    expect(latest.reason).toBe('pageload');
    expect(latest.triggerMessage.toLowerCase()).toMatch(/page loaded|baseline/);
  });

  it('skips baseline build when buffer has no meaningful activity', async () => {
    await hypothesisHistory._rebuildNowForTesting('periodic');
    expect(hypothesisHistory.size()).toBe(0);
  });
});
