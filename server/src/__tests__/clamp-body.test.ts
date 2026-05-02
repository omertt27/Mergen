/**
 * clamp-body.test.ts — guards against buffer-bloat under chatty APIs (D1).
 */
import { describe, it, expect } from 'vitest';
import { clampBody, clampNetworkBodies, MAX_BODY_BYTES } from '../sensor/ingest.js';
import type { BrowserEvent } from '../sensor/buffer.js';

describe('clampBody', () => {
  it('passes through small strings unchanged', () => {
    expect(clampBody('hello')).toBe('hello');
  });

  it('truncates oversized strings and adds a marker', () => {
    const big = 'a'.repeat(MAX_BODY_BYTES + 500);
    const result = clampBody(big) as string;
    expect(result.length).toBeLessThan(big.length);
    expect(result).toContain('[…truncated by mergen]');
    expect(result).toContain('+500 bytes');
  });

  it('passes through small objects unchanged', () => {
    const obj = { foo: 'bar' };
    expect(clampBody(obj)).toBe(obj);
  });

  it('truncates oversized objects to a marked string', () => {
    const obj = { blob: 'a'.repeat(MAX_BODY_BYTES + 100) };
    const result = clampBody(obj);
    expect(typeof result).toBe('string');
    expect(result as string).toContain('[…truncated by mergen]');
  });

  it('handles null/undefined safely', () => {
    expect(clampBody(null)).toBeNull();
    expect(clampBody(undefined)).toBeUndefined();
  });

  it('handles non-serialisable values without throwing', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => clampBody(circular)).not.toThrow();
  });
});

describe('clampNetworkBodies', () => {
  it('leaves non-network events untouched', () => {
    const e: BrowserEvent = {
      type: 'console', level: 'log', args: ['x'], url: 'http://a', timestamp: 1,
    };
    expect(clampNetworkBodies(e)).toBe(e);
  });

  it('clamps both request and response bodies on network events', () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 10);
    const e: BrowserEvent = {
      type: 'network',
      method: 'POST', url: 'http://a/api', status: 200, statusText: 'OK',
      duration: 12, requestBody: big, responseBody: big, timestamp: 1,
    };
    const out = clampNetworkBodies(e) as Extract<BrowserEvent, { type: 'network' }>;
    expect(typeof out.requestBody).toBe('string');
    expect(typeof out.responseBody).toBe('string');
    expect(out.requestBody as string).toContain('[…truncated by mergen]');
    expect(out.responseBody as string).toContain('[…truncated by mergen]');
  });
});
