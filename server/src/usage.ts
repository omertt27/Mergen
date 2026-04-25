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
import path from 'path';
import os from 'os';
import { lemonSqueezySetup } from '@lemonsqueezy/lemonsqueezy.js';
import { getActivePlanId, getLicenseState } from './license.js';
import { getPlan } from './plans.js';
import logger from './logger.js';

const DATA_DIR   = path.join(os.homedir(), '.mergen');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

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

// ── In-memory state ───────────────────────────────────────────────────────────

let _usage: UsageState = {
  month: currentMonth(),
  used: 0,
  overageReported: 0,
  overagePending: 0,
};

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // "2026-04"
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
    await flushOverage();
  }
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

export function getUsageSnapshot() {
  const plan = getPlan(getActivePlanId());
  const included = plan.analyzeCreditsPerMonth;
  const remaining = included === Infinity ? Infinity : Math.max(0, included - _usage.used);
  const overage = included === Infinity ? 0 : Math.max(0, _usage.used - (included === 0 ? 0 : included));
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
 * Report pending overage to LemonSqueezy usage-based billing API.
 * POST /v1/usage-records with quantity = overagePending.
 */
async function flushOverage(): Promise<void> {
  const qty = _usage.overagePending;
  if (qty <= 0) return;

  const licState = getLicenseState() as (typeof getLicenseState extends () => infer R ? R : never) & Record<string, unknown> | null;
  const subscriptionItemId = licState?.['lsSubscriptionItemId'] as string | undefined;

  if (!subscriptionItemId) {
    logger.warn({ qty }, 'overageFlush skipped — no lsSubscriptionItemId; will retry when license is updated');
    return;
  }

  const apiKey = process.env.LS_API_KEY;
  if (!apiKey) {
    logger.warn('overageFlush skipped — LS_API_KEY not set');
    return;
  }

  try {
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
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error({ status: res.status, body }, 'LS usage record creation failed — will retry');
      return;
    }

    _usage.overageReported += qty;
    _usage.overagePending = 0;
    await saveUsage();
    logger.info({ qty, totalReported: _usage.overageReported }, 'overage reported to LemonSqueezy ✓');
  } catch (err) {
    logger.warn({ err, qty }, 'overage report request failed — will retry on next startup');
  }
}

// Debounced flush — batch rapid calls into a single API request (5 s window)
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (_flushTimer) return;
  _flushTimer = setTimeout(async () => {
    _flushTimer = null;
    await flushOverage();
  }, 5_000);
}

// ── Credit consumption ────────────────────────────────────────────────────────

/**
 * Attempt to consume one credit.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export async function consumeCredit(): Promise<{ allowed: boolean; reason?: string }> {
  // Refresh month boundary
  if (_usage.month !== currentMonth()) {
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
    await saveUsage();
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

    const overageCount = plan.id === 'pay_as_you_go' ? _usage.used : _usage.used - included;
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
}

/**
 * Force-flush any pending overage records. Called on graceful shutdown.
 */
export async function flushOverageOnShutdown(): Promise<void> {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  await flushOverage();
}
