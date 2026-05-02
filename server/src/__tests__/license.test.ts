/**
 * license.test.ts — plan mapping, state accessors (P3)
 *
 * We test the pure, side-effect-free exports only.
 * initLicense / activateKey are integration-only (require live LS API).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getPlan, PLANS } from '../intelligence/plans.js';
import { planFromVariantId } from '../intelligence/license.js';
import { getLicenseState, getActivePlanId } from '../intelligence/license.js';

describe('getPlan', () => {
  it('returns the free plan for undefined input', () => {
    expect(getPlan(undefined).id).toBe('free');
  });

  it('returns the free plan for unknown plan IDs', () => {
    expect(getPlan('nonexistent').id).toBe('free');
  });

  it('returns correct plan for every known PlanId', () => {
    for (const [id, plan] of Object.entries(PLANS)) {
      expect(getPlan(id).id).toBe(id);
      expect(plan.name.length).toBeGreaterThan(0);
    }
  });

  it('unlimited plans have analyzeCreditsPerMonth === Infinity', () => {
    expect(getPlan('solo_pro').analyzeCreditsPerMonth).toBe(Infinity);
    expect(getPlan('team').analyzeCreditsPerMonth).toBe(Infinity);
  });

  it('free plan grants a small monthly analyze allowance (B1: feel-the-magic credits)', () => {
    // Free is intentionally non-zero so new users can render at least one
    // Context Pack and feel the Hypothesis Engine. Don't regress this to 0.
    const credits = getPlan('free').analyzeCreditsPerMonth;
    expect(credits).toBeGreaterThan(0);
    expect(credits).toBeLessThanOrEqual(20); // safety cap so paid tiers aren't cannibalised
  });

  it('free plan never charges overage', () => {
    expect(getPlan('free').overageCentsPerCredit).toBe(0);
  });
});

describe('planFromVariantId', () => {
  it('returns a valid PlanId for every test input', () => {
    const validIds = Object.keys(PLANS);
    for (const input of ['', 'unknown', '0', undefined, 12345]) {
      expect(validIds).toContain(planFromVariantId(input as string | number | undefined));
    }
  });

  it('does not throw for null-like inputs', () => {
    expect(() => planFromVariantId(undefined)).not.toThrow();
    expect(() => planFromVariantId('')).not.toThrow();
  });
});

describe('getActivePlanId', () => {
  it('returns free when no license is loaded', () => {
    // The module starts with _state = null (no license file in test env)
    expect(getActivePlanId()).toBe('free');
  });
});

describe('getLicenseState', () => {
  it('returns null when no license is loaded', () => {
    expect(getLicenseState()).toBeNull();
  });
});
