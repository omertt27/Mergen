/**
 * autopilot.test.ts — Integration tests for the autonomous incident triage loop.
 *
 * Critical invariant: the autopilot loop MUST post a Slack message in every
 * terminal case — it must never swallow an error silently.
 *
 * Cases covered:
 *   1. Autopilot disabled  → returns early, no Slack noise
 *   2. No signals in buffer → posts "no signals" message (not silent)
 *   3. Analysis timeout     → posts raw telemetry fallback (not silent)
 *   4. No hypothesis        → posts "no root cause" message (not silent)
 *   5. Low confidence       → diagnosis posted, execution skipped
 *
 * Why vi.doMock() instead of vi.mock():
 *   AUTOPILOT_ENABLED and SHADOW_MODE are module-level constants in
 *   incident-autopilot.ts, so each test re-imports the module after setting
 *   env vars via vi.resetModules() + dynamic import. vi.resetModules() also
 *   clears the mock registry, so hoisted vi.mock() factories are gone by the
 *   time the dynamic import runs. vi.doMock() is registered inline (not
 *   hoisted) and survives the resetModules → doMock → import sequence.
 *
 *   causal.ts and calibration.ts are closed-source and gitignored; vitest.config.ts
 *   maps their import paths to open-source stubs (src/__stubs__/) so Vite can
 *   resolve them. vi.doMock() then replaces the stubs with test-specific fakes.
 *
 * Why vi.useFakeTimers() in shadow-mode beforeEach:
 *   waitForTelemetry polls for up to 10 s; without fake timers each test
 *   would take ≥ 10 s and exceed the 5 s default timeout.  Fake timers let
 *   vi.runAllTimersAsync() advance past the wait instantly.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { BufferStore } from '../sensor/buffer.js';

// ── Shared mock fns (module-level so test assertions can reference them) ─────

const mockBuildCausalChain  = vi.fn();
const mockPostThreadReply   = vi.fn().mockResolvedValue(undefined);
const mockFetchChannelCtx   = vi.fn().mockResolvedValue(null);

// ── Mock registration ─────────────────────────────────────────────────────────
// Must run after vi.resetModules() — see module-level JSDoc for explanation.

function registerMocks(skip: string[] = []): void {
  // vitest.config.ts aliases `./causal.js` → `src/__stubs__/causal.ts`, so
  // the mock must target the stub path (the resolved id Vite actually loads),
  // not the original `intelligence/causal.js` path.
  vi.doMock('../__stubs__/causal.js', () => ({
    buildCausalChain:   (...args: unknown[]) => mockBuildCausalChain(...args),
    fixActionToCommand: vi.fn().mockReturnValue(null),
  }));
  vi.doMock('../__stubs__/calibration.js', () => ({
    getRecords:          vi.fn().mockReturnValue([]),
    recordVerdict:       vi.fn(),
    getStatsForTag:      vi.fn().mockReturnValue(null),
    classifyVerdict:     vi.fn().mockReturnValue('correct'),
    recordRemediationVerdict: vi.fn(),
    isCorpusSeeded:      vi.fn().mockReturnValue(false),
    getRealVerdictCount: vi.fn().mockReturnValue(20),
  }));

  vi.doMock('../intelligence/slack.js', () => ({
    postThreadReply:             (...args: unknown[]) => mockPostThreadReply(...args),
    postApprovalRequest:         vi.fn().mockResolvedValue(undefined),
    fetchIncidentChannelContext: (...args: unknown[]) => mockFetchChannelCtx(...args),
    postIncidentAlert:           vi.fn().mockResolvedValue(undefined),
    postSimpleWebhookNotification: vi.fn().mockResolvedValue(undefined),
    handleSlackActions:          vi.fn(),
    handleFeedbackLink:          vi.fn(),
  }));
  if (!skip.includes('autonomy')) {
    vi.doMock('../intelligence/autonomy.js', () => ({
      executeRemediation: vi.fn().mockResolvedValue({ success: true, output: '' }),
      extractCommand:     vi.fn().mockReturnValue(null),
    }));
  }
  if (!skip.includes('agent-pipeline')) {
    vi.doMock('../intelligence/agent-pipeline.js', () => ({
      runAgentPipeline:     vi.fn().mockReturnValue({ stages: [], verdict: 'block', plan: null, critique: null, blockReason: 'test' }),
      renderPipelineStages: vi.fn().mockReturnValue(''),
    }));
  }
  if (!skip.includes('planning-gate')) {
    vi.doMock('../intelligence/planning-gate.js', () => ({
      planningGate: vi.fn().mockReturnValue({ execute: false, reason: 'test', adjustedConfidence: 0, signals: { blastRisk: 0, classifierScore: 0 } }),
    }));
  }
  vi.doMock('../intelligence/platt-scaling.js', () => ({
    plattScale: vi.fn().mockImplementation((score: number) => ({ calibrated: score, source: 'raw' })),
  }));
  vi.doMock('../intelligence/llm-spokesperson.js', () => ({
    formatValidatedFactsForLLM: vi.fn().mockReturnValue({ brief: '', estimatedTokens: 0 }),
  }));
  vi.doMock('../intelligence/threshold-optimizer.js', () => ({
    getExecutionThreshold: vi.fn().mockReturnValue(0.85),
  }));
  vi.doMock('../sensor/k8s-events.js', () => ({
    getK8sEvents: vi.fn().mockReturnValue([]),
  }));
  vi.doMock('../sensor/infra-normalizer.js', () => ({
    normalizeRuntimeFactMarkdown: vi.fn().mockReturnValue([]),
    normalizeProcessExits:        vi.fn().mockReturnValue([]),
    normalizeSlackContext:        vi.fn().mockReturnValue([]),
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// vi.resetModules() creates a fresh module registry, so incident-autopilot.ts
// gets a NEW store instance on each dynamic import.  We must push events into
// that same instance — not the stale one from the top-level static import.
let activeStore: BufferStore;

function pushErrors(msg: string, count = 3): void {
  for (let i = 0; i < count; i++) {
    activeStore.push({ type: 'console', level: 'error', args: [msg], url: 'http://api', timestamp: Date.now() });
  }
}

async function importAutopilot(): Promise<typeof import('../intelligence/incident-autopilot.js')['runIncidentAutopilot']> {
  // Import buffer first so both the test and the autopilot share the same store instance.
  const bufMod = await import('../sensor/buffer.js');
  activeStore = bufMod.store;
  const mod = await import('../intelligence/incident-autopilot.js');
  return mod.runIncidentAutopilot;
}

function joinSlackCalls(): string {
  return mockPostThreadReply.mock.calls.map((c: unknown[]) => c[1]).join('\n');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runIncidentAutopilot — guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.MERGEN_SHADOW_MODE;
    delete process.env.MERGEN_AUTOPILOT;
    registerMocks();
  });

  it('returns early without posting to Slack when autopilot is disabled', async () => {
    const runIncidentAutopilot = await importAutopilot();

    await runIncidentAutopilot({ service: 'api', pid: 'p1', firedAt: Date.now() });

    expect(mockPostThreadReply).not.toHaveBeenCalled();
  });
});

describe('runIncidentAutopilot — shadow mode', () => {
  let runIncidentAutopilot: Awaited<ReturnType<typeof importAutopilot>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.resetModules();
    process.env.MERGEN_SHADOW_MODE = 'true';
    delete process.env.MERGEN_AUTOPILOT;
    registerMocks();
    runIncidentAutopilot = await importAutopilot();
    activeStore.clear();
  });

  afterEach(() => {
    delete process.env.MERGEN_SHADOW_MODE;
    vi.useRealTimers();
  });

  it('posts "no signals" to Slack when the buffer is empty — never silent', async () => {
    mockFetchChannelCtx.mockResolvedValue(null);

    const promise = runIncidentAutopilot({ service: 'api', pid: 'p-nosig', firedAt: Date.now() });
    // Advance past waitForTelemetry (max 10 s) — capped to avoid the 60 s
    // setInterval in execution-gate.ts which would loop infinitely with runAllTimersAsync.
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;

    expect(mockPostThreadReply).toHaveBeenCalledOnce();
    const text = String(mockPostThreadReply.mock.calls[0][1]);
    expect(text).toMatch(/no errors|no signals/i);
  });

  it('posts raw telemetry fallback on analysis timeout — never swallows silently', async () => {
    pushErrors('TypeError: Cannot read properties of undefined');
    mockBuildCausalChain.mockReturnValue(new Promise(() => {}));

    const promise = runIncidentAutopilot({ service: 'api', pid: 'p-timeout', firedAt: Date.now() });
    // Advance past waitForTelemetry (10 s) + analysis timeout (30 s)
    await vi.advanceTimersByTimeAsync(45_000);
    await promise;

    const calls = mockPostThreadReply.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(joinSlackCalls()).toMatch(/raw telemetry|analysis unavailable|manual investigation/i);
  });

  it('posts diagnosis message when causal chain returns empty hypotheses — never silent', async () => {
    pushErrors('database connection timeout');
    mockBuildCausalChain.mockResolvedValue({ hypotheses: [] });

    const promise = runIncidentAutopilot({ service: 'api', pid: 'p-nohyp', firedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;

    expect(mockPostThreadReply).toHaveBeenCalled();
    expect(joinSlackCalls()).toMatch(/no actionable root cause|no hypothesis/i);
  });

  it('posts diagnosis when hypothesis is below execution threshold', async () => {
    pushErrors('null pointer exception');
    mockBuildCausalChain.mockResolvedValue({
      hypotheses: [{
        tag:                    'null_deref',
        summary:                'Null dereference in user handler',
        confidence:             'medium',
        confidenceScore:        0.60,
        causalPath:             ['request received', 'handler called', 'null deref'],
        evidence:               ['3 identical errors in 30s'],
        fixHint:                'Add null check before accessing user.id',
        fixAction:              null,
        remediationConfidence:  0.60,
      }],
    });

    const promise = runIncidentAutopilot({ service: 'api', pid: 'p-lowconf', firedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;

    expect(mockPostThreadReply).toHaveBeenCalled();
    expect(joinSlackCalls()).toMatch(/Root Cause|Hypothesis|Mergen Autopilot/i);
  });
});

// ── Override corpus hard-block ────────────────────────────────────────────────
// Fix 3: corpusBlocked must prevent execution regardless of command tier,
// including restart-tier commands that bypass the approval gate.

describe('runIncidentAutopilot — override corpus hard-block', () => {
  let runIncidentAutopilot: Awaited<ReturnType<typeof importAutopilot>>;
  let mockExecuteRemediation: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.resetModules();
    process.env.MERGEN_AUTOPILOT = 'true';
    process.env.MERGEN_SHADOW_MODE = 'false'; // explicit opt-out of shadow default

    mockExecuteRemediation = vi.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 50, timedOut: false, blocked: false });

    // Skip the modules we register explicitly below, eliminating competing doMock registrations.
    registerMocks(['agent-pipeline', 'planning-gate', 'autonomy']);

    // Planning gate must approve so it doesn't shadow the corpus block
    vi.doMock('../intelligence/planning-gate.js', () => ({
      planningGate: vi.fn().mockReturnValue({ execute: true, reason: 'approved', adjustedConfidence: 0.92, signals: { blastRisk: 'low', classifierScore: 0.92 } }),
    }));
    // Corpus conflict → verdict 'review', corpusConflict: true (not 'block' so pipelineBlocked=false)
    vi.doMock('../intelligence/agent-pipeline.js', () => ({
      runAgentPipeline: vi.fn().mockReturnValue({
        stages: [],
        verdict: 'review',
        plan: { command: 'systemctl restart api', rollbackCommand: null, steps: [], estimatedRisk: 'low', requiresApproval: false, reversible: true },
        critique: { corpusConflict: true, levelConflict: false, verdict: 'review', concerns: ['Override corpus: batch-window'], blastRadiusSummary: 'low' },
        blockReason: null,
      }),
      renderPipelineStages: vi.fn().mockReturnValue(''),
    }));
    vi.doMock('../intelligence/autonomy.js', () => ({
      executeRemediation: mockExecuteRemediation,
      extractCommand: vi.fn().mockReturnValue('systemctl restart api'),
    }));
    // High-confidence hypothesis with an executable restart command
    mockBuildCausalChain.mockResolvedValue({
      hypotheses: [{
        tag:                   'db_pool_exhausted',
        summary:               'DB connection pool exhausted',
        confidence:            'high',
        confidenceScore:       0.92,
        remediationConfidence: 0.92,
        causalPath:            ['spike', 'pool full', 'requests queued'],
        evidence:              ['10 connection timeout errors'],
        fixHint:               '`systemctl restart api`',
        fixAction:             null,
      }],
      errors: [], correlatedNetwork: [], correlatedBackend: [], chain: [], contextPack: '', stateAtError: null, suppressedHypotheses: [],
    });

    runIncidentAutopilot = await importAutopilot();
    activeStore.clear();
  });

  afterEach(() => {
    delete process.env.MERGEN_AUTOPILOT;
    vi.useRealTimers();
  });

  it('does not call executeRemediation when the override corpus has a conflict (restart-tier)', async () => {
    pushErrors('connection pool exhausted');

    const promise = runIncidentAutopilot({ service: 'api', pid: 'test-incident-pid', firedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;

    expect(mockExecuteRemediation).not.toHaveBeenCalled();
  });

  it('posts a corpus-block message to Slack when execution is suppressed', async () => {
    pushErrors('connection pool exhausted');

    const promise = runIncidentAutopilot({ service: 'api', pid: 'test-incident-pid', firedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;

    expect(joinSlackCalls()).toMatch(/override corpus|corpus/i);
  });
});