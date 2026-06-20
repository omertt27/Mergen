import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runAgentPipeline,
  runAgentPipelineAsync,
  registerGovernanceHook,
  clearGovernanceHooks,
  type GovernanceHookContext,
} from '../intelligence/agent-pipeline.js';
import type { CausalChain } from '../intelligence/causal.js';

describe('agent-pipeline: runAgentPipelineAsync with async pre-execution hooks', () => {
  const mockChain: CausalChain = {
    errors: [{ message: 'Service database degraded', ts: Date.now(), primaryFrame: null }],
    correlatedNetwork: [],
    correlatedBackend: [],
    chain: [],
    contextPack: '',
    stateAtError: null,
    hypotheses: [
      {
        tag: 'infra_db_connection_pool',
        summary: 'DB pool degradation',
        confidence: 'HIGH',
        confidenceScore: 0.95,
        evidence: ['degraded'],
        causalPath: ['pool slow'],
        fixHint: 'systemctl restart postgresql',
        remediationConfidence: 0.95,
      }
    ],
    suppressedHypotheses: [],
  };

  beforeEach(() => {
    clearGovernanceHooks();
  });

  afterEach(() => {
    clearGovernanceHooks();
  });

  it('runs successfully and matches sync pipeline when no hooks are registered', async () => {
    const syncRes = runAgentPipeline(mockChain, { service: 'api' });
    const res = await runAgentPipelineAsync(mockChain, { service: 'api' });
    expect(res.verdict).toBe(syncRes.verdict);
    expect(res.stages.some(s => s.name.startsWith('pre-execution-hook'))).toBe(false);
  });

  it('runs registered hooks and can block execution', async () => {
    const hook = async (ctx: GovernanceHookContext) => {
      expect(ctx.plan.command).toBe('systemctl restart postgresql');
      return { verdict: 'block' as const, reason: 'Custom policy constraint violated' };
    };

    registerGovernanceHook(hook);

    const res = await runAgentPipelineAsync(mockChain, { service: 'api' });
    expect(res.verdict).toBe('block');
    expect(res.blockReason).toBe('Custom policy constraint violated');

    const hookStage = res.stages.find(s => s.name === 'pre-execution-hook-1');
    expect(hookStage).toBeDefined();
    expect(hookStage!.status).toBe('block');
    expect(hookStage!.summary).toBe('Custom policy constraint violated');
  });

  it('runs registered hooks and can demote to review', async () => {
    const hook = async (ctx: GovernanceHookContext) => {
      return { verdict: 'review' as const, reason: 'Manual audit recommended' };
    };

    registerGovernanceHook(hook);

    const res = await runAgentPipelineAsync(mockChain, { service: 'api' });
    expect(res.verdict).toBe('review');

    const hookStage = res.stages.find(s => s.name === 'pre-execution-hook-1');
    expect(hookStage).toBeDefined();
    expect(hookStage!.status).toBe('warn');
  });
});
