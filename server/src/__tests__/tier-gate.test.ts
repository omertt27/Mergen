/**
 * tier-gate.test.ts — Verifies plan-tier access control for MCP tools.
 *
 * Covers:
 *  1. planAllowsTier — mapping of plan IDs to allowed tool tiers
 *  2. withTierGate   — wrapper returns upgrade prompt for blocked callers
 *  3. getTierForTool — manifest lookup returns correct tier per tool
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  planAllowsTier, planAllowsGate, planMeetsMin, planHasCapability,
  minPlanForGate, getPlanRank,
} from '../intelligence/plans.js';
import { getTierForTool, ALL_TOOLS } from '../intelligence/tool-manifest.js';

// Mock license module so withTierGate tests can control the active plan.
// vi.mock is hoisted by vitest — this runs before any imports.
vi.mock('../intelligence/license.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getActivePlanId: vi.fn(() => 'free'),
  };
});

// Import after mock is registered
const { getActivePlanId } = await import('../intelligence/license.js');
const { withTierGate } = await import('../intelligence/tools-state.js');
const mockGetActivePlanId = vi.mocked(getActivePlanId);

// ── planAllowsTier ────────────────────────────────────────────────────────────

describe('planAllowsTier', () => {
  it('free plan: allows free and all tiers', () => {
    expect(planAllowsTier('free', 'free')).toBe(true);
    expect(planAllowsTier('free', 'all')).toBe(true);
  });

  it('free plan: blocks pro tier', () => {
    expect(planAllowsTier('free', 'pro')).toBe(false);
  });

  it('unknown/undefined plan falls back to free rules', () => {
    expect(planAllowsTier(undefined, 'pro')).toBe(false);
    expect(planAllowsTier('nonexistent', 'pro')).toBe(false);
  });

  it.each([
    'starter', 'team', 'platform', 'enterprise',
    'solo_starter', 'solo_pro', 'solo_power', 'pay_as_you_go'
  ])(
    '%s plan allows pro tier',
    (planId) => {
      expect(planAllowsTier(planId, 'pro')).toBe(true);
    },
  );

  it.each([
    'starter', 'team', 'platform', 'enterprise',
    'solo_starter', 'solo_pro', 'solo_power', 'pay_as_you_go'
  ])(
    '%s plan also allows free and all tiers',
    (planId) => {
      expect(planAllowsTier(planId, 'free')).toBe(true);
      expect(planAllowsTier(planId, 'all')).toBe(true);
    },
  );
});

// ── withTierGate ──────────────────────────────────────────────────────────────

describe('withTierGate', () => {
  const successResult = { content: [{ type: 'text' as const, text: 'ok' }] };

  beforeEach(() => {
    mockGetActivePlanId.mockReturnValue('free');
  });

  it('passes through for tier:all regardless of plan (free)', async () => {
    const handler = vi.fn().mockResolvedValue(successResult);
    const result = await withTierGate('all', handler)();
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toBe(successResult);
  });

  it('passes through for tier:free regardless of plan', async () => {
    const handler = vi.fn().mockResolvedValue(successResult);
    const result = await withTierGate('free', handler)();
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toBe(successResult);
  });

  it('blocks pro tool on free plan and returns upgrade prompt naming the plan', async () => {
    mockGetActivePlanId.mockReturnValue('free');
    const handler = vi.fn().mockResolvedValue(successResult);
    const result = await withTierGate('pro', handler)();
    expect(handler).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('requires the Starter plan');
    expect(result.content[0].text).toContain('mergen.dev/pricing');
  });

  it('blocks a team-gated tool on starter and names the Team plan', async () => {
    mockGetActivePlanId.mockReturnValue('starter');
    const handler = vi.fn().mockResolvedValue(successResult);
    const result = await withTierGate('team', handler)();
    expect(handler).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('requires the Team plan');
  });

  it('allows a team-gated tool on platform (higher plan)', async () => {
    mockGetActivePlanId.mockReturnValue('platform');
    const handler = vi.fn().mockResolvedValue(successResult);
    const result = await withTierGate('team', handler)();
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toBe(successResult);
  });

  it('upgrade prompt mentions get_status and /license endpoint', async () => {
    mockGetActivePlanId.mockReturnValue('free');
    const handler = vi.fn();
    const result = await withTierGate('pro', handler)();
    expect(result.content[0].text).toContain('get_status');
    expect(result.content[0].text).toContain('/license');
  });

  it('allows pro tool on solo_starter plan', async () => {
    mockGetActivePlanId.mockReturnValue('solo_starter');
    const handler = vi.fn().mockResolvedValue(successResult);
    const result = await withTierGate('pro', handler)();
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toBe(successResult);
  });

  it('allows pro tool on solo_pro plan', async () => {
    mockGetActivePlanId.mockReturnValue('solo_pro');
    const handler = vi.fn().mockResolvedValue(successResult);
    const result = await withTierGate('pro', handler)();
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toBe(successResult);
  });

  it('passes handler args through when allowed', async () => {
    mockGetActivePlanId.mockReturnValue('solo_pro');
    const handler = vi.fn().mockResolvedValue(successResult);
    await withTierGate('pro', handler)('arg1', 42);
    expect(handler).toHaveBeenCalledWith('arg1', 42);
  });
});

// ── getTierForTool ────────────────────────────────────────────────────────────

describe('getTierForTool', () => {
  it('execute_fix is pro', () => {
    expect(getTierForTool('execute_fix')).toBe('pro');
  });

  it('triage_incident is all', () => {
    expect(getTierForTool('triage_incident')).toBe('all');
  });

  it('get_status is all', () => {
    expect(getTierForTool('get_status')).toBe('all');
  });

  it('get_backend_logs is pro', () => {
    expect(getTierForTool('get_backend_logs')).toBe('pro');
  });

  it('unknown tool defaults to all', () => {
    expect(getTierForTool('nonexistent_tool')).toBe('all');
  });

  it('escalates to minPlan when a tool defines one', () => {
    expect(getTierForTool('get_blast_radius')).toBe('team');
    expect(getTierForTool('get_attribution_accuracy')).toBe('team');
    expect(getTierForTool('get_audit_log')).toBe('team');
  });

  it('every tool in ALL_TOOLS resolves to its minPlan ?? tier', () => {
    for (const entry of ALL_TOOLS) {
      expect(getTierForTool(entry.name)).toBe(entry.minPlan ?? entry.tier);
    }
  });
});

// ── Ordered ladder helpers ──────────────────────────────────────────────────────

describe('ordered plan ladder', () => {
  it('ranks ascend free < starter < team < platform < enterprise', () => {
    expect(getPlanRank('free')).toBeLessThan(getPlanRank('starter'));
    expect(getPlanRank('starter')).toBeLessThan(getPlanRank('team'));
    expect(getPlanRank('team')).toBeLessThan(getPlanRank('platform'));
    expect(getPlanRank('platform')).toBeLessThan(getPlanRank('enterprise'));
  });

  it('legacy aliases share the rank of their canonical plan', () => {
    expect(getPlanRank('solo_starter')).toBe(getPlanRank('starter'));
    expect(getPlanRank('solo_pro')).toBe(getPlanRank('team'));
    expect(getPlanRank('solo_power')).toBe(getPlanRank('platform'));
    expect(getPlanRank('pay_as_you_go')).toBe(getPlanRank('enterprise'));
  });

  it('planMeetsMin is an inclusive rank comparison', () => {
    expect(planMeetsMin('team', 'team')).toBe(true);
    expect(planMeetsMin('platform', 'team')).toBe(true);
    expect(planMeetsMin('starter', 'team')).toBe(false);
    expect(planMeetsMin(undefined, 'starter')).toBe(false);
  });

  it('planAllowsGate handles both coarse tiers and min-plan ids', () => {
    expect(planAllowsGate('starter', 'pro')).toBe(true);
    expect(planAllowsGate('free', 'pro')).toBe(false);
    expect(planAllowsGate('starter', 'team')).toBe(false);
    expect(planAllowsGate('team', 'team')).toBe(true);
    expect(planAllowsGate('free', 'all')).toBe(true);
  });

  it('minPlanForGate maps tiers to the lowest satisfying plan', () => {
    expect(minPlanForGate('free')).toBe('free');
    expect(minPlanForGate('all')).toBe('free');
    expect(minPlanForGate('pro')).toBe('starter');
    expect(minPlanForGate('team')).toBe('team');
  });
});

// ── Capability flags ────────────────────────────────────────────────────────────

describe('planHasCapability', () => {
  it('free and starter unlock no governance primitives', () => {
    for (const cap of ['hitlApproval', 'overrideCorpusEnforce', 'ciGate', 'agentIam'] as const) {
      expect(planHasCapability('free', cap)).toBe(false);
      expect(planHasCapability('starter', cap)).toBe(false);
    }
  });

  it('team unlocks HITL + override corpus enforcement, not CI or IAM', () => {
    expect(planHasCapability('team', 'hitlApproval')).toBe(true);
    expect(planHasCapability('team', 'overrideCorpusEnforce')).toBe(true);
    expect(planHasCapability('team', 'ciGate')).toBe(false);
    expect(planHasCapability('team', 'agentIam')).toBe(false);
  });

  it('platform adds the CI gate; only enterprise unlocks Agent IAM', () => {
    expect(planHasCapability('platform', 'ciGate')).toBe(true);
    expect(planHasCapability('platform', 'agentIam')).toBe(false);
    expect(planHasCapability('enterprise', 'agentIam')).toBe(true);
  });

  it('legacy aliases inherit their canonical plan capabilities', () => {
    expect(planHasCapability('solo_pro', 'overrideCorpusEnforce')).toBe(true);
    expect(planHasCapability('pay_as_you_go', 'agentIam')).toBe(true);
  });
});