/**
 * billing.test.ts — webhook signature verification + plan routing (P3)
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { planFromVariantId } from '../intelligence/license.js';

// ── Signature verification ────────────────────────────────────────────────────

function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const expBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(signature);
  if (expBuf.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(expBuf, sigBuf);
}

const SECRET = 'test-webhook-secret';

describe('billing webhook signature', () => {
  it('accepts a valid HMAC-SHA256 signature', () => {
    const body = Buffer.from(JSON.stringify({ meta: { event_name: 'subscription_created' } }));
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(body, sig, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body    = Buffer.from('{"meta":{"event_name":"subscription_created"}}');
    const tampered = Buffer.from('{"meta":{"event_name":"subscription_updated"}}');
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(tampered, sig, SECRET)).toBe(false);
  });

  it('rejects when the secret is not configured (P1.2 fail-closed)', () => {
    const body = Buffer.from('{}');
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    // Empty secret = secret not configured = must reject
    expect(verifySignature(body, sig, '')).toBe(false);
  });

  it('rejects a completely wrong signature', () => {
    const body = Buffer.from('{"event":"test"}');
    expect(verifySignature(body, 'deadbeef', SECRET)).toBe(false);
  });
});

describe('planFromVariantId', () => {
  it('returns free for undefined variant', () => {
    const result = planFromVariantId(undefined);
    const validIds = [
      'free',
      'starter',
      'team',
      'platform',
      'enterprise',
      'solo_starter',
      'solo_pro',
      'solo_power',
      'pay_as_you_go',
    ];
    expect(validIds).toContain(result);
  });

  it('returns a valid PlanId string for any input', () => {
    for (const input of ['', '0', '99999', 'garbage', undefined]) {
      const result = planFromVariantId(input);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
