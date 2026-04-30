/**
 * plans.ts — Mergen pricing plan definitions
 *
 * Open-core model:
 *   The client tooling (browser extension, VS Code extension, CLI bridge)
 *   is MIT-licensed and free forever. The Hypothesis Engine (analyze_runtime,
 *   calibration ranking, causal chain) is the paid surface — it's the only
 *   part that costs us money (LLM inference) and the only part where data
 *   quality > distribution volume.
 *
 * Plans:
 *   free            – full buffer (200 events), all local tools, 25 analyze/mo
 *   solo_standard   – $19/mo: 500 analyze credits + overage
 *   solo_pro        – $39/mo: unlimited analyze
 *   team            – $49/seat/mo: shared context, unlimited
 *   pay_as_you_go   – $0.05 / analyze_runtime call, no subscription
 *
 * Free tier design rationale:
 *   200-event buffer: real dev sessions routinely exceed 50 events in one
 *   page load. Capping at 50 means the free tier is broken for the exact
 *   users we want to impress. 200 is the same as paid — the moat is the
 *   Hypothesis Engine, not the buffer size.
 *
 *   25 analyze credits: enough to see the value (≈1/day on a heavy debug
 *   week) without cannibalising Solo Standard (≈20/day capacity).
 *   Critically: free users who hit the limit become paid users, not
 *   churned users — they've already seen the diagnosis work.
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
    bufferSize: 200,           // same as paid — the moat is the Engine, not the buffer
    // 25 free analyze_runtime calls/month — enough to feel the value on a real
    // debug session (~1/day during an intense week) without replacing paid tiers.
    // Free users who exhaust 25 calls have seen it work; they convert. Free users
    // who never hit the limit were never going to pay anyway.
    analyzeCreditsPerMonth: 25,
    overageCentsPerCredit: 0,  // hard cap at 25 — never surprise-bills free users
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
