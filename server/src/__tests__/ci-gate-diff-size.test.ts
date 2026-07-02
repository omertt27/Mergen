/**
 * ci-gate-diff-size.test.ts — POST /ci/gate's diffStats integration (P1.4).
 *
 * Mounts just createCIGateRouter() against mocked storage/postmortem
 * dependencies (not the full createApp — avoids new-features.test.ts's
 * existing dependence on the real ~/.mergen/enterprise-policy.json) so this
 * test is self-contained and doesn't touch the real filesystem.
 */
import net from 'net';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../storage/store-registry.js', () => ({
  getStores: () => ({
    overrides: {
      getRulesForTag: vi.fn().mockResolvedValue([]),
      hasRecentOverride: vi.fn().mockResolvedValue(false),
      getOverrideSummary: vi.fn().mockResolvedValue([]),
    },
  }),
}));
vi.mock('../intelligence/postmortem-store.js', () => ({
  postmortemStore: { tagStats: () => [] },
}));
vi.mock('../intelligence/enterprise-policy-engine.js', () => ({
  evaluateEnterprisePolicy: () => ({ verdict: 'pass', triggeredRules: [], reasons: [] }),
  isAiActor: (actor: string) => /agent|bot|claude|copilot|cursor/i.test(actor),
}));

import { createCIGateRouter } from '../routes/ci-gate.js';

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

let server: HttpServer;
let baseURL: string;

beforeEach(async () => {
  const port = await findFreePort();
  const app = express();
  app.use(express.json());
  app.use(createCIGateRouter());
  await new Promise<void>((resolve, reject) => {
    server = app.listen(port, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${port}`; resolve(); });
    server.on('error', reject);
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function postGate(body: object) {
  return fetch(`${baseURL}/ci/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() as { verdict: string; reasons: string[]; diffSize: unknown } }));
}

describe('POST /ci/gate — diffStats', () => {
  it('is unaffected (diffSize: null) when diffStats is not provided', async () => {
    const res = await postGate({ files: ['src/index.ts'], actor: 'human-alice' });
    expect(res.body.diffSize).toBeNull();
    expect(res.body.verdict).toBe('pass');
  });

  it('stays pass for a small diff even from an AI actor', async () => {
    const res = await postGate({
      files: ['src/index.ts'], actor: 'claudecode-agent',
      diffStats: { filesChanged: 2, additions: 30, deletions: 10 },
    });
    expect(res.body.verdict).toBe('pass');
  });

  it('escalates to warn for a large diff (does not hard-block on size alone)', async () => {
    const res = await postGate({
      files: ['src/index.ts'], actor: 'human-alice',
      diffStats: { filesChanged: 5, additions: 500, deletions: 300 }, // 800 lines → score 50 (MEDIUM)
    });
    expect(res.body.verdict).toBe('warn');
    expect((res.body.diffSize as { level: string }).level).toBe('MEDIUM');
  });

  it('escalates to warn (not block) even for a HIGH-scoring AI-authored diff', async () => {
    const res = await postGate({
      files: ['src/index.ts'], actor: 'claudecode-agent',
      diffStats: { filesChanged: 50, additions: 3000, deletions: 1000 },
    });
    expect(res.body.verdict).toBe('warn');
    expect((res.body.diffSize as { level: string; requiresApproval: boolean }).level).toBe('HIGH');
    expect((res.body.diffSize as { requiresApproval: boolean }).requiresApproval).toBe(true);
    expect(res.body.reasons.some((r) => r.includes('Diff size HIGH'))).toBe(true);
  });
});
