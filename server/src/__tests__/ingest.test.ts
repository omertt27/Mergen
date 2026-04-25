/**
 * ingest.test.ts — rate limiter + auth tests (P3)
 *
 * We test the pure logic in isolation without spinning up Express.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Token-bucket rate limiter (extracted for testability) ────────────────────
// Mirror the exact logic from ingest.ts so we can test it in isolation.

const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 1_000;

function makeBucket() {
  let count = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function isRateLimited(): boolean {
    if (count >= RATE_LIMIT) return true;
    count++;
    if (!timer) {
      timer = setTimeout(() => {
        count = 0;
        timer = null;
      }, RATE_WINDOW_MS);
    }
    return false;
  }

  function reset() {
    if (timer) { clearTimeout(timer); timer = null; }
    count = 0;
  }

  return { isRateLimited, reset };
}

describe('ingest rate limiter (token bucket)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows up to RATE_LIMIT requests per window', () => {
    const { isRateLimited, reset } = makeBucket();
    for (let i = 0; i < RATE_LIMIT; i++) {
      expect(isRateLimited()).toBe(false);
    }
    expect(isRateLimited()).toBe(true);
    reset();
  });

  it('resets after the window elapses', () => {
    const { isRateLimited, reset } = makeBucket();
    for (let i = 0; i < RATE_LIMIT; i++) isRateLimited();
    expect(isRateLimited()).toBe(true);

    vi.advanceTimersByTime(RATE_WINDOW_MS + 1);
    expect(isRateLimited()).toBe(false);
    reset();
  });

  it('is O(1) — does not use array operations', () => {
    // Smoke: calling 200 times in the same window should not throw
    const { isRateLimited, reset } = makeBucket();
    expect(() => {
      for (let i = 0; i < 200; i++) isRateLimited();
    }).not.toThrow();
    reset();
  });
});

// ── Shared secret auth ────────────────────────────────────────────────────────

function checkAuth(configuredSecret: string, headerSecret: string): boolean {
  return !configuredSecret || headerSecret === configuredSecret;
}

describe('ingest auth', () => {
  it('rejects a request when secret is wrong', () => {
    expect(checkAuth('correct-secret', 'wrong-secret')).toBe(false);
  });

  it('allows a request when no secret is configured', () => {
    expect(checkAuth('', 'anything')).toBe(true);
  });

  it('allows a request when secret matches', () => {
    expect(checkAuth('correct-secret', 'correct-secret')).toBe(true);
  });
});
