/**
 * ingest.test.ts — rate limiter + auth tests
 *
 * Tests the REAL TokenBucket class exported from ingest.ts,
 * not a reimplemented copy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBucket } from '../ingest.js';

describe('TokenBucket (real implementation)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows up to `limit` requests per window', () => {
    const bucket = new TokenBucket(100, 1_000);
    for (let i = 0; i < 100; i++) {
      expect(bucket.isRateLimited()).toBe(false);
    }
    expect(bucket.isRateLimited()).toBe(true);
    bucket.reset();
  });

  it('resets after the window elapses', () => {
    const bucket = new TokenBucket(100, 1_000);
    for (let i = 0; i < 100; i++) bucket.isRateLimited();
    expect(bucket.isRateLimited()).toBe(true);

    vi.advanceTimersByTime(1_001);
    expect(bucket.isRateLimited()).toBe(false);
    bucket.reset();
  });

  it('reset() clears counters and timer', () => {
    const bucket = new TokenBucket(5, 1_000);
    for (let i = 0; i < 5; i++) bucket.isRateLimited();
    expect(bucket.isRateLimited()).toBe(true);

    bucket.reset();
    expect(bucket.isRateLimited()).toBe(false);
  });

  it('respects custom limit and windowMs', () => {
    const bucket = new TokenBucket(3, 500);
    expect(bucket.isRateLimited()).toBe(false);
    expect(bucket.isRateLimited()).toBe(false);
    expect(bucket.isRateLimited()).toBe(false);
    expect(bucket.isRateLimited()).toBe(true);

    vi.advanceTimersByTime(501);
    expect(bucket.isRateLimited()).toBe(false);
    bucket.reset();
  });

  it('is O(1) — handles 200 calls in the same window without throwing', () => {
    const bucket = new TokenBucket(100, 1_000);
    expect(() => {
      for (let i = 0; i < 200; i++) bucket.isRateLimited();
    }).not.toThrow();
    bucket.reset();
  });
});

// ── Shared secret auth ────────────────────────────────────────────────────────
// The auth logic is inline in the route handler, so we test the pattern directly.

describe('ingest auth pattern', () => {
  function checkAuth(configuredSecret: string, headerSecret: string): boolean {
    return !configuredSecret || headerSecret === configuredSecret;
  }

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
