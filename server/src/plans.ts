/**
 * plans.ts — Mergen pricing plan definitions
 *
 * Plans:
 *   free     – local bridge only, capped buffer, no analyze_runtime
 *   solo     – $19/mo Standard | $39/mo Pro (analyze credits included)
 *   team     – $49/seat/mo (shared context, unlimited credits)
 *
 * Usage-based:
 *   pay_as_you_go – $0.05 / analyze_runtime call, no subscription
 */

export type PlanId = 'free' | 'solo_standard' | 'solo_pro' | 'team' | 'pay_as_you_go';

export interface Plan {
  id: PlanId;
  name: string;
  /** monthly price in USD cents, 0 = free */
  priceUsdCents: number;
  /** max events in ring buffer (200 = no effective limit given the hard cap) */
  bufferSize: number;
  /** monthly analyze_runtime credits included, Infinity = unlimited */
  analyzeCreditsPerMonth: number;
  /** cost per additional credit in USD cents (0 = credits can't be topped up) */
  overageCentsPerCredit: number;
  /** team sync feature */
  teamSync: boolean;
  /** LemonSqueezy variant IDs — set from env or filled in after product creation */
  lsVariantId: string | null;
  /**
   * LemonSqueezy subscription item ID for usage-based billing.
   * Required for pay_as_you_go and solo_standard overage reporting.
   * Stored in ~/.mergen/license.json after activation so we don't need it at build time.
   */
  lsSubscriptionItemId?: string | null;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceUsdCents: 0,
    bufferSize: 50,            // only 50 events visible to the AI
    // 10 free analyze_runtime calls per month — the "feel the magic" allowance.
    // Without this, the free plan delivers only raw logs (already in DevTools)
    // and conversion is structurally blocked. 10/month is enough to taste the
    // Hypothesis Engine without cannibalising paid tiers (typical solo dev
    // usage is ~30/mo per our internal estimates).
    analyzeCreditsPerMonth: 10,
    overageCentsPerCredit: 0,  // free tier never bills — hard cap at 10
    teamSync: false,
    lsVariantId: null,
  },
  solo_standard: {
    id: 'solo_standard',
    name: 'Solo Standard',
    priceUsdCents: 1900,
    bufferSize: 200,
    analyzeCreditsPerMonth: 500,
    overageCentsPerCredit: 5,  // $0.05 per extra call
    teamSync: false,
    lsVariantId: process.env.LS_VARIANT_SOLO_STANDARD ?? null,
    lsSubscriptionItemId: null, // set after activation
  },
  solo_pro: {
    id: 'solo_pro',
    name: 'Solo Pro',
    priceUsdCents: 3900,
    bufferSize: 200,
    analyzeCreditsPerMonth: Infinity,
    overageCentsPerCredit: 0,
    teamSync: false,
    lsVariantId: process.env.LS_VARIANT_SOLO_PRO ?? null,
  },
  team: {
    id: 'team',
    name: 'Team',
    priceUsdCents: 4900,       // per seat
    bufferSize: 200,
    analyzeCreditsPerMonth: Infinity,
    overageCentsPerCredit: 0,
    teamSync: true,
    lsVariantId: process.env.LS_VARIANT_TEAM ?? null,
  },
  pay_as_you_go: {
    id: 'pay_as_you_go',
    name: 'Pay-as-you-go',
    priceUsdCents: 0,
    bufferSize: 200,
    analyzeCreditsPerMonth: 0,
    overageCentsPerCredit: 5,  // every call costs $0.05
    teamSync: false,
    lsVariantId: process.env.LS_VARIANT_PAYG ?? null,
    lsSubscriptionItemId: null, // set after activation
  },
};

export function getPlan(id: PlanId | string | undefined): Plan {
  return PLANS[(id as PlanId) ?? 'free'] ?? PLANS.free;
}
