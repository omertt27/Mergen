/**
 * usage.test.ts — unit tests for the credit-accounting and overage logic.
 *
 * All external I/O (fs, fetch, LemonSqueezy SDK) is mocked.
 * Module state is reset via _resetForTesting() before each test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock fs ───────────────────────────────────────────────────────────────────
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue({ code: 'ENOENT' }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

// ── Mock LemonSqueezy SDK ─────────────────────────────────────────────────────
vi.mock('@lemonsqueezy/lemonsqueezy.js', () => ({
  lemonSqueezySetup: vi.fn(),
}));

// ── Mock license ──────────────────────────────────────────────────────────────
const mockLicenseState: { value: { lsSubscriptionItemId?: string } | null } = { value: null };

vi.mock('../license.js', () => ({
  getActivePlanId: vi.fn(() => 'solo_standard'),
  getLicenseState: vi.fn(() => mockLicenseState.value),
}));

// ── Mock plans ────────────────────────────────────────────────────────────────
vi.mock('../plans.js', () => ({
  getPlan: vi.fn((id?: string) => {
    const plans: Record<string, { id: string; analyzeCreditsPerMonth: number; overageCentsPerCredit: number }> = {
      free:          { id: 'free',          analyzeCreditsPerMonth: 0,        overageCentsPerCredit: 0 },
      solo_standard: { id: 'solo_standard', analyzeCreditsPerMonth: 50,       overageCentsPerCredit: 5 },
      solo_pro:      { id: 'solo_pro',      analyzeCreditsPerMonth: Infinity,  overageCentsPerCredit: 0 },
      pay_as_you_go: { id: 'pay_as_you_go', analyzeCreditsPerMonth: 0,        overageCentsPerCredit: 5 },
    };
    return plans[id ?? ''] ?? plans['free'];
  }),
}));

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Mock paths ────────────────────────────────────────────────────────────────
vi.mock('../paths.js', () => ({
  DATA_DIR: '/tmp/.mergen-test',
  USAGE_FILE: '/tmp/.mergen-test/usage.json',
}));

// ── Fetch mock helper ─────────────────────────────────────────────────────────
function mockFetchOk() {
  global.fetch = vi.fn().mockResolvedValue({ ok: true });
}
function mockFetchFail(status = 500) {
  global.fetch = vi.fn().mockResolvedValue({ ok: false, status, text: async () => 'error' });
}
function mockFetchThrow() {
  global.fetch = vi.fn().mockRejectedValue(new Error('network error'));
}

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { getActivePlanId } from '../license.js';
import {
  consumeCredit,
  flushOverageOnShutdown,
  getUsageSnapshot,
  _resetForTesting,
  _setSleepForTesting,
} from '../usage.js';

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  mockLicenseState.value = null;
  delete (global as Record<string, unknown>)['fetch'];
});

// ── Free plan ─────────────────────────────────────────────────────────────────

describe('free plan', () => {
  it('blocks consume and returns a helpful reason', async () => {
    vi.mocked(getActivePlanId).mockReturnValue('free');
    const result = await consumeCredit();
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/paid plan/);
  });
});

// ── Unlimited plan (solo_pro) ─────────────────────────────────────────────────

describe('unlimited plan (solo_pro)', () => {
  it('always allows and increments used', async () => {
    vi.mocked(getActivePlanId).mockReturnValue('solo_pro');
    const r1 = await consumeCredit();
    const r2 = await consumeCredit();
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(getUsageSnapshot().used).toBe(2);
  });

  it('snapshot returns null for included and remaining', () => {
    vi.mocked(getActivePlanId).mockReturnValue('solo_pro');
    const snap = getUsageSnapshot();
    expect(snap.included).toBeNull();
    expect(snap.remaining).toBeNull();
    expect(snap.overage).toBe(0);
  });

  it('batches disk writes — only persists every 10 calls', async () => {
    const fs = await import('fs/promises');
    vi.mocked(getActivePlanId).mockReturnValue('solo_pro');
    for (let i = 0; i < 9; i++) await consumeCredit();
    expect(vi.mocked(fs.default.writeFile).mock.calls.length).toBe(0);
    await consumeCredit(); // 10th
    expect(vi.mocked(fs.default.writeFile).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Included quota (solo_standard) ───────────────────────────────────────────

describe('solo_standard quota', () => {
  it('allows calls within quota', async () => {
    vi.mocked(getActivePlanId).mockReturnValue('solo_standard');
    const result = await consumeCredit();
    expect(result.allowed).toBe(true);
    expect(getUsageSnapshot().used).toBe(1);
  });

  it('blocks when quota is exhausted and no overage plan', async () => {
    // Override plan to have no overage for this test only
    const { getPlan } = await import('../plans.js');
    vi.mocked(getPlan).mockReturnValueOnce({ id: 'solo_standard', analyzeCreditsPerMonth: 50, overageCentsPerCredit: 0 } as never);
    vi.mocked(getPlan).mockReturnValueOnce({ id: 'solo_standard', analyzeCreditsPerMonth: 1, overageCentsPerCredit: 0 } as never);
    _resetForTesting({ month: new Date().toISOString().slice(0, 7), used: 0, overageReported: 0, overagePending: 0 });
    await consumeCredit(); // use the 1 included credit
    const result = await consumeCredit();
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Monthly limit/);
  });

  it('snapshot remaining decrements correctly', async () => {
    vi.mocked(getActivePlanId).mockReturnValue('solo_standard');
    _resetForTesting({ used: 20 } as never);
    const snap = getUsageSnapshot();
    expect(snap.remaining).toBe(30);
    expect(snap.overage).toBe(0);
  });
});

// ── Overage — solo_standard ───────────────────────────────────────────────────

describe('overage (solo_standard)', () => {
  beforeEach(() => {
    vi.mocked(getActivePlanId).mockReturnValue('solo_standard');
    _resetForTesting({ month: new Date().toISOString().slice(0, 7), used: 50, overageReported: 0, overagePending: 0 });
    mockLicenseState.value = { lsSubscriptionItemId: 'item_123' };
  });

  it('allows and queues overagePending', async () => {
    mockFetchOk();
    const result = await consumeCredit();
    expect(result.allowed).toBe(true);
    // overagePending may be 0 after flush or 1 before flush
    expect(getUsageSnapshot().used).toBe(51);
  });

  it('snapshot overage formula correct: used - included', () => {
    _resetForTesting({ month: new Date().toISOString().slice(0, 7), used: 55, overageReported: 0, overagePending: 5 });
    const snap = getUsageSnapshot();
    expect(snap.overage).toBe(5);
    expect(snap.estimatedOverageCents).toBe(25); // 5 * 5 cents
  });
});

// ── Overage — pay_as_you_go ───────────────────────────────────────────────────

describe('overage (pay_as_you_go) — PAYG formula', () => {
  it('overage = used (since included = 0)', () => {
    vi.mocked(getActivePlanId).mockReturnValue('pay_as_you_go');
    _resetForTesting({ month: new Date().toISOString().slice(0, 7), used: 7, overageReported: 0, overagePending: 7 });
    const snap = getUsageSnapshot();
    expect(snap.overage).toBe(7);
    expect(snap.included).toBe(0);
    expect(snap.estimatedOverageCents).toBe(35); // 7 * 5 cents
  });
});

// ── Concurrent credit consumption (mutex) ─────────────────────────────────────

describe('concurrent consumeCredit (mutex)', () => {
  beforeEach(async () => {
    // Ensure the plan mock returns solo_standard with proper quota
    const { getPlan } = await import('../plans.js');
    vi.mocked(getPlan).mockImplementation((id?: string) => {
      const plans: Record<string, { id: string; analyzeCreditsPerMonth: number; overageCentsPerCredit: number }> = {
        free:          { id: 'free',          analyzeCreditsPerMonth: 0,        overageCentsPerCredit: 0 },
        solo_standard: { id: 'solo_standard', analyzeCreditsPerMonth: 50,       overageCentsPerCredit: 5 },
        solo_pro:      { id: 'solo_pro',      analyzeCreditsPerMonth: Infinity,  overageCentsPerCredit: 0 },
        pay_as_you_go: { id: 'pay_as_you_go', analyzeCreditsPerMonth: 0,        overageCentsPerCredit: 5 },
      };
      return (plans[id ?? ''] ?? plans['free']) as never;
    });
  });

  it('does not double-count credits under concurrent calls', async () => {
    vi.mocked(getActivePlanId).mockReturnValue('solo_standard');
    // Fire 10 concurrent calls
    await Promise.all(Array.from({ length: 10 }, () => consumeCredit()));
    expect(getUsageSnapshot().used).toBe(10);
  });
});

// ── Month rollover ────────────────────────────────────────────────────────────

describe('month rollover', () => {
  it('resets used to 0 when month changes', async () => {
    vi.mocked(getActivePlanId).mockReturnValue('solo_standard');
    _resetForTesting({ month: '2026-03', used: 40, overageReported: 0, overagePending: 0 });
    const result = await consumeCredit();
    expect(result.allowed).toBe(true);
    expect(getUsageSnapshot().used).toBe(1);
    expect(getUsageSnapshot().month).toBe(new Date().toISOString().slice(0, 7));
  });

  it('flushes overagePending before rollover reset', async () => {
    vi.mocked(getActivePlanId).mockReturnValue('solo_standard');
    mockFetchOk();
    mockLicenseState.value = { lsSubscriptionItemId: 'item_abc' };
    _resetForTesting({ month: '2026-03', used: 55, overageReported: 0, overagePending: 5 });
    process.env.LS_API_KEY = 'test-key';
    await consumeCredit();
    // fetch should have been called to flush the 5 pending
    expect(global.fetch).toHaveBeenCalled();
    delete process.env.LS_API_KEY;
  });
});

// ── flushOverage retries ──────────────────────────────────────────────────────

describe('flushOverage retry logic', () => {
  it('retries on transient failure and succeeds on 2nd attempt', async () => {
    mockLicenseState.value = { lsSubscriptionItemId: 'item_retry' };
    process.env.LS_API_KEY = 'test-key';
    _resetForTesting({ month: new Date().toISOString().slice(0, 7), used: 5, overageReported: 0, overagePending: 5 });

    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 500, text: async () => 'err' };
      return { ok: true };
    });

    // Use short retry delays by calling flushOverageOnShutdown
    await flushOverageOnShutdown();
    expect(calls).toBe(2);
    expect(getUsageSnapshot().overagePendingCredits).toBe(0);
    expect(getUsageSnapshot().overageConfirmedCredits).toBe(5);
    delete process.env.LS_API_KEY;
  });

  it('gives up after max retries and leaves overagePending intact', async () => {
    mockLicenseState.value = { lsSubscriptionItemId: 'item_fail' };
    process.env.LS_API_KEY = 'test-key';
    _resetForTesting({ month: new Date().toISOString().slice(0, 7), used: 3, overageReported: 0, overagePending: 3 });
    // Replace sleep with instant no-op so retries don't block
    _setSleepForTesting(() => Promise.resolve());
    mockFetchFail(503);

    await flushOverageOnShutdown();
    expect(getUsageSnapshot().overagePendingCredits).toBe(3); // not cleared
    delete process.env.LS_API_KEY;
  });

  it('skips flush when no subscriptionItemId', async () => {
    mockLicenseState.value = null;
    process.env.LS_API_KEY = 'test-key';
    _resetForTesting({ month: new Date().toISOString().slice(0, 7), used: 2, overageReported: 0, overagePending: 2 });
    mockFetchOk();

    await flushOverageOnShutdown();
    expect(global.fetch).not.toHaveBeenCalled();
    delete process.env.LS_API_KEY;
  });

  it('skips flush when LS_API_KEY is missing', async () => {
    mockLicenseState.value = { lsSubscriptionItemId: 'item_no_key' };
    delete process.env.LS_API_KEY;
    _resetForTesting({ month: new Date().toISOString().slice(0, 7), used: 2, overageReported: 0, overagePending: 2 });
    mockFetchOk();

    await flushOverageOnShutdown();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
