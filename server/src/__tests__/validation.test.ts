import { describe, it, expect } from 'vitest';
import { BrowserEventSchema } from '../buffer.js';

describe('BrowserEventSchema validation', () => {
  it('accepts a valid console event', () => {
    const result = BrowserEventSchema.safeParse({
      type: 'console',
      level: 'error',
      args: ['something broke'],
      url: 'http://localhost/',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid network event', () => {
    const result = BrowserEventSchema.safeParse({
      type: 'network',
      method: 'POST',
      url: 'http://localhost/api/data',
      status: 500,
      statusText: 'Internal Server Error',
      duration: 123,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown event type', () => {
    const result = BrowserEventSchema.safeParse({ type: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('rejects console event missing required fields', () => {
    const result = BrowserEventSchema.safeParse({
      type: 'console',
      // missing level, args, url, timestamp
    });
    expect(result.success).toBe(false);
  });

  it('rejects console event with invalid log level', () => {
    const result = BrowserEventSchema.safeParse({
      type: 'console',
      level: 'verbose', // not in enum
      args: [],
      url: 'http://localhost/',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects network event with non-integer status', () => {
    const result = BrowserEventSchema.safeParse({
      type: 'network',
      method: 'GET',
      url: 'http://localhost/',
      status: 200.5,
      statusText: 'OK',
      duration: 10,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields when present', () => {
    const result = BrowserEventSchema.safeParse({
      type: 'console',
      level: 'warn',
      args: ['test'],
      stack: 'Error\n  at foo (app.js:1:1)',
      url: 'http://localhost/',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });
});
