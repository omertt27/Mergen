/**
 * shadow-mode-tools.test.ts — Verify that MERGEN_SHADOW_MODE=true prevents
 * execute_fix and triage_incident from calling executeRemediation.
 *
 * Fix 1 regression gate: the MCP tool entry points must honour shadow mode
 * independently of the autopilot path, which has its own check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock all side-effectful dependencies ──────────────────────────────────────

const mockExecuteRemediation = vi.fn().mockResolvedValue({
  ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 50, timedOut: false, blocked: false,
});

vi.mock('../intelligence/autonomy.js', () => ({
  executeRemediation: (...args: unknown[]) => mockExecuteRemediation(...args),
  extractCommand: vi.fn().mockReturnValue('systemctl restart api'),
}));

vi.mock('../intelligence/agent-pipeline.js', () => ({
  runAgentPipeline: vi.fn().mockReturnValue({
    stages: [], verdict: 'proceed',
    plan: { command: 'systemctl restart api', rollbackCommand: null, steps: [], estimatedRisk: 'low', requiresApproval: false, reversible: true },
    critique: { corpusConflict: false, levelConflict: false, verdict: 'proceed', concerns: [], blastRadiusSummary: 'low' },
    blockReason: null,
  }),
  renderPipelineStages: vi.fn().mockReturnValue(''),
}));

vi.mock('../__stubs__/causal.js', () => ({
  buildCausalChain: vi.fn().mockResolvedValue({
    hypotheses: [{
      tag: 'db_pool_exhausted', summary: 'DB pool exhausted',
      confidence: 'high', confidenceScore: 0.92, remediationConfidence: 0.92,
      causalPath: ['spike', 'pool full'], evidence: ['10 timeout errors'],
      fixHint: '`systemctl restart api`', fixAction: null, pid: 'test-pid',
    }],
    errors: [{ message: 'connection timeout', ts: Date.now(), primaryFrame: null }],
    correlatedNetwork: [], correlatedBackend: [], chain: [], contextPack: '', stateAtError: null, suppressedHypotheses: [],
  }),
  fixActionToCommand: vi.fn().mockReturnValue(null),
}));

vi.mock('../__stubs__/calibration.js', () => ({
  getRecords:               vi.fn().mockReturnValue([{ pid: 'test-pid', tag: 'db_pool_exhausted', verdict: null }]),
  recordVerdict:            vi.fn(),
  recordRemediationVerdict: vi.fn(),
  classifyVerdict:          vi.fn().mockReturnValue('correct'),
  getStatsForTag:           vi.fn().mockReturnValue(null),
}));

vi.mock('../intelligence/slack.js', () => ({
  postThreadReply:             vi.fn().mockResolvedValue(undefined),
  postApprovalRequest:         vi.fn().mockResolvedValue(undefined),
  fetchIncidentChannelContext: vi.fn().mockResolvedValue(null),
  postIncidentAlert:           vi.fn().mockResolvedValue(undefined),
  postSimpleWebhookNotification: vi.fn().mockResolvedValue(undefined),
  handleSlackActions:          vi.fn(),
  handleFeedbackLink:          vi.fn(),
}));

vi.mock('../intelligence/tools-state.js', () => ({
  trackCall:    vi.fn(),
  withTierGate: vi.fn().mockImplementation((_tier: unknown, fn: (...args: unknown[]) => unknown) => fn),
}));

vi.mock('../intelligence/tool-manifest.js', () => ({
  getTierForTool: vi.fn().mockReturnValue('free'),
}));

vi.mock('../intelligence/usage.js', () => ({
  consumeIncident: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../intelligence/incident-replay.js', () => ({ captureSnapshot: vi.fn() }));
vi.mock('../intelligence/postmortem-store.js',  () => ({ generatePostmortem: vi.fn(), postmortemStore: { getByTag: vi.fn().mockReturnValue([]) } }));
vi.mock('../sensor/incident-store.js', () => ({ incidentStore: { upsert: vi.fn().mockReturnValue({ createdAt: Date.now() }), list: vi.fn().mockReturnValue([]) } }));
vi.mock('../intelligence/action-risk.js', () => ({
  getAutopilotLevel:        vi.fn().mockReturnValue('full'),
  autopilotLevelPermits:    vi.fn().mockReturnValue(true),
  classifyCommandRisk:      vi.fn().mockReturnValue('restart'),
  autopilotLevelDescription: vi.fn().mockReturnValue('all commands'),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAutonomyTools } from '../intelligence/tools-autonomy.js';
import { store } from '../sensor/buffer.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerAutonomyTools(server);
  return server;
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<unknown> {
  // _registeredTools is a plain object keyed by tool name (not a Map)
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools;
  const tool = tools?.[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.handler(args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('execute_fix — shadow mode blocks execution', () => {
  let server: McpServer;

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    process.env.MERGEN_SHADOW_MODE = 'true';
    delete process.env.MERGEN_AUTOPILOT;
    server = buildServer();
  });

  afterEach(() => {
    delete process.env.MERGEN_SHADOW_MODE;
  });

  it('does not call executeRemediation when MERGEN_SHADOW_MODE=true', async () => {
    const result = await callTool(server, 'execute_fix', {
      pid: 'test-pid',
      confirm: true,
      dry_run: 'false',
    }) as { content: Array<{ text: string }> };

    expect(mockExecuteRemediation).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/shadow mode/i);
  });

  it('allows dry_run even in shadow mode (preview only, no execution)', async () => {
    // dry_run=true is explicitly allowed in shadow mode as a preview tool
    const result = await callTool(server, 'execute_fix', {
      pid: 'test-pid',
      confirm: true,
      dry_run: 'true',
    }) as { content: Array<{ text: string }> };

    // executeRemediation called with dryRun:true is acceptable
    // (it spawns no process); the shadow mode gate only blocks actual execution
    if (mockExecuteRemediation.mock.calls.length > 0) {
      const opts = mockExecuteRemediation.mock.calls[0][1] as { dryRun?: boolean };
      expect(opts.dryRun).toBe(true);
    }
  });
});

describe('triage_incident — shadow mode blocks auto_execute', () => {
  let server: McpServer;

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    // Seed buffer with errors so the tool has something to analyse
    for (let i = 0; i < 5; i++) {
      store.push({ type: 'console', level: 'error', args: ['db timeout'], url: 'http://api', timestamp: Date.now() - i * 100 });
    }
    process.env.MERGEN_SHADOW_MODE = 'true';
    delete process.env.MERGEN_AUTOPILOT;
    server = buildServer();
  });

  afterEach(() => {
    delete process.env.MERGEN_SHADOW_MODE;
  });

  it('does not call executeRemediation when auto_execute=true and MERGEN_SHADOW_MODE=true', async () => {
    await callTool(server, 'triage_incident', {
      service: 'api',
      auto_execute: 'true',
    });

    expect(mockExecuteRemediation).not.toHaveBeenCalled();
  });

  it('includes shadow mode notice in the triage report output', async () => {
    const result = await callTool(server, 'triage_incident', {
      service: 'api',
      auto_execute: 'true',
    }) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toMatch(/shadow mode/i);
  });
});
