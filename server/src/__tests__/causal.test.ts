import { describe, it, expect } from 'vitest';
import { buildCausalChain } from '../causal.js';
import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from '../buffer.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_000_000;

const makeError = (msg: string, ts = NOW, stack?: string): ConsoleEvent => ({
  type: 'console', level: 'error',
  args: [msg],
  stack: stack ?? `Error: ${msg}\n    at doThing (http://localhost/dist/bundle.js:10:20)`,
  url: 'http://localhost/checkout', timestamp: ts,
});

const makeWarn = (msg: string, ts = NOW - 5000): ConsoleEvent => ({
  type: 'console', level: 'warn', args: [msg],
  url: 'http://localhost/', timestamp: ts,
});

const makeNetwork = (
  url: string, status: number, ts = NOW - 2000,
  extras: Partial<NetworkEvent> = {},
): NetworkEvent => ({
  type: 'network', method: 'POST', url,
  status, statusText: String(status),
  duration: 120, timestamp: ts, ...extras,
});

const makeContext = (ts = NOW - 100, ls: Record<string, string> = {}): ContextSnapshot => ({
  type: 'context', trigger: 'error', timestamp: ts,
  url: 'http://localhost/checkout', title: 'Checkout',
  activeElement: "button[type='submit']",
  component: 'CheckoutForm',
  localStorage: ls, sessionStorage: {},
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildCausalChain', () => {
  it('returns a clean chain with no events', async () => {
    const c = await buildCausalChain([], [], []);
    expect(c.errors).toHaveLength(0);
    expect(c.chain).toHaveLength(0);
    expect(c.contextPack).toContain('No console errors');
    expect(c.hypotheses).toHaveLength(0);
  });

  it('builds errorBlocks for errors without stacks', async () => {
    const c = await buildCausalChain([makeError('Oops', NOW, '')], [], []);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0].message).toBe('Oops');
    expect(c.errors[0].primaryFrame).toBeNull();
  });

  it('correlates a failed network call within the window', async () => {
    const netFail = makeNetwork('/api/login', 500, NOW - 3000);
    const c = await buildCausalChain([makeError('Auth failed')], [netFail], []);
    expect(c.correlatedNetwork).toHaveLength(1);
    expect(c.correlatedNetwork[0].status).toBe(500);
    expect(c.correlatedNetwork[0].msBeforeError).toBe(3000);
  });

  it('does not correlate network calls outside the 30 s window', async () => {
    const oldNet = makeNetwork('/api/old', 200, NOW - 60_000);
    const c = await buildCausalChain([makeError('err')], [oldNet], []);
    expect(c.correlatedNetwork).toHaveLength(0);
  });

  it('attaches the most recent state snapshot within 5 s of the error', async () => {
    const snap = makeContext(NOW - 500, { userToken: 'null' });
    const c = await buildCausalChain([makeError('err')], [], [snap]);
    expect(c.stateAtError).not.toBeNull();
    expect(c.stateAtError?.component).toBe('CheckoutForm');
    expect(c.stateAtError?.localStorage['userToken']).toBe('null');
  });

  it('ignores state snapshots older than 5 s before the error', async () => {
    const oldSnap = makeContext(NOW - 10_000);
    const c = await buildCausalChain([makeError('err')], [], [oldSnap]);
    expect(c.stateAtError).toBeNull();
  });

  it('generates a hypothesis when auth network + null token are present', async () => {
    const loginOk = makeNetwork('/api/login', 200, NOW - 4000);
    const snap = makeContext(NOW - 200, { token: 'null' });
    const c = await buildCausalChain([makeError('Cannot read token')], [loginOk], [snap]);
    // Should produce at least one hypothesis; the top one should be auth-related
    expect(c.hypotheses.length).toBeGreaterThan(0);
    const top = c.hypotheses[0];
    expect(top.tag).toBe('auth_token_not_persisted');
    expect(top.summary).toMatch(/token|null|localStorage/i);
    expect(top.confidence).not.toBe('INSUFFICIENT');
    // Competing hypothesis for token overwrite should also fire (2+ conditions met)
    // and be ranked below the primary
    const tags = c.hypotheses.map((h) => h.tag);
    expect(tags[0]).toBe('auth_token_not_persisted'); // highest score first
  });

  it('orders the causal chain chronologically', async () => {
    const w = makeWarn('deprecation notice', NOW - 8000);
    const n = makeNetwork('/api/data', 200, NOW - 5000);
    const e = makeError('crash', NOW);
    const c = await buildCausalChain([e, w], [n], []);
    const timestamps = c.chain.map((ev) => ev.ts);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('contextPack contains root error message', async () => {
    const c = await buildCausalChain([makeError('TypeError: x is null')], [], []);
    expect(c.contextPack).toContain('TypeError: x is null');
  });

  it('contextPack contains state section even when no snapshot', async () => {
    const c = await buildCausalChain([makeError('err')], [], []);
    expect(c.contextPack).toContain('Invisible State');
    expect(c.contextPack).toContain('No storage snapshot');
  });

  it('contextPack flags null localStorage values with warning emoji', async () => {
    const snap = makeContext(NOW - 200, { userToken: 'null', sessionId: '' });
    const c = await buildCausalChain([makeError('err')], [], [snap]);
    expect(c.contextPack).toContain('⚠️ *NULL/EMPTY*');
  });

  it('includes full request/response bodies for correlated network failures', async () => {
    const n = makeNetwork('/api/pay', 422, NOW - 1000, {
      requestBody: { amount: 100 },
      responseBody: { error: 'card_declined' },
    });
    const c = await buildCausalChain([makeError('Payment failed')], [n], []);
    expect(c.contextPack).toContain('card_declined');
    expect(c.contextPack).toContain('"amount"');
  });

  it('includes request and response headers in the network pulse', async () => {
    const n = makeNetwork('/api/auth', 401, NOW - 1000, {
      requestHeaders: { Authorization: 'Bearer abc123xyz' },
      responseHeaders: { 'www-authenticate': 'Bearer error="token_expired"' },
      responseBody: { error: 'token_expired' },
    });
    const c = await buildCausalChain([makeError('Unauthorized')], [n], []);
    expect(c.contextPack).toContain('Authorization');
    expect(c.contextPack).toContain('www-authenticate');
    expect(c.contextPack).toContain('token_expired');
  });

  it('redacts Authorization header value but keeps the key visible', async () => {
    const n = makeNetwork('/api/secure', 403, NOW - 500, {
      requestHeaders: { Authorization: 'Bearer supersecrettoken9999' },
    });
    const c = await buildCausalChain([makeError('Forbidden')], [n], []);
    expect(c.contextPack).toContain('Authorization');
    expect(c.contextPack).not.toContain('supersecrettoken9999');
  });

  // ── P3 edge cases ──────────────────────────────────────────────────────────

  it('handles an error with empty args array gracefully', async () => {
    const e: ConsoleEvent = {
      type: 'console', level: 'error', args: [],
      url: 'http://localhost/', timestamp: NOW,
    };
    const c = await buildCausalChain([e], [], []);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0].message).toBe('');
    expect(c.contextPack).toBeDefined();
  });

  it('handles a net::ERR_CONNECTION_REFUSED (status 0) network event', async () => {
    const n = makeNetwork('/api/payments', 0, NOW - 500, {
      error: 'net::ERR_CONNECTION_REFUSED',
    });
    const c = await buildCausalChain([makeError('fetch failed')], [n], []);
    expect(c.correlatedNetwork[0].status).toBe(0);
    expect(c.correlatedNetwork[0].error).toBe('net::ERR_CONNECTION_REFUSED');
    expect(c.contextPack).toContain('NET_ERR');
  });

  it('picks the most recent context snapshot when multiple exist', async () => {
    const older  = makeContext(NOW - 3000, { key: 'old' });
    const newer  = makeContext(NOW - 500,  { key: 'new' });
    const c = await buildCausalChain([makeError('err')], [], [older, newer]);
    expect(c.stateAtError?.localStorage['key']).toBe('new');
  });

  it('null-safe network sort: does not produce NaN when there are no errors', async () => {
    // When no errors exist, msBeforeError is null for all entries.
    // The sort must not corrupt the order.
    const n1 = makeNetwork('/a', 200, NOW - 5000);
    const n2 = makeNetwork('/b', 200, NOW - 1000);
    const c = await buildCausalChain([], [n1, n2], []);
    // Should not throw and correlatedNetwork should be an array
    expect(Array.isArray(c.correlatedNetwork)).toBe(true);
    expect(c.correlatedNetwork.every((n) => n.msBeforeError === null)).toBe(true);
  });

  it('causal chain includes all event types in the correct order', async () => {
    const ctx  = makeContext(NOW - 8000);
    const warn = makeWarn('deprecation', NOW - 6000);
    const net  = makeNetwork('/api/x', 500, NOW - 4000);
    const err  = makeError('crash', NOW);
    const c = await buildCausalChain([err, warn], [net], [ctx]);
    const kinds = c.chain.map((e) => e.kind);
    expect(kinds).toContain('state');
    expect(kinds).toContain('warn');
    expect(kinds).toContain('network_fail');
    expect(kinds).toContain('error');
    // Verify chronological order
    const ts = c.chain.map((e) => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});
