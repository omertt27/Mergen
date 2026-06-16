/**
 * Level 4 — Autopilot Eval
 *
 * Tests runIncidentAutopilot in shadow mode with controlled inputs.
 * Shadow mode (MERGEN_SHADOW_MODE=true) runs the full diagnosis + governance
 * pipeline but never executes fix commands — the only side-effects are Slack
 * thread replies and shadow log entries, both of which we capture.
 *
 * Why shadow mode for testing:
 *   - Does not require MERGEN_AUTOPILOT=true (safest in CI)
 *   - Exercises the complete code path up to the execution gate
 *   - Produces identical Slack output to real autopilot (engineers see same brief)
 *
 * Four behavioral properties verified:
 *   1. No signals  → posts a clear "nothing to act on" message, skips analysis
 *   2. High-conf hypothesis → posts full diagnosis + shadow-mode notice, never executes
 *   3. No hypothesis  → posts "no actionable root cause" message
 *   4. Latency budget → end-to-end completes within 3 seconds on mocked deps
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AutopilotOpts } from '../../intelligence/incident-autopilot.js';
import type { Hypothesis, CausalChain } from '../../intelligence/causal.js';

// ── Mock function setup ───────────────────────────────────────────────────────
// vi.hoisted() is still required to create mock functions that are referenced
// inside vi.mock() factory callbacks. env vars no longer need to be hoisted
// because incident-autopilot.ts now reads MERGEN_SHADOW_MODE lazily at call
// time via isShadowMode(), not at module evaluation time.

const {
  mockPostThreadReply,
  mockBuildCausalChain,
  mockGetLogs,
  mockGetNetwork,
  mockRunAgentPipeline,
  mockRenderPipelineStages,
  mockCaptureSnapshot,
  mockRecordShadow,
} = vi.hoisted(() => ({
  mockPostThreadReply:      vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined),
  mockBuildCausalChain:     vi.fn<unknown[], Promise<CausalChain>>(),
  mockGetLogs:              vi.fn().mockReturnValue([]),
  mockGetNetwork:           vi.fn().mockReturnValue([]),
  mockRunAgentPipeline:     vi.fn(),
  mockRenderPipelineStages: vi.fn().mockReturnValue('*Pipeline:* allow'),
  mockCaptureSnapshot:      vi.fn(),
  mockRecordShadow:         vi.fn(),
}));

vi.mock('../../intelligence/slack.js', () => ({
  postThreadReply:            mockPostThreadReply,
  postApprovalRequest:        vi.fn().mockResolvedValue(undefined),
  fetchIncidentChannelContext: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../intelligence/causal.js', () => ({
  buildCausalChain:  mockBuildCausalChain,
  fixActionToCommand: vi.fn().mockReturnValue(null),
}));

vi.mock('../../intelligence/agent-pipeline.js', () => ({
  runAgentPipeline:     mockRunAgentPipeline,
  renderPipelineStages: mockRenderPipelineStages,
}));

vi.mock('../../intelligence/incident-replay.js', () => ({
  captureSnapshot:   mockCaptureSnapshot,
  listSnapshotPids:  vi.fn().mockReturnValue([]),
}));

vi.mock('../../intelligence/shadow-log.js', () => ({
  recordShadow: mockRecordShadow,
}));

vi.mock('../../sensor/buffer.js', () => ({
  store: {
    getLogs:           mockGetLogs,
    getNetwork:        mockGetNetwork,
    getContext:        vi.fn().mockReturnValue([]),
    getTerminalOutput: vi.fn().mockReturnValue([]),
    getProcessExits:   vi.fn().mockReturnValue([]),
    getCIEvents:       vi.fn().mockReturnValue([]),
    getDeployments:    vi.fn().mockReturnValue([]),
    getBlastRadius:    vi.fn().mockReturnValue({ affected: [], scope: 'none' }),
  },
}));

vi.mock('../../datadog/incident-state.js', () => ({
  getActiveIncident:   vi.fn().mockReturnValue(null),
  clearActiveIncident: vi.fn(),
  setActiveIncident:   vi.fn(),
}));

vi.mock('../../datadog/client.js', () => ({
  isConfigured:        vi.fn().mockReturnValue(false),
  fetchErrorCountSince: vi.fn().mockResolvedValue(null),
  fetchLatestErrorTrace: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../sensor/k8s-events.js', () => ({
  getK8sEvents: vi.fn().mockReturnValue([]),
}));

vi.mock('../../sensor/incident-store.js', () => ({
  incidentStore: {
    get:    vi.fn().mockReturnValue(null),
    upsert: vi.fn().mockReturnValue({ pid: 'test-pid', status: 'open' }),
    list:   vi.fn().mockReturnValue([]),
  },
}));

// ── Module under test (imported after mocks are registered) ───────────────────
import { runIncidentAutopilot } from '../../intelligence/incident-autopilot.js';

// ── Env setup ────────────────────────────────────────────────────────────────
// Set MERGEN_SHADOW_MODE before each test. The flag is now read lazily by
// isShadowMode() at call time, so beforeEach is sufficient — no vi.hoisted().
beforeEach(() => { process.env.MERGEN_SHADOW_MODE = 'true'; });
afterEach(() => { delete process.env.MERGEN_SHADOW_MODE; });

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.now();

function makeHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    tag:                  'infra_db_connection_pool',
    summary:              'Database connection pool exhausted on `api`',
    confidence:           'HIGH',
    confidenceScore:      0.91,
    causalPath:           ['Pool hit max connections', 'New connections queued', 'Timeout after 5s'],
    evidence:             ['Service: api', 'Endpoint: postgres:5432'],
    fixHint:              'Increase DB_POOL_MAX setting. Check for connection leaks.',
    fixAction:            null,
    remediationConfidence: 0.60,
    pid:                  'test-pid',
    ...overrides,
  };
}

function makeChain(hypotheses: Hypothesis[] = [makeHypothesis()]): CausalChain {
  return {
    hypotheses,
    suppressedHypotheses: [],
    chain:                [],
    contextPack:          'Database connection pool exhausted...',
    errors:               [],
    capturedAt:           NOW,
    correlatedNetwork:    [],
    correlatedBackend:    [],
    stateAtError:         null,
  };
}

const BASE_OPTS: AutopilotOpts = {
  service: 'api',
  pid:     'test-incident-pid',
  firedAt: NOW - 5_000,
};

// Standard pipeline result that allows analysis to continue without blocking.
const ALLOW_PIPELINE = {
  stages:    [],
  plan:      { command: 'kubectl rollout restart deployment/api' },
  critique:  { corpusConflict: false, levelConflict: false },
  verdict:   'allow' as const,
  blockReason: null,
};

// 3 info-level logs — enough to satisfy waitForTelemetry (needs ≥ 3 events)
// but no error-level entries, so hasAnySignal = false.
const INFO_LOGS = [
  { level: 'info', args: ['server started'],    timestamp: NOW - 300 },
  { level: 'info', args: ['health check ok'],   timestamp: NOW - 200 },
  { level: 'info', args: ['request received'],  timestamp: NOW - 100 },
];

// 3 error-level logs — satisfies both waitForTelemetry and hasAnySignal.
const ERROR_LOGS = [
  { level: 'error', args: ['ECONNREFUSED postgres:5432'], timestamp: NOW - 300 },
  { level: 'error', args: ['DB pool exhausted'],          timestamp: NOW - 200 },
  { level: 'error', args: ['Query timed out'],            timestamp: NOW - 100 },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

afterEach(() => { vi.clearAllMocks(); });

describe('autopilot eval — no signal path', () => {
  it('posts "no signals found" and skips causal analysis when buffer has no errors', async () => {
    mockGetLogs.mockReturnValue(INFO_LOGS);
    mockGetNetwork.mockReturnValue([]);

    await runIncidentAutopilot(BASE_OPTS);

    // Should post exactly one message and NOT run causal analysis.
    expect(mockPostThreadReply).toHaveBeenCalledTimes(1);
    const [pid, text] = mockPostThreadReply.mock.calls[0] as [string, string];
    expect(pid).toBe('test-incident-pid');
    expect(text).toContain('no errors or infra signals found');
    expect(mockBuildCausalChain).not.toHaveBeenCalled();
  });
});

describe('autopilot eval — shadow mode diagnosis', () => {
  it('posts diagnosis + pipeline stages + shadow-mode notice (does not execute)', async () => {
    mockGetLogs.mockReturnValue(ERROR_LOGS);
    mockGetNetwork.mockReturnValue([]);
    mockBuildCausalChain.mockResolvedValue(makeChain());
    mockRunAgentPipeline.mockReturnValue(ALLOW_PIPELINE);

    await runIncidentAutopilot(BASE_OPTS);

    // Exactly 3 Slack calls (all awaited, so count is deterministic):
    //   1. diagnosis   2. pipeline stages   3. shadow-mode skip notice
    expect(mockPostThreadReply).toHaveBeenCalledTimes(3);

    const allTexts = (mockPostThreadReply.mock.calls as [string, string][]).map(([, t]) => t);

    // Diagnosis contains the hypothesis summary.
    const diagText = allTexts.find((t) => t.includes('Root Cause Analysis'));
    expect(diagText, 'diagnosis message not found in Slack calls').toBeTruthy();
    expect(diagText).toContain('Database connection pool exhausted');
    expect(diagText).toContain('HIGH');

    // Shadow-mode notice names the would-be command and says "shadow mode".
    const shadowText = allTexts.find((t) => t.includes('shadow mode'));
    expect(shadowText, 'shadow-mode message not found in Slack calls').toBeTruthy();
    expect(shadowText).toContain('kubectl rollout restart');

    // Snapshot was captured for replay regression tests.
    expect(mockCaptureSnapshot).toHaveBeenCalledOnce();

    // Shadow log was recorded.
    expect(mockRecordShadow).toHaveBeenCalledOnce();
    const shadowEntry = mockRecordShadow.mock.calls[0][0] as Record<string, unknown>;
    expect(shadowEntry.incidentTag).toBe('infra_db_connection_pool');
    expect(shadowEntry.service).toBe('api');
    expect(shadowEntry.skipReason).toBe('autopilot-disabled');
  });

  it('includes causal path steps in the diagnosis message', async () => {
    mockGetLogs.mockReturnValue(ERROR_LOGS);
    mockGetNetwork.mockReturnValue([]);
    mockBuildCausalChain.mockResolvedValue(makeChain());
    mockRunAgentPipeline.mockReturnValue(ALLOW_PIPELINE);

    await runIncidentAutopilot(BASE_OPTS);

    const allTexts = (mockPostThreadReply.mock.calls as [string, string][]).map(([, t]) => t);
    const diagText = allTexts.find((t) => t.includes('Causal path'));
    expect(diagText, 'causal path not included in diagnosis').toBeTruthy();
    expect(diagText).toContain('1. Pool hit max connections');
  });

  it('includes the confidence percentage in the diagnosis message', async () => {
    mockGetLogs.mockReturnValue(ERROR_LOGS);
    mockGetNetwork.mockReturnValue([]);
    mockBuildCausalChain.mockResolvedValue(makeChain());
    mockRunAgentPipeline.mockReturnValue(ALLOW_PIPELINE);

    await runIncidentAutopilot(BASE_OPTS);

    const allTexts = (mockPostThreadReply.mock.calls as [string, string][]).map(([, t]) => t);
    const diagText = allTexts.find((t) => t.includes('Confidence'));
    expect(diagText).toBeTruthy();
    // Confidence should appear as a percentage (e.g. "91%").
    expect(diagText).toMatch(/\d+%/);
  });
});

describe('autopilot eval — no hypothesis path', () => {
  it('posts "no actionable root cause" when causal chain returns no hypotheses', async () => {
    mockGetLogs.mockReturnValue(ERROR_LOGS);
    mockGetNetwork.mockReturnValue([]);
    mockBuildCausalChain.mockResolvedValue(makeChain([])); // empty hypotheses

    await runIncidentAutopilot(BASE_OPTS);

    expect(mockPostThreadReply).toHaveBeenCalled();
    const allTexts = (mockPostThreadReply.mock.calls as [string, string][]).map(([, t]) => t);
    const noHypText = allTexts.find((t) => t.includes('no actionable root cause'));
    expect(noHypText, '"no actionable root cause" message not found').toBeTruthy();
  });
});

describe('autopilot eval — latency budget', () => {
  it('completes within 3 seconds when all dependencies are mocked', { timeout: 5000 }, async () => {
    mockGetLogs.mockReturnValue(ERROR_LOGS);
    mockGetNetwork.mockReturnValue([]);
    mockBuildCausalChain.mockResolvedValue(makeChain());
    mockRunAgentPipeline.mockReturnValue(ALLOW_PIPELINE);

    const start = Date.now();
    await runIncidentAutopilot(BASE_OPTS);
    const elapsed = Date.now() - start;

    // Entire flow — including waitForTelemetry polling — must complete in < 3s.
    // Real production latency is dominated by the causal analysis LLM call (mocked here).
    expect(elapsed).toBeLessThan(3000);
  });
});
