/**
 * agent-identity-spoofing.test.ts — regression test for the P0 finding that
 * MERGEN_AGENT_ID alone (a plain, caller-supplied env var) used to be
 * sufficient to satisfy an agent-profile allowlist and evade a targeted
 * agent-profile block. It must now require a verified MERGEN_AGENT_TOKEN.
 *
 * Exercises the real gate end-to-end (createGuardedServer's patched
 * tools/call dispatch → applyGate → checkAgentProfile), not a unit-level
 * mock of checkAgentProfile, so this proves the fix at the same boundary a
 * spoofing attempt would actually cross.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../sensor/activity-store.js', () => ({ recordActivity: vi.fn() }));
vi.mock('../sensor/agent-blunder-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sensor/agent-blunder-store.js')>();
  return { ...actual, recordBlunder: vi.fn() };
});
vi.mock('../sensor/incident-store.js', () => ({ getOpenIncident: vi.fn().mockReturnValue(null) }));
vi.mock('../intelligence/override-corpus.js', () => ({
  hasRecentOverride: vi.fn().mockReturnValue(false),
  getOverrideSummary: vi.fn().mockReturnValue([]),
}));

import { createGuardedServer } from '../intelligence/tool-guard.js';
import { _resetPolicyCacheForTesting } from '../intelligence/enterprise-policy-engine.js';
import { _resetSessionsForTesting } from '../intelligence/session-threat-tracker.js';
import { _resetForTesting as resetBlunders } from '../sensor/agent-blunder-store.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function makeGuardedHandler(toolName: string, defaultArgs: Record<string, unknown> = {}) {
  let capturedGated: ((request: unknown, extra: unknown) => unknown) | null = null;
  const rawSetRequestHandler = (schema: unknown, h: (request: unknown, extra: unknown) => unknown) => {
    if (schema === CallToolRequestSchema) capturedGated = h;
  };
  const mockServer = { server: { setRequestHandler: rawSetRequestHandler } } as unknown as McpServer;
  createGuardedServer(mockServer, 3000);
  const innerDispatch = () => Promise.resolve({ content: [{ type: 'text' as const, text: 'executed' }] });
  (mockServer as unknown as { server: { setRequestHandler: (s: unknown, h: unknown) => void } })
    .server.setRequestHandler(CallToolRequestSchema, innerDispatch);
  return {
    call: (args?: Record<string, unknown>) =>
      capturedGated!({ params: { name: toolName, arguments: args ?? defaultArgs } }, {}) as Promise<McpResult>,
  };
}

let tmpDir: string;
let saveProfile: typeof import('../intelligence/agent-profiles.js').saveProfile;
let setAgentTokenSecret: typeof import('../intelligence/agent-identity.js').setAgentTokenSecret;
let issueToken: typeof import('../intelligence/agent-identity.js').issueToken;
let _resetAgentIdentityForTesting: typeof import('../intelligence/agent-identity.js')._resetAgentIdentityForTesting;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-agent-spoof-test-'));
  process.env.MERGEN_DATA_DIR = tmpDir;
  ({ saveProfile } = await import('../intelligence/agent-profiles.js'));
  ({ setAgentTokenSecret, issueToken, _resetAgentIdentityForTesting } = await import('../intelligence/agent-identity.js'));

  saveProfile({
    id: 'restricted-agent',
    name: 'Restricted Agent',
    description: 'test profile that blocks execute_fix',
    createdAt: Date.now(),
    allowedTools: [],
    blockedTools: ['execute_fix'],
    allowedServices: [],
    maxRiskTier: 'read',
  });
  setAgentTokenSecret('test-signing-secret');
});

afterAll(() => {
  delete process.env.MERGEN_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetSessionsForTesting();
  resetBlunders();
  _resetPolicyCacheForTesting();
  delete process.env.MERGEN_AGENT_ID;
  delete process.env.MERGEN_AGENT_TOKEN;
});

describe('agent-profile enforcement requires a verified identity', () => {
  test('spoofing MERGEN_AGENT_ID alone does NOT apply the profile block (regression)', async () => {
    process.env.MERGEN_AGENT_ID = 'restricted-agent'; // no MERGEN_AGENT_TOKEN
    const { call } = makeGuardedHandler('execute_fix', { command: 'echo hi' });
    const result = await call();
    // Must NOT be blocked by the (unverified) agent-profile match.
    expect(result.content[0]?.text).not.toMatch(/agent profile gate blocked/i);
  });

  test('a verified MERGEN_AGENT_TOKEN DOES apply the profile block', async () => {
    _resetAgentIdentityForTesting();
    setAgentTokenSecret('test-signing-secret');
    const token = issueToken('restricted-agent');
    process.env.MERGEN_AGENT_TOKEN = token;

    const { call } = makeGuardedHandler('execute_fix', { command: 'echo hi' });
    const result = await call();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/agent profile gate blocked/i);
  });

  test('an invalid MERGEN_AGENT_TOKEN falls back to unverified — profile still not applied', async () => {
    process.env.MERGEN_AGENT_ID = 'restricted-agent';
    process.env.MERGEN_AGENT_TOKEN = 'forged-or-garbage-token';

    const { call } = makeGuardedHandler('execute_fix', { command: 'echo hi' });
    const result = await call();
    expect(result.content[0]?.text).not.toMatch(/agent profile gate blocked/i);
  });
});
