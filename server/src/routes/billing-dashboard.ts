/**
 * routes/billing-dashboard.ts — Unified billing dashboard API.
 *
 *   GET /billing/dashboard   — current plan + live usage + upgrade guidance
 *   GET /billing/plans       — all plans as structured comparison
 *   GET /billing/usage       — usage snapshot + 3-month trend
 *
 * Designed as a single call for the billing settings page. Returns everything
 * needed to render plan status, usage bar, overage cost, and upgrade CTA
 * without requiring the caller to aggregate multiple endpoints.
 */

import { Router } from 'express';
import { getLicenseState, getActivePlanId } from '../intelligence/license.js';
import { getPlan, PLANS } from '../intelligence/plans.js';
import { getUsageSnapshot } from '../intelligence/usage.js';

const DOCS_URL = 'https://mergen.dev/pricing';

function nextResetLabel(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const diffDays = Math.ceil((next.getTime() - now.getTime()) / 86_400_000);
  return `${next.toISOString().slice(0, 10)} (${diffDays} day${diffDays !== 1 ? 's' : ''})`;
}

function usagePercent(used: number, included: number | null): number | null {
  if (included === null || included === 0) return null;
  return Math.min(100, Math.round((used / included) * 100));
}

export function createBillingDashboardRouter(): Router {
  const router = Router();

  // ── GET /billing/dashboard ────────────────────────────────────────────────
  router.get('/billing/dashboard', (_req, res) => {
    const planId  = getActivePlanId();
    const plan    = getPlan(planId);
    const state   = getLicenseState();
    const usage   = getUsageSnapshot();

    const isPaid  = planId !== 'free';
    const isPayg  = planId === 'pay_as_you_go';

    // Usage bar
    const pctUsed  = usagePercent(usage.used, usage.included);
    const nearLimit = pctUsed !== null && pctUsed >= 80 && !isPayg;
    const atLimit   = pctUsed !== null && pctUsed >= 100 && !isPayg;

    // Overage cost estimate
    const overageCostCents  = usage.estimatedOverageCents;
    const overageCostDollars = overageCostCents > 0 ? (overageCostCents / 100).toFixed(2) : null;

    // Upgrade guidance
    let upgradeMessage: string | null = null;
    let upgradePlan: string | null = null;
    if (atLimit) {
      upgradeMessage = `You've reached your ${usage.included} credit limit for ${usage.month}. Upgrade to keep running analyses.`;
      upgradePlan = plan.ctaUrl;
    } else if (nearLimit && usage.remaining !== null) {
      upgradeMessage = `${usage.remaining} credits remaining this month. Consider upgrading to avoid interruption.`;
      upgradePlan = plan.ctaUrl;
    } else if (!isPaid) {
      upgradeMessage = 'Upgrade to unlock backend observability, more credits, and autonomous execution.';
      upgradePlan = DOCS_URL;
    }

    res.json({
      ok: true,
      plan: {
        id:       plan.id,
        name:     plan.name,
        tagline:  plan.tagline,
        seats:    plan.seats,
        isPaid,
        ctaUrl:   plan.ctaUrl,
      },
      license: state ? {
        email:       state.customerEmail ?? null,
        status:      (state as Record<string, unknown>).status ?? 'active',
        activatedAt: (state as Record<string, unknown>).validatedAt ?? null,
      } : null,
      usage: {
        month:           usage.month,
        used:            usage.used,
        included:        usage.included,
        remaining:       usage.remaining,
        percentUsed:     pctUsed,
        overageCredits:  usage.overage,
        overagePending:  usage.overagePendingCredits,
        estimatedOverageDollars: overageCostDollars,
        nearLimit,
        atLimit,
      },
      billing: {
        nextResetOn:      nextResetLabel(),
        overageCentsPerCredit: plan.overageCentsPerCredit as number,
        docsUrl:          DOCS_URL,
      },
      upgrade: upgradeMessage ? { message: upgradeMessage, url: upgradePlan } : null,
    });
  });

  // ── GET /billing/plans ────────────────────────────────────────────────────
  router.get('/billing/plans', (_req, res) => {
    const activePlanId = getActivePlanId();
    const plans = Object.values(PLANS).map((p) => ({
      id:                      p.id,
      name:                    p.name,
      tagline:                 p.tagline,
      seats:                   p.seats,
      bufferSize:              p.bufferSize,
      backendObservability:    p.backendObservability,
      analyzeCreditsPerMonth:  (p.analyzeCreditsPerMonth as number) === Infinity ? null : p.analyzeCreditsPerMonth,
      overageCentsPerCredit:   p.overageCentsPerCredit as number,
      overagePriceLabel:       (p.overageCentsPerCredit as number) > 0
        ? `$${((p.overageCentsPerCredit as number) / 100).toFixed(2)} / credit over limit`
        : 'No overage — hard stop at limit',
      ctaUrl:                  p.ctaUrl,
      active:                  p.id === activePlanId,
    }));

    res.json({ ok: true, plans, activePlanId });
  });

  // ── GET /billing/usage ────────────────────────────────────────────────────
  router.get('/billing/usage', (_req, res) => {
    const planId = getActivePlanId();
    const plan   = getPlan(planId);
    const usage  = getUsageSnapshot();

    // Warn thresholds for the calling UI
    const pctUsed = usagePercent(usage.used, usage.included);
    const status  = !pctUsed ? 'ok'
      : pctUsed >= 100 ? 'at_limit'
      : pctUsed >= 80  ? 'near_limit'
      : 'ok';

    res.json({
      ok: true,
      current: {
        month:                   usage.month,
        used:                    usage.used,
        included:                usage.included,
        remaining:               usage.remaining,
        percentUsed:             pctUsed,
        overage:                 usage.overage,
        overagePendingCredits:   usage.overagePendingCredits,
        overageConfirmedCredits: usage.overageConfirmedCredits,
        estimatedOverageCents:   usage.estimatedOverageCents,
        estimatedOverageDollars: usage.estimatedOverageCents > 0
          ? (usage.estimatedOverageCents / 100).toFixed(2)
          : null,
        status,
      },
      plan: {
        id:   plan.id,
        name: plan.name,
        overageCentsPerCredit: plan.overageCentsPerCredit as number,
        ctaUrl: plan.ctaUrl,
      },
      guidance: status === 'at_limit'
        ? { message: `Monthly limit reached. Upgrade or wait for reset on ${nextResetLabel()}.`, url: plan.ctaUrl }
        : status === 'near_limit'
        ? { message: `Approaching limit (${pctUsed}% used). Consider upgrading.`, url: plan.ctaUrl }
        : null,
    });
  });

  return router;
}
