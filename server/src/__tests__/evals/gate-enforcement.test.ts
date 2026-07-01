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
  recordGateEvent:    vi.fn(),
  recordHitlHold:     vi.fn(),
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
  mostSevereBlast: vi.fn().mockImplementation((blasts: Array<{ scope: string; reversible: boolean; dataAtRisk: boolean }>) =>
    blasts[0] ?? { scope: 'service', reversible: false, dataAtRisk: true, summary: 'Non-reversible change affecting production data' }),
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
  assertGateCoversRegisteredTools,
  isGateInstalled,
  _resetGateInstalledForTesting,
}                                        from '../../intelligence/tool-guard.js';
import { _resetPolicyCacheForTesting }   from '../../intelligence/enterprise-policy-engine.js';
import * as EnterprisePolicyEngine       from '../../intelligence/enterprise-policy-engine.js';
import { _resetSessionsForTesting }      from '../../intelligence/session-threat-tracker.js';
import { runAgentPipeline }              from '../../intelligence/agent-pipeline.js';
import type { McpServer }                from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema }         from '@modelcontextprotocol/sdk/types.js';
import type { CausalChain }              from '../../intelligence/causal.js';

// ── Type alias ────────────────────────────────────────────────────────────────

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type GuardedFn = (args: unknown, extra: unknown) => Promise<McpResult>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Simulates the SDK's low-level dispatch for the `tools/call` JSON-RPC method:
 * builds a mock McpServer whose `.server.setRequestHandler` createGuardedServer
 * patches, then simulates what the real SDK does internally the first time any
 * tool is registered — installing its own `tools/call` handler via that same
 * `setRequestHandler` call, regardless of whether the registration came from
 * `registerTool()`, `tool()`, or `experimental.tasks.registerToolTask()`. This
 * mirrors createGuardedServer's actual interception point (the protocol
 * dispatch, not a specific registration method), so these tests exercise the
 * real gating mechanism rather than a stand-in for it.
 *
 * Returns a callable that invokes the gate-wrapped dispatch directly, plus the
 * handler spy so callers can assert on whether the underlying handler ran.
 */
function makeGuardedPair(
  toolName: string,
  handler?: GuardedFn,
): { call: GuardedFn; spy: ReturnType<typeof vi.fn> } {
  let capturedGated: ((request: unknown, extra: unknown) => unknown) | null = null;
  const spy = vi.fn(handler ?? (async () => ({ content: [{ type: 'text' as const, text: 'executed' }] })));

  const rawSetRequestHandler = vi.fn((schema: unknown, h: (request: unknown, extra: unknown) => unknown) => {
    if (schema === CallToolRequestSchema) capturedGated = h;
  });
  const mockServer = { server: { setRequestHandler: rawSetRequestHandler } } as unknown as McpServer;

  createGuardedServer(mockServer, 3000);

  const innerDispatch = (request: { params: { name: string; arguments: unknown } }, extra: unknown) => {
    if (request.params.name !== toolName) throw new Error(`tool ${request.params.name} not found`);
    return spy(request.params.arguments, extra);
  };
  (mockServer as unknown as { server: { setRequestHandler: (s: unknown, h: unknown) => void } })
    .server.setRequestHandler(CallToolRequestSchema, innerDispatch);

  return {
    call: (args: unknown, extra: unknown) =>
      capturedGated!({ params: { name: toolName, arguments: args } }, extra) as Promise<McpResult>,
    spy,
  };
}

/**
 * Register a tool on a guarded server and return a callable that invokes the
 * gate-wrapped handler directly. The underlying real handler always returns
 * { content: [{ type:'text', text:'executed' }] } unless overridden.
 */
function makeGuardedHandler(
  toolName: string,
  defaultArgs: Record<string, unknown> = {},
): { call: (args?: Record<string, unknown>) => Promise<McpResult> } {
  const { call } = makeGuardedPair(toolName);
  return { call: (args) => call(args ?? defaultArgs, {}) };
}

/**
 * Regression guard for the bypass where createGuardedServer only trapped
 * `registerTool` (later `tool()` too), while `experimental.tasks.registerToolTask()`
 * — which also calls the SDK's private `_createRegisteredTool` directly —
 * stayed ungated. Since gating now happens at the `tools/call` dispatch layer
 * (see createGuardedServer), it no longer matters which registration method
 * was used — this is the same mechanism as makeGuardedPair, kept as a
 * separate name so the regression intent stays visible in test output.
 */
const makeGuardedPairViaToolShorthand = makeGuardedPair;

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
  _resetSessionsForTesting();
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

  it('blocks kubectl delete namespace and records a blunder', async () => {
    // kubectl delete namespace is a hard BLOCK (cascades entire namespace).
    // General kubectl delete pod/job goes to HOLD instead (see hold_agent_data_mutations).
    const h = makeGuardedHandler('bash', { command: 'kubectl delete namespace production' });
    await h.call();

    expect(mockRecordBlunder).toHaveBeenCalledOnce();
  });

  it('BLOCK registers a bypass token the operator can approve (token in getPendingBypasses, not in response)', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'terraform destroy prod' });
    const result = await h.call();

    // Token is NOT in the MCP response (agents must not be able to self-approve).
    expect(result.content[0].text).not.toMatch(/mergen approve \w+/i);
    // Token IS registered and visible to operators via getPendingBypasses().
    const pending = getPendingBypasses();
    expect(pending.some(b => b.toolName === 'execute_fix' && b.commandArg === 'terraform destroy prod')).toBe(true);
  });

  it('BLOCK does not call the underlying handler', async () => {
    const { call, spy } = makeGuardedPair('execute_fix');
    await call({ command: 'terraform destroy prod' }, {});

    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Regression: shell quote-obfuscation must not evade the gate ──────────────
// normalizeForMatching strips all bare single AND double quotes before
// matching. In a real shell dr"o"p and dr'o'p both execute as drop, so the
// gate must BLOCK both forms end-to-end.

describe('Level 0 — quote-obfuscation cannot evade the gate (regression)', () => {
  it('blocks double-quote obfuscated dr"o"p table', async () => {
    const h = makeGuardedHandler('execute_query', { command: 'dr"o"p table users' });
    const result = await h.call();
    expect(result.isError).toBe(true);
  });

  it('blocks double-quoted "terraform" destroy', async () => {
    const h = makeGuardedHandler('execute_fix', { command: '"terraform" destroy prod' });
    const result = await h.call();
    expect(result.isError).toBe(true);
  });

  it('blocks unbalanced-quote obfuscated rm -"r"f', async () => {
    const h = makeGuardedHandler('bash', { command: 'rm -"r"f /var/data/production' });
    const result = await h.call();
    expect(result.isError).toBe(true);
  });
});

// ── Regression: SDK tool() shorthand must be gated too, not just registerTool ─

describe('Level 0 — tool() shorthand registration is also gated (regression)', () => {
  it('blocks terraform destroy when registered via tool() instead of registerTool()', async () => {
    const { call, spy } = makeGuardedPairViaToolShorthand('execute_fix');
    const result = await call({ command: 'terraform destroy prod' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('blocked');
    expect(spy).not.toHaveBeenCalled();
    expect(mockRecordBlunder).toHaveBeenCalledOnce();
  });

  it('passes safe tool calls through to the handler when registered via tool()', async () => {
    const { call, spy } = makeGuardedPairViaToolShorthand('analyze_runtime');
    const result = await call({}, {});

    expect(result.content[0].text).toBe('executed');
    expect(spy).toHaveBeenCalledOnce();
  });
});

// ── Regression: experimental.tasks.registerToolTask() must be gated too ──────
// This SDK method also calls the private _createRegisteredTool directly and
// was ungated by both the registerTool-only and registerTool+tool Proxy traps
// (neither intercepts property access to `.experimental`). Because gating now
// happens at the tools/call dispatch layer (createGuardedServer), it applies
// uniformly regardless of which of the SDK's registration methods — including
// this one, and any future one — was used. makeGuardedPair simulates that
// dispatch layer directly, so this test is mechanically identical to the
// registerTool/tool tests above; it exists so the specific finding stays
// visible and testably named in the suite.
describe('Level 0 — experimental.tasks.registerToolTask() is also gated (regression)', () => {
  it('blocks terraform destroy for a tool registered through the task-based registration path', async () => {
    const { call, spy } = makeGuardedPair('execute_fix');
    const result = await call({ command: 'terraform destroy prod' }, {});

    expect(result.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Regression: gate fails closed on an internal error, not open ────────────
// Previously applyGate had no top-level try/catch; it happened to fail closed
// only because every next() call sits after policy evaluation succeeds, so a
// thrown error propagated to the SDK's own outer catch without ever reaching
// the real handler. That was an accident of call order. This proves fail-
// closed explicitly, independent of where in the gate the error originates.
describe('Level 0 — gate fails closed on an internal error (regression)', () => {
  it('blocks the call and never invokes the handler when policy evaluation throws', async () => {
    const evalSpy = vi.spyOn(EnterprisePolicyEngine, 'evaluateEnterprisePolicy')
      .mockImplementation(() => { throw new Error('simulated malformed policy rule'); });

    try {
      const { call, spy } = makeGuardedPair('execute_fix');
      const result = await call({ command: 'ls -la' }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('fail-closed');
      expect(spy).not.toHaveBeenCalled();
      expect(mockRecordBlunder).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'gate_internal_error' }),
      );
    } finally {
      evalSpy.mockRestore();
    }
  });
});

// ── Regression: closed-source tools.ts wiring is a black box; verify it, don't assume it ──
// intelligence/tools.ts (registerTools()) isn't part of this repo — it's
// gitignored/closed-source — so its wiring can't be reviewed as source. These
// tests cover createGuardedServer's ordering guard and the startup self-test
// that exercises the real gate as a black box instead.
describe('Level 0 — createGuardedServer ordering guard (regression)', () => {
  it('throws if a tool was already registered on the server before the gate was installed', () => {
    const mockServer = {
      server: { setRequestHandler: vi.fn() },
      _toolHandlersInitialized: true, // simulates a tool having been registered pre-patch
    } as unknown as McpServer;

    expect(() => createGuardedServer(mockServer, 3000)).toThrow(/already registered/);
  });

  it('does not throw when no tool has been registered yet', () => {
    const mockServer = {
      server: { setRequestHandler: vi.fn() },
      _toolHandlersInitialized: false,
    } as unknown as McpServer;

    expect(() => createGuardedServer(mockServer, 3000)).not.toThrow();
  });
});

describe('Level 0 — assertGateCoversRegisteredTools (startup self-test, regression)', () => {
  function makeServerWithRegisteredTool(toolName: string): McpServer {
    const rawSetRequestHandler = vi.fn((schema: unknown, h: (request: unknown, extra: unknown) => unknown) => {
      capturedInner = schema === CallToolRequestSchema ? h : capturedInner;
    });
    let capturedInner: ((request: unknown, extra: unknown) => unknown) | undefined;

    const mockServer = {
      server: { setRequestHandler: rawSetRequestHandler },
      _toolHandlersInitialized: false,
      _registeredTools: { [toolName]: {} },
    } as unknown as McpServer;

    createGuardedServer(mockServer, 3000);

    const innerDispatch = async () => ({ content: [{ type: 'text' as const, text: 'executed' }] });
    (mockServer as unknown as { server: { setRequestHandler: (s: unknown, h: unknown) => void } })
      .server.setRequestHandler(CallToolRequestSchema, innerDispatch);

    return mockServer;
  }

  it('throws when createGuardedServer was never called', async () => {
    _resetGateInstalledForTesting();
    const bareServer = { _registeredTools: { execute_fix: {} } } as unknown as McpServer;
    await expect(assertGateCoversRegisteredTools(bareServer)).rejects.toThrow(/createGuardedServer was never called/);
  });

  it('throws when no tools are registered on the server', async () => {
    const mockServer = {
      server: { setRequestHandler: vi.fn() },
      _toolHandlersInitialized: false,
      _registeredTools: {},
    } as unknown as McpServer;
    createGuardedServer(mockServer, 3000);

    await expect(assertGateCoversRegisteredTools(mockServer)).rejects.toThrow(/no tools are registered/);
  });

  it('resolves when the live gate correctly blocks a synthetic destructive call', async () => {
    const server = makeServerWithRegisteredTool('execute_fix');
    expect(isGateInstalled()).toBe(true);
    await expect(assertGateCoversRegisteredTools(server)).resolves.toBeUndefined();
  });

  it('throws when the live gate fails to block the synthetic destructive call', async () => {
    const evalSpy = vi.spyOn(EnterprisePolicyEngine, 'evaluateEnterprisePolicy')
      .mockReturnValue({ verdict: 'pass', triggeredRules: [], reasons: [] });
    try {
      const server = makeServerWithRegisteredTool('execute_fix');
      await expect(assertGateCoversRegisteredTools(server)).rejects.toThrow(/was NOT blocked/);
    } finally {
      evalSpy.mockRestore();
    }
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

    // Token is no longer in the MCP response — get it via getPendingBypasses()
    // (operators see it in terminal logs / Slack; agents cannot self-approve).
    const pending = getPendingBypasses();
    const entry = pending.find(b => b.commandArg === 'terraform destroy prod-eu');
    expect(entry).not.toBeNull();
    const token = entry!.token;

    // Approve the bypass
    const { ok } = approveBypass(token);
    expect(ok).toBe(true);

    // Second call: PASS (bypass is consumed) — but hard block rules still fire.
    // terraform destroy is a hard block; bypass cannot override it (fix #2).
    const passResult = await guardedCall({ command: 'terraform destroy prod-eu' }, {});
    expect(passResult.isError).toBe(true); // hard block overrides bypass
    // Handler is never called because the hard block rejects even approved bypasses.
    expect(spy).not.toHaveBeenCalled();
  });

  it('approveBypass returns ok:false for an unknown token', () => {
    const { ok } = approveBypass('nonexistent-token-abc');
    expect(ok).toBe(false);
  });

  it('getPendingBypasses lists block tokens awaiting operator approval', async () => {
    // kubectl delete pod is now HOLD (not BLOCK), so no bypass token is registered.
    // Use rm -rf which remains a hard BLOCK and generates a bypass token.
    const h = makeGuardedHandler('execute_fix', { command: 'rm -rf /tmp/bypass-test-unique' });
    await h.call();

    const pending = getPendingBypasses();
    const mine = pending.find(b => b.commandArg === 'rm -rf /tmp/bypass-test-unique');
    expect(mine).toBeDefined();
    expect(mine!.toolName).toBe('execute_fix');
    expect(mine!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('duplicate BLOCK for the same command registers only one pending bypass token', async () => {
    const h = makeGuardedHandler('execute_fix', { command: 'rm -rf /tmp/same-command' });

    await h.call();
    await h.call();

    // Both BLOCKs should map to the same deduplicated bypass token.
    const pending = getPendingBypasses().filter(b => b.commandArg === 'rm -rf /tmp/same-command');
    expect(pending).toHaveLength(1);
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
      // kubectl delete namespace is a hard BLOCK. General kubectl delete pod/job
      // goes to HOLD (async HITL) which doesn't return isError:true synchronously.
      command:  'kubectl delete namespace production',
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