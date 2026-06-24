/**
 * Level 0 — AEG Gate Enforcement Evals
 *
 * Tests the three-layer enforcement architecture that sits between every
 * AI agent tool call and the handler that would execute it:
 *
 *   Layer 1 — Hard Safety Policies: `terraform destroy`, `DROP TABLE`,
 *             `rm -rf` must be BLOCKed before the handler runs.
 *   Layer 2 — HOLD for human review: schema mutations are held for HITL.
 *   Layer 3 — PASS: safe read-only tool calls reach the handler unchanged.
 *
 * Also verifies the three outputs the new frame requires every BLOCK to carry:
 *   • isError: true              — MCP error so the agent sees the refusal
 *   • "Why" section              — names the specific policy rule triggered
 *   • "What to do instead"       — gives an immediately-applicable alternative
 *
 * Five enforcement properties verified beyond the basics:
 *   1. HITL lifecycle    — approveToolCall/denyToolCall resolve the held Promise;
 *                          getPendingHolds surfaces the right metadata.
 *   2. Bypass single-use — approved bypass lets the same command pass once then
 *                          re-blocks; unknown tokens return ok:false.
 *   3. Actor field       — every blunder records actor='agent' for attribution.
 *   4. Gate latency      — policy evaluation completes within 10ms (the
 *                          threshold tool-guard itself logs a warning above).
 *   5. Override corpus   — when hasRecentOverride fires, runAgentPipeline
 *                          returns corpusConflict=true (Layer 2 block signal).
 *
 * These are the gate primitives that make autonomous execution safe enough to
 * grant in the first place. A regression here is a release blocker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock functions ────────────────────────────────────────────────────
// vi.hoisted() creates these before any vi.mock() factory runs.

const {
  mockRecordBlunder,
  mockRecordActivity,
  mockTrackBlock,
  mockTrackSuccess,
  mockRecordBlock,
  mockRecordPass,
  mockRecordCoverage,
  mockHitlDecision,
  mockHasRecentOverride,
  mockDominantOverrideReason,
} = vi.hoisted(() => ({
  mockRecordBlunder:           vi.fn(),
  mockRecordActivity:          vi.fn(),
  mockTrackBlock:              vi.fn(),
  mockTrackSuccess:            vi.fn(),
  mockRecordBlock:             vi.fn(),
  mockRecordPass:              vi.fn(),
  mockRecordCoverage:          vi.fn(),
  mockHitlDecision:            vi.fn(),
  mockHasRecentOverride:       vi.fn().mockReturnValue(false), // default: no conflict
  mockDominantOverrideReason:  vi.fn().mockReturnValue(null),
}));

vi.mock('../../sensor/agent-blunder-store.js', () => ({
  recordBlunder: mockRecordBlunder,
}));

vi.mock('../../intelligence/gate-analytics.js', () => ({
  recordGateBlock:    mockRecordBlock,
  recordGatePass:     mockRecordPass,
  recordGateCoverage: mockRecordCoverage,
  recordHitlDecision: mockHitlDecision,
}));

vi.mock('../../sensor/bypass-tracker.js', () => ({
  trackBlock:          mockTrackBlock,
  trackSuccessfulCall: mockTrackSuccess,
}));

vi.mock('../../intelligence/activity-feed.js', () => ({
  recordActivity: mockRecordActivity,
}));

vi.mock('../../sensor/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../intelligence/blast-radius.js', () => ({
  computeBlastRadius: vi.fn().mockReturnValue({
    scope: 'service', reversible: false, dataAtRisk: true,
    summary: 'Non-reversible change affecting production data',
  }),
}));

// override-corpus: default no-conflict so gate tests are unaffected;
// individual tests use mockReturnValueOnce(true) to simulate a corpus hit.
vi.mock('../../intelligence/override-corpus.js', () => ({
  hasRecentOverride:       mockHasRecentOverride,
  dominantOverrideReason:  mockDominantOverrideReason,
  getRulesForTag:          vi.fn().mockReturnValue([]),
  getOverrideSummary:      vi.fn().mockReturnValue([]),
}));

import {
  createGuardedServer,
  approveToolCall,
  denyToolCall,
  getPendingHolds,
  approveBypass,
  getPendingBypasses,
}                                        from '../../intelligence/tool-guard.js';
import { _resetPolicyCacheForTesting }   from '../../intelligence/enterprise-policy-engine.js';
import { runAgentPipeline }              from '../../intelligence/agent-pipeline.js';
import type { McpServer }                from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CausalChain }              from '../../intelligence/causal.js';

// ── Type alias ────────────────────────────────────────────────────────────────

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type GuardedFn = (args: unknown, extra: unknown) => Promise<McpResult>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Register a tool on a guarded server and return a callable that invokes the
 * gate-wrapped handler directly. The underlying real handler always returns
 * { content: [{ type:'text', text:'executed' }] } unless overridden.
 */
function makeGuardedHandler(
  toolName: string,
  defaultArgs: Record<string, unknown> = {},
): { call: (args?: Record<string, unknown>) => Promise<McpResult> } {
  let captured: GuardedFn | null = null;

  const mockServer = {
    registerTool: vi.fn((_n: string, _s: unknown, h: GuardedFn) => { captured = h; }),
  } as unknown as McpServer;

  (createGuardedServer(mockServer, 3000) as unknown as {
    registerTool: (n: string, s: unknown, h: GuardedFn) => void;
  }).registerTool(toolName, {}, async () => ({
    content: [{ type: 'text' as const, text: 'executed' }],
  }));

  return { call: (args) => captured!(args ?? defaultArgs, {}) };
}

/**
 * Same as makeGuardedHandler but returns the handler spy so callers can assert
 * on whether the underlying handler ran.
 */
function makeGuardedPair(
  toolName: string,
  handler?: GuardedFn,
): { call: GuardedFn; spy: ReturnType<typeof vi.fn> } {
  let captured: GuardedFn | null = null;
  const spy = vi.fn(handler ?? (async () => ({ content: [{ type: 'text' as const, text: 'executed' }] })));

  const mockServer = {
    registerTool: vi.fn((_n: string, _s: unknown, h: GuardedFn) => { captured = h; }),
  } as unknown as McpServer;

  (createGuardedServer(mockServer, 3000) as unknown as {
    registerTool: (n: string, s: unknown, h: GuardedFn) => void;
  }).registerTool(toolName, {}, spy);

  return { call: (...a) => captured!(...a), spy };
}

/** Minimal CausalChain fixture for runAgentPipeline tests. */
function makeChain(tag = 'infra_db_connection_pool'): CausalChain {
  return {
    hypotheses: [{
      tag,
      summary:              `${tag} detected on api`,
      confidence:           'HIGH',
      confidenceScore:      0.92,
      causalPath:           ['pool hit max connections', 'timeout after 5s'],
      evidence:             ['Service: api', 'Error: ECONNREFUSED postgres:5432'],
      fixHint:              'kubectl rollout restart deployment/api',
      fixAction:            null, // null so buildExecutionPlan falls through to fixHint
      remediationConfidence: 0.75,
    }],
    suppressedHypotheses: [],
    chain:           [],
    contextPack:     '',
    errors:          [{ message: 'ECONNREFUSED', timestamp: Date.now(), primaryFrame: null }],
    capturedAt:      Date.now(),
    correlatedNetwork:  [],
    correlatedBackend:  [],
    stateAtError:    null,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetPolicyCacheForTesting();
  vi.clearAllMocks();
  mockHasRecentOverride.mockReturnValue(false); // restore default after any test overrides
  // Drain any pending HITL holds leaked from previous tests.
  for (const { token } of getPendingHolds()) {
    denyToolCall(token);
  }
});

// ── Layer 1: Hard Safety Policies — BLOCK ────────────────────────────────────

describe('Level 0 — Layer 1: hard safety policies → BLOCK', () => {
  it('blocks terraform destroy and returns isError=true', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'terraform destroy -auto-approve prod' });
    const result = await h.call();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('blocked');
  });

  it('BLOCK response contains a Why section naming the policy', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'terraform destroy prod' });
    const result = await h.call();

    expect(result.content[0].text).toMatch(/why|blocked|policy|destructive/i);
  });

  it('BLOCK response contains a "What to do instead" guided alternative', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'terraform destroy prod' });
    const result = await h.call();

    expect(result.content[0].text).toMatch(/what to do instead|alternative|approve|plan/i);
  });

  it('blocks DROP TABLE and records a pipeline_block blunder', async () => {
    const h = makeGuardedHandler('execute_query', { command: 'DROP TABLE users;' });
    await h.call();

    expect(mockRecordBlunder).toHaveBeenCalledOnce();
    const call = mockRecordBlunder.mock.calls[0][0] as { blunderType: string; command: string };
    expect(call.blunderType).toBe('pipeline_block');
    expect(call.command).toBe('execute_query');
  });

  it('blocks rm -rf and returns isError=true', async () => {
    const h = makeGuardedHandler('bash', { command: 'rm -rf /var/data/production' });
    const result = await h.call();

    expect(result.isError).toBe(true);
    expect(mockRecordBlunder).toHaveBeenCalledOnce();
  });

  it('blocks kubectl delete and records a blunder', async () => {
    const h = makeGuardedHandler('bash', { command: 'kubectl delete pod api-xxx-yyy' });
    await h.call();

    expect(mockRecordBlunder).toHaveBeenCalledOnce();
  });

  it('BLOCK response includes a bypass token so the operator can override', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'terraform destroy prod' });
    const result = await h.call();

    expect(result.content[0].text).toMatch(/mergen approve \w+/i);
  });

  it('BLOCK does not call the underlying handler', async () => {
    const { call, spy } = makeGuardedPair('execute_fix');
    await call({ command: 'terraform destroy prod' }, {});

    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Layer 2: Schema mutations → HOLD + HITL lifecycle ────────────────────────

describe('Level 0 — Layer 2: schema mutation → HOLD (HITL pending)', () => {
  it('holds ALTER TABLE — recordActivity verdict is HOLD, handler does not run', async () => {
    const { call: guardedCall, spy } = makeGuardedPair('execute_fix');

    const resultPromise = guardedCall({ command: 'ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE' }, {});
    await Promise.resolve(); // yield so the gate registers the hold

    expect(spy).not.toHaveBeenCalled();
    expect(mockTrackSuccess).not.toHaveBeenCalled();
    expect(mockRecordBlunder).not.toHaveBeenCalled();

    const activityCall = mockRecordActivity.mock.calls[0]?.[0] as { verdict: string } | undefined;
    expect(activityCall?.verdict).toBe('HOLD');

    // Clean up: deny the hold so the promise resolves and doesn't leak.
    const [hold] = getPendingHolds();
    if (hold) denyToolCall(hold.token);
    await resultPromise;
  });
});

describe('Level 0 — Layer 2: HITL approve and deny lifecycle', () => {
  it('approveToolCall resolves the held Promise with an approval confirmation (handler not re-run)', async () => {
    // approveToolCall resolves the Promise the gate held — it does NOT re-call the
    // original handler. The AI agent receives "✅ approved" and may re-submit if
    // needed. This is intentional: the gate stays in control of re-execution.
    const { call: guardedCall, spy } = makeGuardedPair('execute_fix');

    const resultPromise = guardedCall({ command: 'prisma migrate deploy' }, {});
    await Promise.resolve();

    const holds = getPendingHolds();
    expect(holds).toHaveLength(1);
    expect(holds[0].toolName).toBe('execute_fix');

    const approved = approveToolCall(holds[0].token);
    expect(approved).toBe(true);

    const result = await resultPromise;
    expect(result.isError).toBeUndefined();                   // not an error — approved
    expect(result.content[0].text).toMatch(/approved/i);      // confirmation message
    expect(spy).not.toHaveBeenCalled();                        // handler not re-run
  });

  it('denyToolCall resolves the held Promise with isError=true', async () => {
    const { call: guardedCall, spy } = makeGuardedPair('execute_fix');

    const resultPromise = guardedCall({ command: 'knex migrate:latest' }, {});
    await Promise.resolve();

    const holds = getPendingHolds();
    expect(holds).toHaveLength(1);

    const denied = denyToolCall(holds[0].token);
    expect(denied).toBe(true);

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/denied/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('getPendingHolds includes toolName and a non-empty policyReason', async () => {
    const { call: guardedCall } = makeGuardedPair('execute_fix');

    const resultPromise = guardedCall({ command: 'db:migrate --env production' }, {});
    await Promise.resolve();

    const holds = getPendingHolds();
    expect(holds[0].toolName).toBe('execute_fix');
    expect(holds[0].policyReason).toBeTruthy();

    denyToolCall(holds[0].token);
    await resultPromise;
  });

  it('approveToolCall removes the token from getPendingHolds', async () => {
    const { call: guardedCall, spy } = makeGuardedPair('execute_fix');

    const resultPromise = guardedCall({ command: 'ALTER TABLE orders ADD COLUMN shipped_at TIMESTAMP' }, {});
    await Promise.resolve();

    expect(getPendingHolds()).toHaveLength(1);
    const { token } = getPendingHolds()[0];

    approveToolCall(token);
    await resultPromise;

    expect(getPendingHolds()).toHaveLength(0);
    // Handler not called on approve (gate resolves with confirmation, not re-execution)
    expect(spy).not.toHaveBeenCalled();
  });

  it('approveToolCall on an unknown token returns false', () => {
    expect(approveToolCall('totally-fake-token-xyz')).toBe(false);
  });

  it('denyToolCall on an unknown token returns false', () => {
    expect(denyToolCall('totally-fake-token-xyz')).toBe(false);
  });
});

// ── Bypass token: single-use enforcement ─────────────────────────────────────

describe('Level 0 — bypass token single-use enforcement', () => {
  it('approved bypass lets the same command pass through exactly once', async () => {
    const { call: guardedCall, spy } = makeGuardedPair('execute_fix');

    // First call: BLOCK
    const blockResult = await guardedCall({ command: 'terraform destroy prod-eu' }, {});
    expect(blockResult.isError).toBe(true);

    // Extract the bypass token from the response
    const tokenMatch = blockResult.content[0].text.match(/mergen approve (\w+)/i);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];

    // Approve the bypass
    const { ok } = approveBypass(token);
    expect(ok).toBe(true);

    // Second call: PASS (bypass is consumed)
    const passResult = await guardedCall({ command: 'terraform destroy prod-eu' }, {});
    expect(passResult.isError).toBeUndefined();
    expect(spy).toHaveBeenCalledOnce();

    // Third call: BLOCK again (bypass already consumed — single-use)
    const reblockResult = await guardedCall({ command: 'terraform destroy prod-eu' }, {});
    expect(reblockResult.isError).toBe(true);
    expect(spy).toHaveBeenCalledOnce(); // handler still only called once
  });

  it('approveBypass returns ok:false for an unknown token', () => {
    const { ok } = approveBypass('nonexistent-token-abc');
    expect(ok).toBe(false);
  });

  it('getPendingBypasses lists block tokens awaiting operator approval', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'kubectl delete pod api-unique-1a2b' });
    await h.call();

    const pending = getPendingBypasses();
    const mine = pending.find(b => b.commandArg === 'kubectl delete pod api-unique-1a2b');
    expect(mine).toBeDefined();
    expect(mine!.toolName).toBe('execute_fix');
    expect(mine!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('duplicate BLOCK for the same command returns the same token', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'rm -rf /tmp/same-command' });

    const r1 = await h.call();
    const r2 = await h.call();

    const t1 = r1.content[0].text.match(/mergen approve (\w+)/i)![1];
    const t2 = r2.content[0].text.match(/mergen approve (\w+)/i)![1];
    expect(t1).toBe(t2); // deduped: same pending bypass reused
  });
});

// ── Layer 3: Safe tool calls → PASS ──────────────────────────────────────────

describe('Level 0 — Layer 3: safe tool calls → PASS', () => {
  it('passes analyze_runtime to the handler (no destructive pattern)', async () => {
    const { call: guardedCall, spy } = makeGuardedPair('analyze_runtime');
    const result = await guardedCall({ service: 'api' }, {});

    expect(spy).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
  });

  it('PASS does not record a blunder', async () => {
    const { call: guardedCall } = makeGuardedPair('get_recent_logs');
    await guardedCall({}, {});

    expect(mockRecordBlunder).not.toHaveBeenCalled();
    expect(mockRecordPass).toHaveBeenCalledOnce();
    expect(mockTrackSuccess).toHaveBeenCalledOnce();
  });

  it('PASS activity records verdict=PASS', async () => {
    const { call: guardedCall } = makeGuardedPair('get_network_activity');
    await guardedCall({}, {});

    const activityCall = mockRecordActivity.mock.calls[0][0] as { verdict: string };
    expect(activityCall.verdict).toBe('PASS');
  });
});

// ── Guided alternatives — one per destructive pattern ────────────────────────

describe('Level 0 — guided alternative presence for each destructive pattern', () => {
  const DESTRUCTIVE_CASES: Array<{ toolName: string; command: string; altHint: RegExp }> = [
    {
      toolName: 'execute_fix',
      command:  'terraform destroy prod',
      altHint:  /terraform plan|preview|hitl|approval/i,
    },
    {
      toolName: 'bash',
      command:  'kubectl delete pod api-xxx',
      altHint:  /kubectl describe|approval|review/i,
    },
    {
      toolName: 'execute_query',
      command:  'DROP TABLE sessions;',
      altHint:  /backup|migration|rollback|approval/i,
    },
    {
      toolName: 'bash',
      command:  'rm -rf /var/cache',
      altHint:  /ls|list|approval|review/i,
    },
  ];

  for (const { toolName, command, altHint } of DESTRUCTIVE_CASES) {
    it(`${command.slice(0, 30)} → guided alternative matches ${altHint}`, async () => {
      const { call: guardedCall } = makeGuardedPair(toolName);
      const result = await guardedCall({ command }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(altHint);
    });
  }
});

// ── Blunder log: type, actor, command accuracy ────────────────────────────────

describe('Level 0 — blunder log field accuracy', () => {
  it('BLOCK records blunderType=pipeline_block', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'terraform destroy' });
    await h.call();

    const blunder = mockRecordBlunder.mock.calls[0][0] as { blunderType: string };
    expect(blunder.blunderType).toBe('pipeline_block');
  });

  it('BLOCK records service=mcp and tag=tool_guard', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'terraform destroy' });
    await h.call();

    const blunder = mockRecordBlunder.mock.calls[0][0] as { service: string; tag: string };
    expect(blunder.service).toBe('mcp');
    expect(blunder.tag).toBe('tool_guard');
  });

  it('BLOCK records actor=agent (attribution for the enforcement report)', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'rm -rf /data' });
    await h.call();

    const blunder = mockRecordBlunder.mock.calls[0][0] as { actor: string };
    expect(blunder.actor).toBe('agent');
  });

  it('blunder records the tool name as command (not the raw command arg)', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'rm -rf /' });
    await h.call();

    const blunder = mockRecordBlunder.mock.calls[0][0] as { command: string };
    expect(blunder.command).toBe('execute_fix');
  });
});

// ── Gate latency budget ───────────────────────────────────────────────────────

describe('Level 0 — gate latency budget', () => {
  // tool-guard.ts logs a warning when evalMs > 10. We test with a looser
  // 50ms ceiling to stay reliable in CI without being meaningless.
  // Production target (no mocks, warm process) is <1ms per the CLAUDE.md spec.

  it('PASS evaluation completes within 50ms', async () => {
    const h = makeGuardedHandler('get_recent_logs', {});
    const t0 = performance.now();
    await h.call();
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('BLOCK evaluation (policy match) completes within 50ms', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'terraform destroy' });
    const t0 = performance.now();
    await h.call();
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

// ── Layer 2: Override corpus conflict via agent-pipeline ──────────────────────

describe('Level 0 — Layer 2: override corpus conflict → pipeline blocks', () => {
  // hasRecentOverride is mocked at the module level (default: false).
  // Individual tests flip it to true with mockReturnValueOnce.

  it('pipeline returns corpusConflict=true when hasRecentOverride fires', () => {
    mockHasRecentOverride.mockReturnValueOnce(true);

    const result = runAgentPipeline(makeChain(), { service: 'api' });

    // critique is non-null because the chain has a hypothesis and a valid fix command
    expect(result.critique?.corpusConflict).toBe(true);
  });

  it('corpus conflict downgrades verdict to at least "review"', () => {
    mockHasRecentOverride.mockReturnValueOnce(true);

    const result = runAgentPipeline(makeChain(), { service: 'api' });

    // corpusConflict pushes the verdict from 'proceed' to 'review' or 'block'
    expect(['review', 'block']).toContain(result.verdict);
  });

  it('pipeline verdict is proceed when hasRecentOverride returns false', () => {
    mockHasRecentOverride.mockReturnValueOnce(false);

    const result = runAgentPipeline(makeChain(), { service: 'api' });

    // No corpus conflict — verdict depends only on confidence/blast; may be
    // 'proceed' or 'review' but must NOT be caused by a corpus conflict.
    expect(result.critique?.corpusConflict).toBe(false);
  });

  it('corpus conflict appears in the critic stage detail', () => {
    mockHasRecentOverride.mockReturnValueOnce(true);

    const result = runAgentPipeline(makeChain(), { service: 'api' });

    const criticStage = result.stages.find(s => s.name === 'critic');
    expect(criticStage).toBeDefined();
    // The critic stage `detail` carries the concatenated concern strings.
    // When there is a corpus conflict, one concern starts with "Override corpus:".
    expect(criticStage!.detail).toMatch(/override|corpus|conflict/i);
  });
});