import { describe, it, expect } from 'vitest';
import { timingSafeSecretEqual } from '../sensor/security-utils.js';

describe('timingSafeSecretEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeSecretEqual('mysecret', 'mysecret')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeSecretEqual('aaaaaaaa', 'bbbbbbbb')).toBe(false);
  });

  it('returns false for different string lengths', () => {
    expect(timingSafeSecretEqual('short', 'longer-secret')).toBe(false);
  });

  it('returns false for empty presented vs non-empty expected', () => {
    expect(timingSafeSecretEqual('', 'mysecret')).toBe(false);
  });

  it('returns false when presented is not a string', () => {
    expect(timingSafeSecretEqual(undefined, 'mysecret')).toBe(false);
    expect(timingSafeSecretEqual(null, 'mysecret')).toBe(false);
    expect(timingSafeSecretEqual(123, 'mysecret')).toBe(false);
  });

  it('returns true for long secrets (near COMPARISON_WIDTH)', () => {
    const secret = 'a'.repeat(64);
    expect(timingSafeSecretEqual(secret, secret)).toBe(true);
    expect(timingSafeSecretEqual('b'.repeat(64), secret)).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(timingSafeSecretEqual('Secret', 'secret')).toBe(false);
  });

  it('handles secrets with special characters', () => {
    const secret = 'a!b@c#d$e%f^g&h*i(j)k=l+';
    expect(timingSafeSecretEqual(secret, secret)).toBe(true);
    expect(timingSafeSecretEqual(secret + ' ', secret)).toBe(false);
  });
});
