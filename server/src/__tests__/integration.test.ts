/**
 * integration.test.ts — End-to-end test: POST /ingest → buffer → MCP tool output.
 *
 * Verifies the core value prop: events ingested via HTTP are returned by the
 * MCP tools (simulated via the buffer store directly).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { store, BrowserEventSchema } from '../sensor/buffer.js';
import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from '../sensor/buffer.js';

describe('ingest → buffer → tool pipeline', () => {
  beforeEach(() => {
    store.clear();
  });

  it('console event ingested and returned by getLogs', () => {
    const event: ConsoleEvent = {
      type: 'console',
      level: 'error',
      args: ['TypeError: Cannot read properties of null'],
      url: 'http://localhost:3000/',
      timestamp: Date.now(),
    };

    // Validate like the ingest route does
    const result = BrowserEventSchema.safeParse(event);
    expect(result.success).toBe(true);

    store.push(result.data!);
    const logs = store.getLogs(50, 'error');

    expect(logs).toHaveLength(1);
    expect(logs[0].args[0]).toBe('TypeError: Cannot read properties of null');
    expect(logs[0].level).toBe('error');
  });

  it('network event ingested and returned by getNetwork', () => {
    const event: NetworkEvent = {
      type: 'network',
      method: 'POST',
      url: 'http://localhost:3000/api/auth',
      status: 401,
      statusText: 'Unauthorized',
      duration: 342,
      responseBody: { error: 'Token expired' },
      timestamp: Date.now(),
    };

    const result = BrowserEventSchema.safeParse(event);
    expect(result.success).toBe(true);

    store.push(result.data!);
    const network = store.getNetwork(50, 401);

    expect(network).toHaveLength(1);
    expect(network[0].method).toBe('POST');
    expect(network[0].status).toBe(401);
  });

  it('context snapshot ingested and returned by getContext', () => {
    const event: ContextSnapshot = {
      type: 'context',
      trigger: 'error',
      timestamp: Date.now(),
      url: 'http://localhost:3000/login',
      title: 'Login Page',
      activeElement: 'input#email',
      localStorage: { token: 'null' },
      sessionStorage: {},
    };

    const result = BrowserEventSchema.safeParse(event);
    expect(result.success).toBe(true);

    store.push(result.data!);
    const contexts = store.getContext(10);

    expect(contexts).toHaveLength(1);
    expect(contexts[0].url).toBe('http://localhost:3000/login');
    expect(contexts[0].localStorage.token).toBe('null');
  });

  it('counters are updated correctly across event types', () => {
    store.push({ type: 'console', level: 'error', args: ['err1'], url: 'u', timestamp: 1 });
    store.push({ type: 'console', level: 'error', args: ['err2'], url: 'u', timestamp: 2 });
    store.push({ type: 'console', level: 'warn', args: ['w1'], url: 'u', timestamp: 3 });
    store.push({ type: 'network', method: 'GET', url: '/api', status: 500, statusText: 'ISE', duration: 100, timestamp: 4 });
    store.push({ type: 'network', method: 'GET', url: '/ok', status: 200, statusText: 'OK', duration: 50, timestamp: 5 });

    const counters = store.getCounters();
    expect(counters.errors).toBe(2);
    expect(counters.warnings).toBe(1);
    expect(counters.networkErrors).toBe(1);
    expect(store.size()).toBe(5);
  });

  it('clear resets buffer and counters', () => {
    store.push({ type: 'console', level: 'error', args: ['e'], url: 'u', timestamp: 1 });
    store.push({ type: 'network', method: 'GET', url: '/x', status: 404, statusText: 'NF', duration: 10, timestamp: 2 });

    store.clear();

    expect(store.size()).toBe(0);
    expect(store.getLogs()).toHaveLength(0);
    expect(store.getNetwork()).toHaveLength(0);

    const counters = store.getCounters();
    expect(counters.errors).toBe(0);
    expect(counters.warnings).toBe(0);
    expect(counters.networkErrors).toBe(0);
  });

  it('priority eviction preserves errors over console.log when buffer is full', () => {
    // Fill buffer with 200 console.log events
    for (let i = 0; i < 200; i++) {
      store.push({ type: 'console', level: 'log', args: [`log-${i}`], url: 'u', timestamp: i });
    }
    expect(store.size()).toBe(200);

    // Push an error — it should evict a log, not be lost
    store.push({ type: 'console', level: 'error', args: ['critical error'], url: 'u', timestamp: 300 });

    const errors = store.getLogs(200, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].args[0]).toBe('critical error');
    expect(store.size()).toBe(200); // still 200 total
  });
});
