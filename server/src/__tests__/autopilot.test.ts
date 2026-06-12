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
 *   causal.js and calibration.js are closed-source and don't exist on disk,
 *   so they must be mocked; without doMock they'd cause a "Cannot find module"
 *   error on every re-import.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { store } from '../sensor/buffer.js';

// ── Shared mock fns (module-level so test assertions can reference them) ─────

const mockBuildCausalChain  = vi.fn();
const mockPostThreadReply   = vi.fn().mockResolvedValue(undefined);
const mockFetchChannelCtx   = vi.fn().mockResolvedValue(null);

// ── Mock registration ─────────────────────────────────────────────────────────
// Called in beforeEach after vi.resetModules() so all mocks survive the module
// re-import cycle. Paths are relative to this test file.

function registerMocks(): void {
  // Closed-source — don't exist on disk, must be mocked or import fails
  vi.doMock('../intelligence/causal.js', () => ({
    buildCausalChain:   (...args: unknown[]) => mockBuildCausalChain(...args),
    fixActionToCommand: vi.fn().mockReturnValue(null),
  }));
  vi.doMock('../intelligence/calibration.js', () => ({
    getRecords:     vi.fn().mockReturnValue([]),
    recordVerdict:  vi.fn(),
    getStatsForTag: vi.fn().mockReturnValue(null),
  }));

  // Open-source modules with heavy or external dependencies
  vi.doMock('../intelligence/slack.js', () => ({
    postThreadReply:             (...args: unknown[]) => mockPostThreadReply(...args),
    postApprovalRequest:         vi.fn().mockResolvedValue(undefined),
    fetchIncidentChannelContext: (...args: unknown[]) => mockFetchChannelCtx(...args),
    postIncidentAlert:           vi.fn().mockResolvedValue(undefined),
    handleSlackActions:          vi.fn(),
    handleFeedbackLink:          vi.fn(),
  }));
  vi.doMock('../intelligence/autonomy.js', () => ({
    executeRemediation: vi.fn().mockResolvedValue({ success: true, output: '' }),
    extractCommand:     vi.fn().mockReturnValue(null),
  }));
  vi.doMock('../intelligence/agent-pipeline.js', () => ({
    runAgentPipeline:     vi.fn().mockReturnValue({ stages: [], verdict: 'block', plan: null, critique: null, blockReason: 'test' }),
    renderPipelineStages: vi.fn().mockReturnValue(''),
  }));
  vi.doMock('../intelligence/planning-gate.js', () => ({
    planningGate: vi.fn().mockReturnValue({ execute: false, reason: 'test', adjustedConfidence: 0, signals: { blastRisk: 0, classifierScore: 0 } }),
  }));
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

function pushError(msg: string): void {
  store.push({ type: 'console', level: 'error', args: [msg], url: 'http://api', timestamp: Date.now() });
}

async function importAutopilot() {
  const mod = await import('../intelligence/incident-autopilot.js');
  return mod.runIncidentAutopilot;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runIncidentAutopilot — guard', () => {
  beforeEach(() => {
    store.clear();
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
    store.clear();
    vi.clearAllMocks();
    vi.resetModules();
    process.env.MERGEN_SHADOW_MODE = 'true';
    delete process.env.MERGEN_AUTOPILOT;
    registerMocks();
    runIncidentAutopilot = await importAutopilot();
  });

  afterEach(() => {
    delete process.env.MERGEN_SHADOW_MODE;
  });

  it('posts "no signals" to Slack when the buffer is empty — never silent', async () => {
    mockFetchChannelCtx.mockResolvedValue(null);

    await runIncidentAutopilot({ service: 'api', pid: 'p-nosig', firedAt: Date.now() });

    expect(mockPostThreadReply).toHaveBeenCalledOnce();
    const [, text] = mockPostThreadReply.mock.calls[0];
    expect(text).toMatch(/no errors|no signals/i);
  });

  it('posts raw telemetry fallback on analysis timeout — never swallows silently', async () => {
    vi.useFakeTimers();
    pushError('TypeError: Cannot read properties of undefined');
    pushError('TypeError: Cannot read properties of undefined');

    mockBuildCausalChain.mockReturnValue(new Promise(() => {}));

    const promise = runIncidentAutopilot({ service: 'api', pid: 'p-timeout', firedAt: Date.now() });
    // Advance past waitForTelemetry (10 s) + analysis timeout (30 s)
    await vi.runAllTimersAsync();
    await promise;

    vi.useRealTimers();

    const calls = mockPostThreadReply.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const allText = calls.map(([, text]: [string, string]) => text).join('\n');
    expect(allText).toMatch(/raw telemetry|analysis unavailable|manual investigation/i);
  });

  it('posts diagnosis message when causal chain returns empty hypotheses — never silent', async () => {
    pushError('database connection timeout');
    mockBuildCausalChain.mockResolvedValue({ hypotheses: [] });

    await runIncidentAutopilot({ service: 'api', pid: 'p-nohyp', firedAt: Date.now() });

    expect(mockPostThreadReply).toHaveBeenCalled();
    const allText = mockPostThreadReply.mock.calls
      .map(([, text]: [string, string]) => text).join('\n');
    expect(allText).toMatch(/no actionable root cause|no hypothesis/i);
  });

  it('posts diagnosis when hypothesis is below execution threshold', async () => {
    pushError('null pointer exception');
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

    await runIncidentAutopilot({ service: 'api', pid: 'p-lowconf', firedAt: Date.now() });

    expect(mockPostThreadReply).toHaveBeenCalled();
    const allText = mockPostThreadReply.mock.calls
      .map(([, text]: [string, string]) => text).join('\n');
    expect(allText).toMatch(/Root Cause|Hypothesis|Mergen Autopilot/i);
  });
});