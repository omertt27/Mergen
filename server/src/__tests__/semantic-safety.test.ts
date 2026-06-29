import { describe, it, expect } from 'vitest';
import { analyzeSemanticRisk } from '../intelligence/action-risk.js';
import { runAgentPipeline } from '../intelligence/agent-pipeline.js';
import type { CausalChain } from '../intelligence/causal.js';

describe('semantic safety gate', () => {
  it('blocks destructive database commands', () => {
    const result = analyzeSemanticRisk('DROP TABLE users');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('is irreversible');
  });

  it('blocks destructive rm -rf commands', () => {
    const result = analyzeSemanticRisk('rm -rf /');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('permanently deletes files');
  });

  it('blocks db connection pool resize during Friday settlement window (20:00 - 24:00 UTC)', () => {
    // Friday is dayOfWeek = 5
    const resultBlocked = analyzeSemanticRisk('export DB_POOL_MAX=50', {
      service: 'api',
      service_time: { dayOfWeek: 5, hourOfDay: 22 }
    });
    expect(resultBlocked.blocked).toBe(true);
    expect(resultBlocked.reason).toContain('Friday 20-24 UTC settlement window');

    // Safe on other days
    const resultSafe = analyzeSemanticRisk('export DB_POOL_MAX=50', {
      service: 'api',
      service_time: { dayOfWeek: 2, hourOfDay: 22 }
    });
    expect(resultSafe.blocked).toBe(false);
  });

  it('integrates with runAgentPipeline and blocks execution in critique stage', () => {
    // Create a mock causal chain
    const mockChain: CausalChain = {
      errors: [{ message: 'database pool full', timestamp: Date.now(), primaryFrame: null }],
      capturedAt: Date.now(),
      correlatedNetwork: [],
      correlatedBackend: [],
      chain: [],
      contextPack: '',
      stateAtError: null,
      hypotheses: [
        {
          tag: 'infra_db_connection_pool',
          summary: 'DB pool exhaustion',
          confidence: 'HIGH',
          confidenceScore: 0.9,
          evidence: ['database pool full'],
          causalPath: ['pool full'],
          fixHint: 'Scale pool: `kubectl scale deployment api-db-pool --replicas=20`',
          remediationConfidence: 0.9,
        }
      ],
      suppressedHypotheses: [],
    };

    // Run pipeline on Friday (day 5), hour 22 UTC -> should block
    const pipelineBlocked = runAgentPipeline(mockChain, {
      service: 'api',
      service_time: { dayOfWeek: 5, hourOfDay: 22 }
    });

    expect(pipelineBlocked.verdict).toBe('block');
    const hasSemanticConcern = pipelineBlocked.critique?.concerns.some(c => c.includes('Database pool resize is unsafe')) ?? false;
    expect(hasSemanticConcern).toBe(true);

    // Run pipeline on Tuesday (day 2), hour 22 UTC -> should proceed (or review depending on autopilot level, but not blocked by semantic check)
    const pipelineSafe = runAgentPipeline(mockChain, {
      service: 'api',
      service_time: { dayOfWeek: 2, hourOfDay: 22 }
    });
    
    const hasSemanticConcernSafe = pipelineSafe.critique?.concerns.some(c => c.includes('Database pool resize is unsafe')) ?? false;
    expect(hasSemanticConcernSafe).toBe(false);
  });
});
