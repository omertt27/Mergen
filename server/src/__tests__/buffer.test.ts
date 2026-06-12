import { describe, it, expect, beforeEach } from 'vitest';
import { store, BufferStore } from '../sensor/buffer.js';
import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from '../sensor/buffer.js';

const makeConsole = (level: 'log' | 'warn' | 'error', ts = Date.now()): ConsoleEvent => ({
  type: 'console', level, args: [`msg-${level}`], url: 'http://localhost/', timestamp: ts,
});

const makeNetwork = (status: number): NetworkEvent => ({
  type: 'network', method: 'GET', url: 'http://localhost/api',
  status, statusText: String(status), duration: 10, timestamp: Date.now(),
});

const makeContext = (ts = Date.now()): ContextSnapshot => ({
  type: 'context', trigger: 'error', timestamp: ts,
  url: 'http://localhost/', title: 'Test Page',
  localStorage: { token: 'abc' }, sessionStorage: {},
});

// Use the singleton store; clear between tests
let s: BufferStore;
beforeEach(() => { store.clear(); s = store; });

describe('BufferStore', () => {
  it('starts empty', () => {
    expect(s.size()).toBe(0);
  });

  it('pushes and retrieves events', () => {
    s.push(makeConsole('error'));
    expect(s.size()).toBe(1);
    expect(s.getLogs()).toHaveLength(1);
  });

  it('respects the ring-buffer limit (2000)', () => {
    for (let i = 0; i < 2010; i++) s.push(makeConsole('log', i));
    expect(s.size()).toBe(2000);
    // Oldest 10 evicted — first remaining timestamp should be 10
    const logs = s.getLogs(2000);
    expect(logs[0].timestamp).toBe(10);
  });

  it('filters logs by level', () => {
    s.push(makeConsole('error'));
    s.push(makeConsole('warn'));
    s.push(makeConsole('log'));
    expect(s.getLogs(50, 'error')).toHaveLength(1);
    expect(s.getLogs(50, 'warn')).toHaveLength(1);
  });

  it('filters logs by since', () => {
    s.push(makeConsole('log', 100));
    s.push(makeConsole('log', 200));
    s.push(makeConsole('log', 300));
    expect(s.getLogs(50, undefined, 150)).toHaveLength(2);
  });

  it('respects limit in getLogs', () => {
    for (let i = 0; i < 30; i++) s.push(makeConsole('log'));
    expect(s.getLogs(10)).toHaveLength(10);
  });

  it('filters network by status', () => {
    s.push(makeNetwork(200));
    s.push(makeNetwork(404));
    s.push(makeNetwork(500));
    expect(s.getNetwork(50, 404)).toHaveLength(1);
    expect(s.getNetwork(50, 500)).toHaveLength(1);
    expect(s.getNetwork()).toHaveLength(3);
  });

  it('filters network by since', () => {
    s.push({ ...makeNetwork(200), timestamp: 100 });
    s.push({ ...makeNetwork(200), timestamp: 200 });
    expect(s.getNetwork(50, undefined, 150)).toHaveLength(1);
  });

  it('respects limit in getNetwork', () => {
    for (let i = 0; i < 30; i++) s.push(makeNetwork(200));
    expect(s.getNetwork(5)).toHaveLength(5);
  });

  it('clears the buffer', () => {
    s.push(makeConsole('error'));
    s.clear();
    expect(s.size()).toBe(0);
  });

  it('stores and retrieves context snapshots', () => {
    s.push(makeContext(100));
    s.push(makeContext(200));
    s.push(makeConsole('error', 150));
    expect(s.getContext()).toHaveLength(2);
    expect(s.getContext()[0].localStorage).toEqual({ token: 'abc' });
  });

  it('filters context by since', () => {
    s.push(makeContext(100));
    s.push(makeContext(300));
    expect(s.getContext(10, 200)).toHaveLength(1);
  });

  it('respects limit in getContext', () => {
    for (let i = 0; i < 5; i++) s.push(makeContext());
    expect(s.getContext(3)).toHaveLength(3);
  });
});
