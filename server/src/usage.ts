/**
 * usage.ts — Monthly analyze_runtime credit tracking, persisted to disk.
 *
 * Credits reset on the 1st of every calendar month (UTC).
 * State file: ~/.mergen/usage.json
 *
 * Pay-as-you-go / overage flow:
 *   When a credit is consumed beyond the included quota (or on PAYG), a usage
 *   record is reported to LemonSqueezy via their usage-based billing API.
 *   LemonSqueezy charges the customer at their next billing cycle.
 *
 *   The subscription item ID is stored in ~/.mergen/license.json under
 *   `lsSubscriptionItemId` — populated by the billing webhook handler when a
 *   subscription_created / order_created event arrives.
 */

import fs from 'fs/promises';
import { lemonSqueezySetup } from '@lemonsqueezy/lemonsqueezy.js';
import { getActivePlanId, getLicenseState } from './license.js';
import { getPlan } from './plans.js';
import { DATA_DIR, USAGE_FILE } from './paths.js';
import logger from './logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const FLUSH_DEBOUNCE_MS  = 5_000;  // batch overage calls into one API request
const FETCH_TIMEOUT_MS   = 8_000;  // LS API request timeout
const FLUSH_MAX_RETRIES  = 3;      // exponential back-off attempts
const FLUSH_RETRY_BASE_MS = 2_000; // 2 s → 4 s → 8 s

// ── Types ─────────────────────────────────────────────────────────────────────

interface UsageState {
  /** "YYYY-MM" */
  month: string;
  /** credits consumed this month (included + overage) */
  used: number;
  /** overage credits already reported to LS */
  overageReported: number;
  /** overage credits accumulated but not yet sent to LS */
  overagePending: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// #7 — declared before first use
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // "2026-04"
}

let _sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function sleep(ms: number): Promise<void> { return _sleep(ms); }

// ── In-memory state ───────────────────────────────────────────────────────────

let _usage: UsageState = {
  month: currentMonth(),
  used: 0,
  overageReported: 0,
  overagePending: 0,
};

// #1 — mutex: serialise all read-modify-write operations
let _lock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _lock.then(fn);
  // Keep _lock as a void chain so a rejection in fn doesn't stall future calls
  _lock = next.then(() => undefined, () => undefined);
  return next;
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function loadUsage(): Promise<void> {
  try {
    const raw = await fs.readFile(USAGE_FILE, 'utf8');
    const parsed: UsageState = JSON.parse(raw);
    if (parsed.month === currentMonth()) {
      _usage = {
        month: parsed.month,
        used: parsed.used,
        overageReported: parsed.overageReported ?? 0,
        overagePending: parsed.overagePending ?? 0,
      };
    } else {
      // #2 — flush pending overage BEFORE wiping the previous month's state
      if (parsed.overagePending > 0) {
        _usage = { ...parsed };
        logger.info({ pending: parsed.overagePending }, 'flushing overage from previous month before rollover');
        await flushOverageWithRetry();
      }
      _usage = { month: currentMonth(), used: 0, overageReported: 0, overagePending: 0 };
      await saveUsage();
    }
  } catch {
    _usage = { month: currentMonth(), used: 0, overageReported: 0, overagePending: 0 };
  }
}

async function saveUsage(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(USAGE_FILE, JSON.stringify(_usage, null, 2), 'utf8');
}

export async function initUsage(): Promise<void> {
  await loadUsage();
  logger.info({ used: _usage.used, month: _usage.month }, 'usage loaded');

  const apiKey = process.env.LS_API_KEY;
  if (apiKey) lemonSqueezySetup({ apiKey });

  // Flush any overage that wasn't reported before last shutdown
  if (_usage.overagePending > 0) {
    logger.info({ pending: _usage.overagePending }, 'flushing pending overage on startup');
    await flushOverageWithRetry();
  }
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

export function getUsageSnapshot() {
  const plan = getPlan(getActivePlanId());
  const included = plan.analyzeCreditsPerMonth;
  const remaining = included === Infinity ? Infinity : Math.max(0, included - _usage.used);
  // #3 — correct overage formula for all plans including PAYG (included === 0)
  const overage = included === Infinity ? 0 : Math.max(0, _usage.used - included);
  return {
    planId: plan.id,
    month: _usage.month,
    used: _usage.used,
    included: included === Infinity ? null : included,
    remaining: remaining === Infinity ? null : remaining,
    overage,
    overageReported: _usage.overageReported,
    overagePending: _usage.overagePending,
    overageCentsPerCredit: plan.overageCentsPerCredit,
    estimatedOverageCents: overage * plan.overageCentsPerCredit,
  };
}

// ── LemonSqueezy usage reporting ──────────────────────────────────────────────

/**
 * Send one usage-record POST to LS. Returns true on success.
 */
async function postOverage(qty: number, subscriptionItemId: string, apiKey: string): Promise<boolean> {
  const res = await fetch('https://api.lemonsqueezy.com/v1/usage-records', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/vnd.api+json',
      Accept: 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'usage-records',
        attributes: { quantity: qty, action: 'increment' },
        relationships: {
          'subscription-item': {
            data: { type: 'subscription-items', id: String(subscriptionItemId) },
          },
        },
      },
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body }, 'LS usage record creation failed');
    return false;
  }
  return true;
}

/**
 * #4 — Report pending overage with exponential back-off (up to FLUSH_MAX_RETRIES).
 */
async function flushOverageWithRetry(): Promise<void> {
  const qty = _usage.overagePending;
  if (qty <= 0) return;

  // #8 — use typed LicenseState; no cast gymnastics needed
  const licState = getLicenseState();
  const subscriptionItemId = licState?.lsSubscriptionItemId;

  if (!subscriptionItemId) {
    logger.warn({ qty }, 'overageFlush skipped — no lsSubscriptionItemId; will retry on next startup');
    return;
  }

  const apiKey = process.env.LS_API_KEY;
  if (!apiKey) {
    logger.warn('overageFlush skipped — LS_API_KEY not set');
    return;
  }

  for (let attempt = 1; attempt <= FLUSH_MAX_RETRIES; attempt++) {
    try {
      const ok = await postOverage(qty, subscriptionItemId, apiKey);
      if (ok) {
        _usage.overageReported += qty;
        _usage.overagePending = 0;
        await saveUsage();
        logger.info({ qty, totalReported: _usage.overageReported }, 'overage reported to LemonSqueezy ✓');
        return;
      }
    } catch (err) {
      logger.warn({ err, qty, attempt }, 'overage report request threw — will retry');
    }

    if (attempt < FLUSH_MAX_RETRIES) {
      const delay = FLUSH_RETRY_BASE_MS * 2 ** (attempt - 1); // 2 s, 4 s, 8 s
      logger.info({ delay, attempt }, 'retrying overage flush…');
      await sleep(delay);
    }
  }

  logger.warn({ qty }, 'overage flush exhausted retries — will retry on next startup');
}

// Debounced flush — batch rapid calls into a single API request
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    // #5 — catch errors so they don't become unhandled rejections
    flushOverageWithRetry().catch(err =>
      logger.error({ err }, 'scheduled overage flush failed'),
    );
  }, FLUSH_DEBOUNCE_MS);
}

// ── Credit consumption ────────────────────────────────────────────────────────

/**
 * Attempt to consume one credit.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export async function consumeCredit(): Promise<{ allowed: boolean; reason?: string }> {
  return withLock(async () => {
    // Refresh month boundary
    if (_usage.month !== currentMonth()) {
      // #2 — flush pending overage before resetting the counter
      if (_usage.overagePending > 0) {
        await flushOverageWithRetry();
      }
      _usage = { month: currentMonth(), used: 0, overageReported: 0, overagePending: 0 };
    }

    const plan = getPlan(getActivePlanId());

    if (plan.id === 'free') {
      return {
        allowed: false,
        reason: 'analyze_runtime requires a paid plan — visit the pricing page to upgrade',
      };
    }

    const included = plan.analyzeCreditsPerMonth;

    // Unlimited plans (solo_pro, team)
    if (included === Infinity) {
      _usage.used++;
      // #6 — batch writes for unlimited plans; persist every 10 calls
      if (_usage.used % 10 === 0) await saveUsage();
      return { allowed: true };
    }

    // Has remaining included credits
    if (_usage.used < included) {
      _usage.used++;
      await saveUsage();
      return { allowed: true };
    }

    // Pay-as-you-go / solo_standard overage — report to LemonSqueezy
    if (plan.overageCentsPerCredit > 0) {
      _usage.used++;
      _usage.overagePending++;
      await saveUsage();

      // #3 — correct overage count for PAYG (included === 0) vs quota plans
      const overageCount = _usage.used - included;
      logger.info(
        { overageCall: overageCount, pending: _usage.overagePending },
        'overage credit consumed — queued for LS reporting',
      );

      scheduleFlush();
      return { allowed: true };
    }

    return {
      allowed: false,
      reason:
        `Monthly limit of ${included} analyze_runtime credits reached. ` +
        `Upgrade to Solo Pro or Team for unlimited calls.`,
    };
  });
}

/**
 * Force-flush any pending overage records. Called on graceful shutdown.
 */
export async function flushOverageOnShutdown(): Promise<void> {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  await flushOverageWithRetry();
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Reset all module-level state. ONLY for use in unit tests.
 * Tree-shaken in production builds when not imported.
 */
export function _resetForTesting(overrides: Partial<UsageState> = {}): void {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _lock = Promise.resolve();
  _sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)); // restore real sleep
  _usage = {
    month: currentMonth(),
    used: 0,
    overageReported: 0,
    overagePending: 0,
    ...overrides,
  };
}

/** Override the sleep implementation. ONLY for use in unit tests. */
export function _setSleepForTesting(fn: (ms: number) => Promise<void>): void {
  _sleep = fn;
}
