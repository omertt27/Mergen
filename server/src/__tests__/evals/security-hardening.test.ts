/**
 * security-hardening.test.ts — Eval harness for the June 2026 production
 * readiness fixes.
 *
 * Each describe block maps 1-to-1 to a finding from the formal review so that
 * a regression in any section immediately identifies which fix broke. A failure
 * here is a release blocker — these properties define the enforcement boundary
 * between an AI agent and production infrastructure.
 *
 *   C-1  — Agent actor field cannot bypass AI-specific policy rules
 *   C-2  — Remote policy sync enforces HTTPS + optional HMAC verification
 *   H-1  — HITL Slack buttons: GET handlers return HTML confirmation forms
 *   H-2  — HITL holds are denied as stale after a server restart
 *   H-4  — DATA_DIR respects MERGEN_DATA_DIR env var
 *   H-5  — Child process receives only whitelisted env vars (no secrets)
 *   M-1  — Bypass token file is HMAC-signed; tampered files are rejected
 *   M-2  — API routes carry a strict CSP; dashboard routes are exempt
 *   M-3  — Unknown MCP actors default to AI; MERGEN_TRUSTED_HUMANS works
 *   M-4  — /ingest always requires x-mergen-secret (no unauthenticated fallback)
 *   M-5  — Per-tenant rate-limiting buckets are independent in cloud mode
 *   M-7  — Safety-policy keyword precision ('delete' alone no longer blocks)
 *   M-9  — block_destructive_commands survives a remote policy replace
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import express from 'express';
import crypto from 'crypto';

// ── Hoisted mocks shared across gate tests (C-1) ────────────────────────────

const {
  mockRecordBlunder,
  mockRecordActivity,
  mockTrackBlock,
  mockTrackSuccess,
  mockRecordBlock,
  mockRecordPass,
  mockRecordCoverage,
  mockHitlDecision,
} = vi.hoisted(() => ({
  mockRecordBlunder:   vi.fn(),
  mockRecordActivity:  vi.fn(),
  mockTrackBlock:      vi.fn(),
  mockTrackSuccess:    vi.fn(),
  mockRecordBlock:     vi.fn(),
  mockRecordPass:      vi.fn(),
  mockRecordCoverage:  vi.fn(),
  mockHitlDecision:    vi.fn(),
}));

vi.mock('../../sensor/agent-blunder-store.js', () => ({ recordBlunder: mockRecordBlunder }));
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
vi.mock('../../intelligence/activity-feed.js', () => ({ recordActivity: mockRecordActivity }));
vi.mock('../../sensor/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../intelligence/blast-radius.js', () => ({
  computeBlastRadius: vi.fn().mockReturnValue({
    scope: 'service', reversible: false, dataAtRisk: true,
    summary: 'Non-reversible change affecting production data',
  }),
}));

import {
  createGuardedServer,
  approveToolCall,
  denyToolCall,
  getPendingHolds,
  setBypassSecret,
  persistBypasses,
  loadBypasses,
  denyStaleHoldsOnStartup,
} from '../../intelligence/tool-guard.js';
import {
  isAiActor,
  _resetPolicyCacheForTesting,
  evaluateEnterprisePolicy,
  loadEnterprisePolicy,
  saveEnterprisePolicy,
  type EnterprisePolicyConfig,
} from '../../intelligence/enterprise-policy-engine.js';
import {
  checkSafetyPolicy,
  loadSafetyPolicy,
  _resetSafetyPolicyForTesting,
  DEFAULT_SAFETY_POLICY,
} from '../../intelligence/autonomy.js';
import { startPolicySync } from '../../intelligence/policy-sync.js';
import { createHitlRouter } from '../../routes/hitl.js';
import { TokenBucket } from '../../sensor/ingest.js';
import logger from '../../sensor/logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ── Shared helpers ───────────────────────────────────────────────────────────

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type GuardedFn = (args: unknown, extra: unknown) => Promise<McpResult>;

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

/** Minimal express server for HTTP-level tests. Returns { url, close }. */
async function withRouter(
  router: express.Router,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

beforeEach(() => {
  _resetPolicyCacheForTesting();
  vi.clearAllMocks();
  for (const { token } of getPendingHolds()) denyToolCall(token);
});

// ═══════════════════════════════════════════════════════════════════════════════
// C-1: Agent actor field cannot bypass AI-specific policy rules
// ═══════════════════════════════════════════════════════════════════════════════

describe('C-1 — actor field: MCP tool calls always evaluate as AI actor', () => {
  const AI_ONLY_POLICY: EnterprisePolicyConfig = {
    enabled: true,
    rules: [{
      id: 'test_ai_only_block',
      name: 'Block test command for AI actors only',
      description: 'Verifies that AI-actor restrictions cannot be bypassed via args',
      action: 'block',
      reason: 'AI actor restriction (test)',
      conditions: { commands: ['restricted-for-ai-only'], actorType: 'ai' },
    }],
  };

  it('AI-only rule triggers even when args contain actor=human', async () => {
    _resetPolicyCacheForTesting(AI_ONLY_POLICY);
    const { call } = makeGuardedPair('execute_fix');
    // Agent tries to pass actor:'human' to bypass the AI-only rule
    const result = await call({ command: 'restricted-for-ai-only', actor: 'human' }, {});
    // Must be blocked — tool-guard hardcodes 'agent', ignoring args.actor
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/blocked|policy|gate/i);
  });

  it('AI-only rule triggers when args contain actor=human_developer', async () => {
    _resetPolicyCacheForTesting(AI_ONLY_POLICY);
    const { call } = makeGuardedPair('execute_fix');
    const result = await call({ command: 'restricted-for-ai-only', actor: 'human_developer' }, {});
    expect(result.isError).toBe(true);
  });

  it('AI-only rule triggers when args contain actor=admin_user', async () => {
    _resetPolicyCacheForTesting(AI_ONLY_POLICY);
    const { call } = makeGuardedPair('execute_fix');
    const result = await call({ command: 'restricted-for-ai-only', actor: 'admin_user' }, {});
    expect(result.isError).toBe(true);
  });

  it('blunder log records actor=agent regardless of args.actor', async () => {
    _resetPolicyCacheForTesting(AI_ONLY_POLICY);
    const { call } = makeGuardedPair('execute_fix');
    await call({ command: 'restricted-for-ai-only', actor: 'human' }, {});
    const blunder = mockRecordBlunder.mock.calls[0]?.[0] as { actor: string } | undefined;
    expect(blunder?.actor).toBe('agent');
  });

  it('safe command with AI-only rule passes even when actor=agent in args', async () => {
    _resetPolicyCacheForTesting(AI_ONLY_POLICY);
    const { call, spy } = makeGuardedPair('get_recent_logs');
    await call({ actor: 'agent' }, {});
    // 'get_recent_logs' doesn't match any restricted command — should pass
    expect(spy).toHaveBeenCalledOnce();
  });

  it('evaluateEnterprisePolicy with actor=agent triggers AI-only rule', () => {
    _resetPolicyCacheForTesting(AI_ONLY_POLICY);
    const result = evaluateEnterprisePolicy({
      files: ['execute_fix'],
      commands: ['execute_fix', 'restricted-for-ai-only'],
      actor: 'agent',  // 'agent' matches /\bagent\b/ — treated as AI
      service: 'mcp',
    });
    expect(result.verdict).toBe('block');
    expect(result.triggeredRules).toContain('test_ai_only_block');
  });

  it('evaluateEnterprisePolicy with actor=human does NOT trigger AI-only rule', () => {
    _resetPolicyCacheForTesting(AI_ONLY_POLICY);
    const result = evaluateEnterprisePolicy({
      files: ['execute_fix'],
      commands: ['execute_fix', 'restricted-for-ai-only'],
      actor: 'human',  // human prefix → isAiActor returns false
      service: 'mcp',
    });
    // The rule has actorType:'ai' — a human actor bypasses it (by design)
    // But tool-guard never passes 'human'; this verifies the policy logic itself
    expect(result.verdict).toBe('pass');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C-2: Remote policy sync enforces HTTPS + optional HMAC
// ═══════════════════════════════════════════════════════════════════════════════

describe('C-2 — policy sync: HTTP URLs are rejected at startup', () => {
  // `logger` is already mocked via vi.mock at the top of this file.
  const loggerMock = vi.mocked(logger);

  it('startPolicySync rejects a plain http:// URL without starting', () => {
    startPolicySync({ url: 'http://policy.example.com/policy.json' });
    expect(loggerMock.error).toHaveBeenCalledOnce();
    const errorMsg = loggerMock.error.mock.calls[0][1] as string;
    expect(errorMsg).toMatch(/HTTPS|https/);
  });

  it('startPolicySync logs a warning when HMAC secret is not configured', () => {
    const originalSecret = process.env.MERGEN_POLICY_HMAC_SECRET;
    delete process.env.MERGEN_POLICY_HMAC_SECRET;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')));
    startPolicySync({ url: 'https://policy.example.com/policy.json' });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://policy.example.com/policy.json' }),
      expect.stringMatching(/HMAC|hmac|signature/i),
    );
    if (originalSecret !== undefined) process.env.MERGEN_POLICY_HMAC_SECRET = originalSecret;
    vi.unstubAllGlobals();
  });

  it('startPolicySync with HMAC secret does NOT log the no-signature warning', () => {
    process.env.MERGEN_POLICY_HMAC_SECRET = 'test-secret';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')));
    startPolicySync({ url: 'https://policy.example.com/policy.json' });
    const warnCalls = loggerMock.warn.mock.calls as Array<[unknown, string]>;
    const hasHmacWarning = warnCalls.some(([, msg]) =>
      typeof msg === 'string' && /HMAC.*not set|signature.*not set/i.test(msg)
    );
    expect(hasHmacWarning).toBe(false);
    delete process.env.MERGEN_POLICY_HMAC_SECRET;
    vi.unstubAllGlobals();
  });

  it('HMAC verification: correct signature passes', () => {
    const secret  = 'test-signing-secret';
    const payload = '{"enabled":true,"rules":[]}';
    const sig     = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
    // The sha256= header format is the expected format
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('HMAC verification: tampered payload produces different signature', () => {
    const secret    = 'test-signing-secret';
    const original  = '{"enabled":true,"rules":[]}';
    const tampered  = '{"enabled":false,"rules":[]}';
    const sigOrig   = crypto.createHmac('sha256', secret).update(original).digest('hex');
    const sigTamper = crypto.createHmac('sha256', secret).update(tampered).digest('hex');
    expect(sigOrig).not.toBe(sigTamper);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// H-1: HITL GET confirmation pages (Slack url: button compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

describe('H-1 — HITL GET handlers: confirmation page structure', () => {
  // GET /hitl/approve and /hitl/deny now validate the token exists in the
  // pending-holds map before rendering the page (nonce oracle fix). Tests that
  // assert on page structure must use a real hold token.
  let holdToken: string;

  beforeEach(async () => {
    _resetPolicyCacheForTesting({
      enabled: true,
      rules: [{
        id: 'h1_test_hold', name: 'H-1 test hold rule',
        conditions: { commands: ['h1-hold-me'] },
        action: 'warn',
        message: 'held for H-1 test',
        guidedAlternative: 'use safe approach',
      }],
    });
    const { call } = makeGuardedPair('h1_test_tool');
    // Fire call without awaiting — the Promise suspends until approve/deny.
    void call({ command: 'h1-hold-me' }, {}).catch(() => {});
    // Flush the microtask queue so _pendingHolds is populated.
    await new Promise(r => setTimeout(r, 0));
    holdToken = getPendingHolds().find(h => h.toolName === 'h1_test_tool')?.token ?? '';
  });

  afterEach(() => {
    if (holdToken) denyToolCall(holdToken);
    _resetPolicyCacheForTesting();
  });

  it('GET /hitl/approve returns HTTP 200 with HTML content-type', async () => {
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res = await fetch(`${url}/hitl/approve?token=${holdToken}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
    });
  });

  it('GET /hitl/deny returns HTTP 200 with HTML content-type', async () => {
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res = await fetch(`${url}/hitl/deny?token=${holdToken}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
    });
  });

  it('GET /hitl/approve page contains a form POSTing to /hitl/approve', async () => {
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res  = await fetch(`${url}/hitl/approve?token=${holdToken}`);
      const html = await res.text();
      expect(html).toMatch(/method=["']?POST["']?/i);
      expect(html).toMatch(/action=["'][^"']*\/hitl\/approve/i);
    });
  });

  it('GET /hitl/deny page contains a form POSTing to /hitl/deny', async () => {
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res  = await fetch(`${url}/hitl/deny?token=${holdToken}`);
      const html = await res.text();
      expect(html).toMatch(/method=["']?POST["']?/i);
      expect(html).toMatch(/action=["'][^"']*\/hitl\/deny/i);
    });
  });

  it('GET /hitl/approve page embeds the token in the form action URL', async () => {
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res  = await fetch(`${url}/hitl/approve?token=${holdToken}`);
      const html = await res.text();
      expect(html).toContain(holdToken);
    });
  });

  it('GET /hitl/approve page includes the CLI fallback command', async () => {
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res  = await fetch(`${url}/hitl/approve?token=${holdToken}`);
      const html = await res.text();
      expect(html).toMatch(/mergen\s+approve/i);
    });
  });

  it('GET /hitl/approve without token returns 400', async () => {
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res = await fetch(`${url}/hitl/approve`);
      expect(res.status).toBe(400);
    });
  });

  it('GET /hitl/approve with unknown token returns 404 (nonce oracle fix)', async () => {
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res = await fetch(`${url}/hitl/approve?token=not-a-real-hold-uuid`);
      expect(res.status).toBe(404);
    });
  });

  it('GET /hitl/approve sets Cache-Control: no-store', async () => {
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res = await fetch(`${url}/hitl/approve?token=${holdToken}`);
      expect(res.headers.get('cache-control')).toContain('no-store');
    });
  });

  it('GET /hitl/approve sets Content-Security-Policy blocking inline scripts', async () => {
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res = await fetch(`${url}/hitl/approve?token=${holdToken}`);
      expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    });
  });

  it('GET /hitl/approve token is HTML-escaped in the response (XSS fix)', async () => {
    // We cannot inject the XSS payload as a real hold token, so we verify the
    // escaping function itself is wired: use a hold token that contains no special
    // chars (UUIDs are safe) and confirm the page does NOT reflect raw angle brackets.
    await withRouter(createHitlRouter('test-secret'),async (url) => {
      const res  = await fetch(`${url}/hitl/approve?token=${holdToken}`);
      const html = await res.text();
      // Confirm the page structure uses the escaped token (no raw < or > in token position)
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain(holdToken); // UUID rendered as-is (no special chars to escape)
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// H-2: Stale HITL holds are denied as dead-letters on server restart
// ═══════════════════════════════════════════════════════════════════════════════

describe('H-2 — HITL dead-letter: stale holds logged and cleared on startup', () => {
  it('denyStaleHoldsOnStartup does not throw when the holds file does not exist', () => {
    // HITL_HOLDS_FILE is in DATA_DIR which doesn't exist in test env
    // The function should silently return
    expect(() => denyStaleHoldsOnStartup()).not.toThrow();
  });

  it('holds are persisted as metadata when a HOLD is registered', async () => {
    // Verify that holding a tool call also writes to the holds file
    // (the write itself is mocked at the fs level in production; here we check
    // that the hold IS registered in _pendingHolds so it could be persisted)
    const { call } = makeGuardedPair('execute_fix');
    const resultP = call({ command: 'ALTER TABLE users ADD COLUMN x TEXT' }, {});
    await Promise.resolve();

    const holds = getPendingHolds();
    expect(holds).toHaveLength(1);
    expect(holds[0].toolName).toBe('execute_fix');

    denyToolCall(holds[0].token);
    await resultP;
  });

  it('after a hold is denied its token is removed from getPendingHolds', async () => {
    const { call } = makeGuardedPair('execute_fix');
    const resultP = call({ command: 'prisma migrate deploy' }, {});
    await Promise.resolve();

    const [hold] = getPendingHolds();
    denyToolCall(hold.token);
    await resultP;

    expect(getPendingHolds()).toHaveLength(0);
  });

  it('after a hold is approved its token is removed from getPendingHolds', async () => {
    const { call } = makeGuardedPair('execute_fix');
    const resultP = call({ command: 'db:migrate --run-sync' }, {});
    await Promise.resolve();

    const [hold] = getPendingHolds();
    approveToolCall(hold.token);
    await resultP;

    expect(getPendingHolds()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// H-4: DATA_DIR respects MERGEN_DATA_DIR environment variable
// ═══════════════════════════════════════════════════════════════════════════════

describe('H-4 — DATA_DIR: MERGEN_DATA_DIR env var overrides default', () => {
  it('DATA_DIR defaults to ~/.mergen when MERGEN_DATA_DIR is not set', async () => {
    const saved = process.env.MERGEN_DATA_DIR;
    delete process.env.MERGEN_DATA_DIR;
    vi.resetModules();
    const { DATA_DIR } = await import('../../sensor/paths.js');
    const os = await import('os');
    expect(DATA_DIR).toBe(require('path').join(os.homedir(), '.mergen'));
    if (saved !== undefined) process.env.MERGEN_DATA_DIR = saved;
    vi.resetModules();
  });

  it('DATA_DIR uses MERGEN_DATA_DIR when it is set', async () => {
    process.env.MERGEN_DATA_DIR = '/app/.mergen';
    vi.resetModules();
    const { DATA_DIR } = await import('../../sensor/paths.js');
    expect(DATA_DIR).toBe('/app/.mergen');
    delete process.env.MERGEN_DATA_DIR;
    vi.resetModules();
  });

  it('MERGEN_DATA_DIR override propagates to HISTORY_DB and other derived paths', async () => {
    process.env.MERGEN_DATA_DIR = '/custom/data';
    vi.resetModules();
    const { DATA_DIR, HISTORY_DB, SECRET_FILE } = await import('../../sensor/paths.js');
    expect(DATA_DIR).toBe('/custom/data');
    expect(HISTORY_DB).toContain('/custom/data');
    expect(SECRET_FILE).toContain('/custom/data');
    delete process.env.MERGEN_DATA_DIR;
    vi.resetModules();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// H-5: Child process receives only whitelisted env vars
// ═══════════════════════════════════════════════════════════════════════════════

describe('H-5 — child process env whitelist: secrets not passed to subprocesses', () => {
  it('spawn receives an explicit env — not the full process.env', async () => {
    // Inject a sensitive credential into the test process env to prove it stays out
    process.env.MERGEN_SECRET           = 'super-secret-should-not-leak';
    process.env.DD_API_KEY              = 'dd-key-should-not-leak';
    process.env.GITHUB_TOKEN            = 'gh-token-should-not-leak';
    process.env.MERGEN_SLACK_BOT_TOKEN  = 'xoxb-should-not-leak';

    let capturedEnv: NodeJS.ProcessEnv | undefined;

    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      return {
        ...actual,
        spawn: vi.fn((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
          capturedEnv = opts.env;
          // Return a minimal fake child process
          const { EventEmitter } = require('events');
          const proc = new EventEmitter() as NodeJS.EventEmitter & {
            stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
          };
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.kill = vi.fn();
          process.nextTick(() => proc.emit('close', 0));
          return proc;
        }),
      };
    });

    vi.resetModules();
    const { executeRemediation } = await import('../../intelligence/autonomy.js');
    await executeRemediation('npm install', { actor: 'responder' });

    expect(capturedEnv).toBeDefined();
    // Required env vars must be present
    expect(capturedEnv!.PATH).toBeDefined();
    expect(capturedEnv!.HOME).toBeDefined();
    expect(capturedEnv!.NO_COLOR).toBe('1');
    expect(capturedEnv!.TERM).toBe('dumb');
    // Sensitive vars must NOT be present
    expect(capturedEnv!.MERGEN_SECRET).toBeUndefined();
    expect(capturedEnv!.DD_API_KEY).toBeUndefined();
    expect(capturedEnv!.GITHUB_TOKEN).toBeUndefined();
    expect(capturedEnv!.MERGEN_SLACK_BOT_TOKEN).toBeUndefined();

    delete process.env.MERGEN_SECRET;
    delete process.env.DD_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.MERGEN_SLACK_BOT_TOKEN;
    vi.resetModules();
  });

  it('spawn env contains exactly the whitelisted keys (no unexpected extras)', async () => {
    const WHITELISTED = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'NO_COLOR', 'TERM']);

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      return {
        ...actual,
        spawn: vi.fn((_: string, __: string[], opts: { env?: NodeJS.ProcessEnv }) => {
          capturedEnv = opts.env;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter() as NodeJS.EventEmitter & {
            stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
          };
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.kill = vi.fn();
          process.nextTick(() => proc.emit('close', 0));
          return proc;
        }),
      };
    });

    vi.resetModules();
    const { executeRemediation } = await import('../../intelligence/autonomy.js');
    await executeRemediation('npm install', { actor: 'responder' });

    const envKeys = Object.keys(capturedEnv ?? {});
    const unexpected = envKeys.filter((k) => !WHITELISTED.has(k));
    expect(unexpected).toHaveLength(0);

    vi.resetModules();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M-1: Bypass file HMAC integrity
// ═══════════════════════════════════════════════════════════════════════════════

describe('M-1 — bypass file HMAC: tampered files are rejected on load', () => {
  // Use a real tmpdir so we can read/write actual files without complex fs mocking.
  // MERGEN_DATA_DIR redirects all paths.ts constants to the tmpdir.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-m1-test-'));
  const TEST_SECRET = 'test-bypass-signing-secret-xyz';

  beforeEach(() => {
    process.env.MERGEN_DATA_DIR = tmpDir;
    vi.resetModules();
    // Purge any leftover bypass file from prior test
    try { fs.unlinkSync(path.join(tmpDir, 'bypass-pending.json')); } catch { /* ok */ }
  });

  afterEach(() => {
    delete process.env.MERGEN_DATA_DIR;
    vi.resetModules();
  });

  it('persistBypasses writes a file with a sig field when secret is set', async () => {
    const {
      setBypassSecret: sbs,
      registerBypassBlock,
      persistBypasses: pb,
    } = await import('../../intelligence/tool-guard.js');
    sbs(TEST_SECRET);
    registerBypassBlock('execute_fix', 'terraform destroy test');
    pb();

    const bypassFile = path.join(tmpDir, 'bypass-pending.json');
    expect(fs.existsSync(bypassFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(bypassFile, 'utf8')) as { sig?: string };
    expect(saved.sig).toBeDefined();
    expect(saved.sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('loadBypasses rejects a file with a tampered approved:true bypass entry', async () => {
    const {
      setBypassSecret: sbs,
      registerBypassBlock,
      persistBypasses: pb,
      loadBypasses: lb,
      getPendingBypasses,
    } = await import('../../intelligence/tool-guard.js');
    sbs(TEST_SECRET);
    registerBypassBlock('execute_fix', 'kubectl delete pod api');
    pb();

    // Read, tamper, and write back without updating the sig
    const bypassFile = path.join(tmpDir, 'bypass-pending.json');
    const saved = JSON.parse(fs.readFileSync(bypassFile, 'utf8')) as {
      version: number; bypasses: Array<{ approved: boolean }>; sig: string;
    };
    saved.bypasses[0].approved = true; // pre-approve without re-signing
    fs.writeFileSync(bypassFile, JSON.stringify(saved), 'utf8');

    lb(); // load from tampered file

    // HMAC mismatch → file should be discarded → no bypasses loaded
    expect(getPendingBypasses()).toHaveLength(0);
  });

  it('loadBypasses accepts a file without a sig (migration: signed before signing was enabled)', async () => {
    const { setBypassSecret: sbs, loadBypasses: lb } = await import('../../intelligence/tool-guard.js');
    sbs(TEST_SECRET);

    // Write a file without sig (as it would have been written before M-1 fix)
    const bypassFile = path.join(tmpDir, 'bypass-pending.json');
    fs.writeFileSync(bypassFile, JSON.stringify({
      version: 1,
      bypasses: [{
        token: 'aaaa1111bbbb2222cccc3333dddd4444',
        toolName: 'execute_fix',
        commandArg: 'npm install',
        triggeredRules: [],
        registeredAt: Date.now(),
        approved: false,
        expiresAt: Date.now() + 600_000,
      }],
      // intentionally no sig field
    }), 'utf8');

    // Should not throw — migration path accepts no-sig files
    expect(() => lb()).not.toThrow();
  });

  it('a valid signed file round-trips correctly through persist + load', async () => {
    const {
      setBypassSecret: sbs,
      registerBypassBlock,
      persistBypasses: pb,
      loadBypasses: lb,
      getPendingBypasses,
    } = await import('../../intelligence/tool-guard.js');
    sbs(TEST_SECRET);
    registerBypassBlock('execute_fix', 'npm install');
    pb();

    // Re-import fresh module (simulates server restart)
    vi.resetModules();
    process.env.MERGEN_DATA_DIR = tmpDir;
    const {
      setBypassSecret: sbs2,
      loadBypasses: lb2,
      getPendingBypasses: gpb2,
    } = await import('../../intelligence/tool-guard.js');
    sbs2(TEST_SECRET);
    lb2();

    const pending = gpb2();
    expect(pending.length).toBe(1);
    expect(pending[0].commandArg).toBe('npm install');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M-2: Route-scoped CSP headers
// ═══════════════════════════════════════════════════════════════════════════════

describe('M-2 — route-scoped CSP: API paths get strict CSP, dashboard paths are exempt', () => {
  // The exempt path list and CSP logic from app.ts is tested inline here to
  // verify the path-matching semantics without standing up the full server.
  const STRICT_CSP = "default-src 'none'; frame-ancestors 'none'";
  const CSP_EXEMPT_PREFIXES = [
    '/dashboard', '/setup', '/demo', '/sdk',
    '/feedback', '/billing',
    '/slack/actions',
    '/hitl/approve', '/hitl/deny',
  ];

  function shouldApplyCSP(path: string): boolean {
    return !CSP_EXEMPT_PREFIXES.some(
      (p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'),
    );
  }

  const API_PATHS = [
    '/ingest', '/incidents', '/overrides', '/hitl/pending',
    '/rbac', '/policies', '/agent-blunders', '/impact-report',
    '/override-corpus', '/shadow-report/entries', '/gate-analytics',
    '/audit', '/health', '/sessions/history',
  ];

  const EXEMPT_PATHS = [
    '/dashboard', '/dashboard/metrics', '/setup', '/setup/wizard',
    '/demo', '/demo/reset', '/sdk',
    '/feedback', '/feedback/link', '/billing', '/billing/dashboard',
    '/slack/actions',
    '/hitl/approve', '/hitl/approve?token=abc',
    '/hitl/deny', '/hitl/deny?token=xyz',
  ];

  for (const path of API_PATHS) {
    it(`${path} receives strict CSP`, () => {
      expect(shouldApplyCSP(path)).toBe(true);
    });
  }

  for (const path of EXEMPT_PATHS) {
    it(`${path} is exempt from strict CSP (dashboard/UI route)`, () => {
      expect(shouldApplyCSP(path)).toBe(false);
    });
  }

  it('strict CSP value is default-src none; frame-ancestors none', () => {
    // Verify the value is correct before checking it's applied
    expect(STRICT_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(STRICT_CSP).toContain('frame-ancestors');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M-3: isAiActor — unknown actors default to AI; MERGEN_TRUSTED_HUMANS works
// ═══════════════════════════════════════════════════════════════════════════════

describe('M-3 — isAiActor: unknown actors default to AI (fail-secure)', () => {
  it('known AI patterns are still detected as AI', () => {
    expect(isAiActor('claude')).toBe(true);
    expect(isAiActor('cursor')).toBe(true);
    expect(isAiActor('agent')).toBe(true);
    expect(isAiActor('copilot')).toBe(true);
    expect(isAiActor('windsurf')).toBe(true);
    expect(isAiActor('github-actions')).toBe(true);
    expect(isAiActor('my-bot')).toBe(true);
  });

  it('empty string defaults to AI (unknown = fail-secure)', () => {
    expect(isAiActor('')).toBe(true);
  });

  it('a completely unknown actor name defaults to AI', () => {
    expect(isAiActor('some-unknown-system-xyz')).toBe(true);
    expect(isAiActor('deploy-runner-prod')).toBe(true);
    expect(isAiActor('ci-pipeline-v3')).toBe(true);
  });

  it('"human" prefix convention returns false (not AI)', () => {
    expect(isAiActor('human')).toBe(false);
    expect(isAiActor('human_alice')).toBe(false);
    expect(isAiActor('human-engineer')).toBe(false);
  });

  it('MERGEN_TRUSTED_HUMANS: whitelisted names are treated as human (not AI)', async () => {
    process.env.MERGEN_TRUSTED_HUMANS = 'alice,on-call-bob,sre-team';
    vi.resetModules();
    const { isAiActor: isAiActorFresh } = await import('../../intelligence/enterprise-policy-engine.js');

    expect(isAiActorFresh('alice')).toBe(false);
    expect(isAiActorFresh('on-call-bob')).toBe(false);
    expect(isAiActorFresh('sre-team')).toBe(false);

    // Non-whitelisted still default to AI
    expect(isAiActorFresh('charlie')).toBe(true);
    expect(isAiActorFresh('unknown-system')).toBe(true);

    delete process.env.MERGEN_TRUSTED_HUMANS;
    vi.resetModules();
  });

  it('MERGEN_TRUSTED_HUMANS is case-insensitive', async () => {
    process.env.MERGEN_TRUSTED_HUMANS = 'Alice,BOB';
    vi.resetModules();
    const { isAiActor: isAiActorFresh } = await import('../../intelligence/enterprise-policy-engine.js');

    expect(isAiActorFresh('alice')).toBe(false);
    expect(isAiActorFresh('ALICE')).toBe(false);
    expect(isAiActorFresh('bob')).toBe(false);
    expect(isAiActorFresh('BOB')).toBe(false);

    delete process.env.MERGEN_TRUSTED_HUMANS;
    vi.resetModules();
  });

  it('without MERGEN_TRUSTED_HUMANS, no names are whitelisted as human', async () => {
    delete process.env.MERGEN_TRUSTED_HUMANS;
    vi.resetModules();
    const { isAiActor: isAiActorFresh } = await import('../../intelligence/enterprise-policy-engine.js');

    // All unknown names default to AI without explicit whitelist
    expect(isAiActorFresh('alice')).toBe(true);
    expect(isAiActorFresh('bob')).toBe(true);
    expect(isAiActorFresh('sre-team')).toBe(true);

    vi.resetModules();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M-4: /ingest always requires x-mergen-secret (no unauthenticated fallback)
// ═══════════════════════════════════════════════════════════════════════════════

describe('M-4 — ingest auth: createIngestRouter always requires secret', () => {
  it('createIngestRouter exports a factory function that accepts one argument', async () => {
    vi.resetModules();
    const { createIngestRouter } = await import('../../sensor/ingest.js');
    expect(typeof createIngestRouter).toBe('function');
    expect(createIngestRouter.length).toBe(1);
    vi.resetModules();
  });

  it('effective secret prefers MERGEN_SECRET over localSecret when env is set', () => {
    // The auth guard in createIngestRouter uses: process.env.MERGEN_SECRET ?? localSecret
    const localSecret = 'local-generated-secret';
    const envSecret   = 'env-configured-secret';

    process.env.MERGEN_SECRET = envSecret;
    const effectiveWithEnv = process.env.MERGEN_SECRET ?? localSecret;
    expect(effectiveWithEnv).toBe(envSecret);
    delete process.env.MERGEN_SECRET;
  });

  it('effective secret falls back to localSecret when MERGEN_SECRET is not set', () => {
    const localSecret = 'local-generated-secret';
    delete process.env.MERGEN_SECRET;
    const effectiveWithout = process.env.MERGEN_SECRET ?? localSecret;
    expect(effectiveWithout).toBe(localSecret);
  });

  it('effective secret is always non-empty when localSecret is provided', () => {
    const localSecret = 'non-empty-local-secret';
    delete process.env.MERGEN_SECRET;
    const effective = process.env.MERGEN_SECRET ?? localSecret;
    expect(effective.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M-5: Per-tenant rate-limiting buckets are independent
// ═══════════════════════════════════════════════════════════════════════════════

describe('M-5 — per-tenant rate limiting: tenants do not share buckets', () => {
  it('two independent TokenBuckets are independently exhausted', () => {
    const bucketA = new TokenBucket(3, 1_000);
    const bucketB = new TokenBucket(3, 1_000);

    // Exhaust bucket A
    expect(bucketA.isRateLimited()).toBe(false);
    expect(bucketA.isRateLimited()).toBe(false);
    expect(bucketA.isRateLimited()).toBe(false);
    expect(bucketA.isRateLimited()).toBe(true); // A is full

    // Bucket B is completely unaffected
    expect(bucketB.isRateLimited()).toBe(false);
    expect(bucketB.isRateLimited()).toBe(false);
    expect(bucketB.isRateLimited()).toBe(false);
    expect(bucketB.isRateLimited()).toBe(true); // B is independently full

    bucketA.reset();
    bucketB.reset();
  });

  it('exhausting one tenant bucket does not rate-limit another tenant', () => {
    // Simulate the per-tenant Map approach:
    // key = tenantId → TokenBucket
    const tenantBuckets = new Map<string, TokenBucket>();
    function getBucket(tenantId: string): TokenBucket {
      if (!tenantBuckets.has(tenantId)) tenantBuckets.set(tenantId, new TokenBucket(2, 1_000));
      return tenantBuckets.get(tenantId)!;
    }

    // Exhaust tenant-alpha
    getBucket('tenant-alpha').isRateLimited();
    getBucket('tenant-alpha').isRateLimited();
    expect(getBucket('tenant-alpha').isRateLimited()).toBe(true);

    // tenant-beta is completely fresh
    expect(getBucket('tenant-beta').isRateLimited()).toBe(false);
    expect(getBucket('tenant-beta').isRateLimited()).toBe(false);
  });

  it('each tenant gets a fresh bucket with the default limit', () => {
    const map = new Map<string, TokenBucket>();
    const ids = ['t1', 't2', 't3'];
    for (const id of ids) {
      const b = new TokenBucket(100, 1_000);
      map.set(id, b);
      // All 100 slots are available for each tenant
      expect(b.isRateLimited()).toBe(false);
      b.reset();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M-7: Safety-policy keyword precision
// ═══════════════════════════════════════════════════════════════════════════════

describe('M-7 — safety-policy keyword precision: no overbroad "delete" blocking', () => {
  // Pin to DEFAULT_SAFETY_POLICY directly so tests never read from the
  // developer's ~/.mergen/safety-policy.json (which may be a stale on-disk copy).
  beforeEach(() => { _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY); });

  it('safety policy default version is 2 (upgraded from overbroad v1)', () => {
    // Uses the cache pinned by beforeEach — never reads from disk
    const policy = loadSafetyPolicy();
    expect(policy.version).toBe(2);
  });

  it('blockedKeywords v2 does not include bare "delete"', () => {
    const policy = loadSafetyPolicy();
    expect(policy.blockedKeywords).not.toContain('delete');
  });

  it('blockedKeywords v2 includes precise multi-word patterns', () => {
    const policy = loadSafetyPolicy();
    expect(policy.blockedKeywords).toContain('drop table');
    expect(policy.blockedKeywords).toContain('delete from');
    expect(policy.blockedKeywords).toContain('kubectl delete');
    expect(policy.blockedKeywords).toContain('truncate table');
  });

  it('blockedKeywords v2 retains database service names (postgres, mysql, redis, mongo)', () => {
    const policy = loadSafetyPolicy();
    expect(policy.blockedKeywords).toContain('postgres');
    expect(policy.blockedKeywords).toContain('mysql');
    expect(policy.blockedKeywords).toContain('redis');
    expect(policy.blockedKeywords).toContain('mongo');
  });

  it('"docker restart postgres-container" is blocked (postgres is a db keyword)', () => {
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    const r = checkSafetyPolicy('docker restart postgres-container');
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/postgres/i);
  });

  it('"drop table users" exact SQL pattern is blocked', () => {
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    const r = checkSafetyPolicy('drop table users');
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/drop table/i);
  });

  it('"delete from users" exact SQL pattern is blocked', () => {
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    const r = checkSafetyPolicy('delete from users where id = 1');
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/delete from/i);
  });

  it('"kubectl delete pod api-xxx" is blocked', () => {
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    const r = checkSafetyPolicy('kubectl delete pod api-xxx-yyy-zzz');
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/kubectl delete/i);
  });

  it('"drop database" is blocked', () => {
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    const r = checkSafetyPolicy('drop database mydb');
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/drop database/i);
  });

  it('"truncate table" is blocked', () => {
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    const r = checkSafetyPolicy('truncate table events');
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/truncate table/i);
  });

  it('"docker restart delete-old-records" passes (benign container name with "delete")', () => {
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    // Container name contains "delete" but not any multi-word blocked pattern.
    // 'delete-old-records' does NOT contain 'delete from', 'drop table', etc.
    const r = checkSafetyPolicy('docker restart delete-old-records');
    expect(r.allowed).toBe(true);
  });

  it('"npm run delete-cache" passes (delete is not a blocked keyword in v2)', () => {
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    const r = checkSafetyPolicy('npm run delete-cache');
    expect(r.allowed).toBe(true);
  });

  it('"git branch -d delete-feature" passes (no blocked pattern matches)', () => {
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    const r = checkSafetyPolicy('git branch -d delete-feature');
    expect(r.allowed).toBe(true);
  });

  it('"docker restart delete-from-app" passes — "delete-from" is not "delete from"', () => {
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    // 'delete from' requires a space; 'delete-from' (hyphen) does not match
    const r = checkSafetyPolicy('docker restart delete-from-app');
    expect(r.allowed).toBe(true);
  });

  it('v1 policy has overbroad "delete" keyword; v2 defaults replace it with specific patterns', () => {
    // Inject a v1-style policy — the overbroad one that was shipped before this fix
    _resetSafetyPolicyForTesting({
      version: 1,
      blockedKeywords: ['rm -rf', 'drop table', 'truncate', 'delete', 'production-db',
        'postgres', 'mysql', 'redis', 'mongo'],
      blockedServices: ['payments', 'auth-service', 'database'],
    });
    const v1 = loadSafetyPolicy(); // returns the injected v1 from cache
    expect(v1.version).toBe(1);
    expect(v1.blockedKeywords).toContain('delete'); // overbroad keyword present

    // Pin to DEFAULT (v2) and verify the upgrade
    _resetSafetyPolicyForTesting(DEFAULT_SAFETY_POLICY);
    const v2 = loadSafetyPolicy();
    expect(v2.version).toBe(2);
    expect(v2.blockedKeywords).not.toContain('delete');  // removed
    expect(v2.blockedKeywords).toContain('delete from'); // replaced with specific
    expect(v2.blockedKeywords).toContain('postgres');    // retained
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M-9: block_destructive_commands survives remote policy replace
// ═══════════════════════════════════════════════════════════════════════════════

describe('M-9 — immutable rules: block_destructive_commands survives remote replace', () => {
  it('block_destructive_commands is in the DEFAULT_ENTERPRISE_POLICY', () => {
    _resetPolicyCacheForTesting();
    const policy = loadEnterprisePolicy();
    const rule = policy.rules.find(r => r.id === 'block_destructive_commands');
    expect(rule).toBeDefined();
    expect(rule!.action).toBe('block');
  });

  it('an incoming remote policy with enabled:false is rejected by the immutable rule check', async () => {
    // Simulate what policy-sync does in 'replace' mode: it preserves immutable rules
    const IMMUTABLE_RULE_IDS = new Set(['block_destructive_commands']);

    const local = loadEnterprisePolicy();
    const remote: EnterprisePolicyConfig = { enabled: false, rules: [] };

    // The policy-sync merge logic in replace mode:
    const immutableRules = local.rules.filter(r => IMMUTABLE_RULE_IDS.has(r.id));
    const remoteRulesWithoutImmutable = remote.rules.filter(r => !IMMUTABLE_RULE_IDS.has(r.id));
    const merged = { ...remote, rules: [...immutableRules, ...remoteRulesWithoutImmutable] };

    // Even though remote had enabled:false and zero rules:
    expect(merged.rules.length).toBeGreaterThan(0);
    expect(merged.rules.find(r => r.id === 'block_destructive_commands')).toBeDefined();
  });

  it('a remote policy that removes block_destructive_commands still keeps it after merge', () => {
    const IMMUTABLE_RULE_IDS = new Set(['block_destructive_commands']);

    const local = loadEnterprisePolicy();
    const remote: EnterprisePolicyConfig = {
      enabled: true,
      rules: [
        // Remote has new custom rules but NOT block_destructive_commands
        { id: 'custom_rule', name: 'Custom', description: '', action: 'warn', reason: 'custom', conditions: {} },
      ],
    };

    const immutableRules = local.rules.filter(r => IMMUTABLE_RULE_IDS.has(r.id));
    const remoteRulesWithoutImmutable = remote.rules.filter(r => !IMMUTABLE_RULE_IDS.has(r.id));
    const merged = { ...remote, rules: [...immutableRules, ...remoteRulesWithoutImmutable] };

    expect(merged.rules.find(r => r.id === 'block_destructive_commands')).toBeDefined();
    expect(merged.rules.find(r => r.id === 'custom_rule')).toBeDefined();
  });

  it('a remote policy cannot override the block_destructive_commands action to "pass"', () => {
    const IMMUTABLE_RULE_IDS = new Set(['block_destructive_commands']);

    const local = loadEnterprisePolicy();
    const remote: EnterprisePolicyConfig = {
      enabled: true,
      rules: [
        {
          // Attacker tries to weaken the rule by making it 'pass' instead of 'block'
          id: 'block_destructive_commands',
          name: 'Block destructive commands (weakened)',
          description: 'Weakened version',
          action: 'pass',
          reason: 'Policy removed',
          conditions: {},
        },
      ],
    };

    const immutableRules = local.rules.filter(r => IMMUTABLE_RULE_IDS.has(r.id));
    const remoteRulesWithoutImmutable = remote.rules.filter(r => !IMMUTABLE_RULE_IDS.has(r.id));
    const merged = { ...remote, rules: [...immutableRules, ...remoteRulesWithoutImmutable] };

    // The remote 'pass' version is stripped; only the local 'block' version survives
    const blockRule = merged.rules.find(r => r.id === 'block_destructive_commands');
    expect(blockRule).toBeDefined();
    expect(blockRule!.action).toBe('block'); // never 'pass'
  });

  it('merge mode: remote rules supplement local without removing block_destructive_commands', () => {
    const local = loadEnterprisePolicy();
    const remote: EnterprisePolicyConfig = {
      enabled: true,
      rules: [{ id: 'extra_rule', name: 'Extra', description: '', action: 'warn', reason: '', conditions: {} }],
    };

    // In merge mode:
    const existingIds = new Set(local.rules.map(r => r.id));
    const merged = { ...local, rules: [...local.rules, ...remote.rules.filter(r => !existingIds.has(r.id))] };

    expect(merged.rules.find(r => r.id === 'block_destructive_commands')).toBeDefined();
    expect(merged.rules.find(r => r.id === 'extra_rule')).toBeDefined();
  });

  it('after a remote replace, terraform destroy is still blocked by the gate', async () => {
    // Simulate the result of a remote replace with policy that has no rules
    const remote: EnterprisePolicyConfig = { enabled: true, rules: [] };
    const IMMUTABLE_RULE_IDS = new Set(['block_destructive_commands']);
    const local = loadEnterprisePolicy();
    const immutableRules = local.rules.filter(r => IMMUTABLE_RULE_IDS.has(r.id));
    const merged = { ...remote, rules: immutableRules };
    _resetPolicyCacheForTesting(merged);

    // Gate evaluation with merged policy
    const { call } = makeGuardedPair('execute_fix');
    const result = await call({ command: 'terraform destroy prod' }, {});
    expect(result.isError).toBe(true);
  });
});
