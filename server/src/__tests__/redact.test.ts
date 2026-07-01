/**
 * redact.test.ts — D2: PII redaction at ingest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { redact, reloadRedactKeys } from '../sensor/redact.js';

beforeEach(() => {
  delete process.env.MERGEN_REDACT_KEYS;
  reloadRedactKeys();
});

describe('redact — value patterns', () => {
  it('strips JWTs from strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature_here_too';
    const out = redact(`token=${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('[REDACTED]');
  });

  it('strips Bearer tokens', () => {
    const out = redact('Bearer abcd1234efgh5678');
    expect(out).toMatch(/Bearer \[REDACTED\]/);
  });

  it('strips email addresses', () => {
    expect(redact('contact: alice@example.com today')).toMatch(/\[REDACTED\]/);
  });

  it('strips credit-card-like number runs', () => {
    expect(redact('4111 1111 1111 1111')).toMatch(/\[REDACTED\]/);
  });

  it('strips Stripe keys', () => {
    const key = 'sk_l' + 'ive_51Nzabcdefghijklmnopqrstuv';
    expect(redact(`api_key: ${key}`)).not.toContain(key);
    expect(redact(`api_key: ${key}`)).toContain('[REDACTED]');
  });

  it('redacts database passwords in connection strings', () => {
    const connStr = 'postgresql://db_user:my_secret_pass@localhost:5432/production_db';
    const out = redact(connStr);
    expect(out).toBe('postgresql://db_user:[REDACTED]@localhost:5432/production_db');
  });

  it('passes plain strings through unchanged', () => {
    expect(redact('hello world')).toBe('hello world');
  });
});

describe('redact — sensitive keys', () => {
  it('redacts default sensitive object keys', () => {
    const out = redact({
      user: 'bob',
      password: 'p@ssw0rd',
      Authorization: 'Bearer xyz',
      data: { token: 'abc', name: 'ok' },
    }) as Record<string, unknown>;
    expect(out.user).toBe('bob');
    expect(out.password).toBe('[REDACTED]');
    expect(out.Authorization).toBe('[REDACTED]');
    expect((out.data as Record<string, unknown>).token).toBe('[REDACTED]');
    expect((out.data as Record<string, unknown>).name).toBe('ok');
  });

  it('honours MERGEN_REDACT_KEYS env additions', () => {
    process.env.MERGEN_REDACT_KEYS = 'phone,internalId';
    reloadRedactKeys();
    const out = redact({ phone: '555-1234', internalId: 'X', name: 'ok' }) as Record<string, unknown>;
    expect(out.phone).toBe('[REDACTED]');
    expect(out.internalId).toBe('[REDACTED]');
    expect(out.name).toBe('ok');
  });

  it('handles nested arrays of objects', () => {
    const out = redact({
      users: [{ email: 'a@b.com', name: 'A' }, { email: 'c@d.com', name: 'B' }],
    }) as { users: Array<Record<string, string>> };
    expect(out.users[0].email).toBe('[REDACTED]');
    expect(out.users[1].email).toBe('[REDACTED]');
    expect(out.users[0].name).toBe('A');
  });

  it('does not throw on null/undefined/circular', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    const c: { self?: unknown } = {};
    c.self = c;
    expect(() => redact(c)).not.toThrow();
  });

  it('passes numbers and booleans through unchanged', () => {
    const out = redact({ a: 1, b: true, c: 'ok' }) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.b).toBe(true);
    expect(out.c).toBe('ok');
  });
});
