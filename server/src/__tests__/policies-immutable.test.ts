/**
 * policies-immutable.test.ts — Regression coverage for Finding A: the
 * "immutable" hard-safety rule (block_destructive_commands) must survive
 * every mutation path an operator can reach via the Policy Editor API, not
 * just the `enabled` toggle (covered separately in policy-engine-patterns.test.ts).
 *
 * Uses the real (unmocked) enterprise-policy-engine + routes/policies against
 * a scratch MERGEN_DATA_DIR, driven over real HTTP via createApp — this
 * exercises the actual Express handlers, not a mocked storage layer.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';

let tmpDir: string;
let createApp: typeof import('../app.js').createApp;
let _resetPolicyCacheForTesting: typeof import('../intelligence/enterprise-policy-engine.js')._resetPolicyCacheForTesting;
let DEFAULT_ENTERPRISE_POLICY: typeof import('../intelligence/enterprise-policy-engine.js').DEFAULT_ENTERPRISE_POLICY;

const TEST_SECRET = 'test-secret-policies-immutable';
let server: HttpServer;
let port: number;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-mergen-secret': TEST_SECRET };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-policies-immutable-test-'));
  process.env.MERGEN_DATA_DIR = tmpDir;

  ({ createApp } = await import('../app.js'));
  ({ _resetPolicyCacheForTesting, DEFAULT_ENTERPRISE_POLICY } = await import('../intelligence/enterprise-policy-engine.js'));
});

afterAll(() => {
  delete process.env.MERGEN_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  _resetPolicyCacheForTesting(DEFAULT_ENTERPRISE_POLICY);

  port = await findFreePort();
  const app = createApp({ serverVersion: '0.0.0-test', localSecret: TEST_SECRET, port, bindHost: '127.0.0.1' });
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterEach(() => { server.close(); });

describe('PATCH /policies/rules/:id — immutable rule protection', () => {
  it('rejects modifying block_destructive_commands', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/policies/rules/block_destructive_commands`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ action: 'pass' }),
    });
    expect(res.status).toBe(403);

    const check = await fetch(`http://127.0.0.1:${port}/policies/json`, { headers: authHeaders() });
    const body = await check.json() as { rules: Array<{ id: string; action: string }> };
    const rule = body.rules.find(r => r.id === 'block_destructive_commands');
    expect(rule?.action).toBe('block');
  });
});

describe('DELETE /policies/rules/:id — immutable rule protection', () => {
  it('rejects deleting block_destructive_commands', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/policies/rules/block_destructive_commands`, {
      method: 'DELETE',
      headers: { 'x-mergen-secret': TEST_SECRET },
    });
    expect(res.status).toBe(403);

    const check = await fetch(`http://127.0.0.1:${port}/policies/json`, { headers: authHeaders() });
    const body = await check.json() as { rules: Array<{ id: string }> };
    expect(body.rules.some(r => r.id === 'block_destructive_commands')).toBe(true);
  });
});

describe('POST /policies/import — immutable rule survives replace mode', () => {
  it('keeps block_destructive_commands even when the imported policy omits it entirely', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/policies/import`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        mode: 'replace',
        policy: {
          enabled: true,
          rules: [{
            id: 'some_custom_rule',
            name: 'Custom rule',
            description: 'test',
            action: 'warn',
            reason: 'test',
            conditions: {},
          }],
        },
      }),
    });
    expect(res.status).toBe(200);

    const check = await fetch(`http://127.0.0.1:${port}/policies/json`, { headers: authHeaders() });
    const body = await check.json() as { rules: Array<{ id: string }> };
    expect(body.rules.some(r => r.id === 'block_destructive_commands')).toBe(true);
    expect(body.rules.some(r => r.id === 'some_custom_rule')).toBe(true);
  });
});

describe('GET /policies/json — immutable flag', () => {
  it('marks block_destructive_commands as immutable and other rules as not', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/policies/json`, { headers: authHeaders() });
    const body = await res.json() as { rules: Array<{ id: string; immutable: boolean }> };
    const hard = body.rules.find(r => r.id === 'block_destructive_commands');
    const soft = body.rules.find(r => r.id === 'hold_schema_mutations');
    expect(hard?.immutable).toBe(true);
    expect(soft?.immutable).toBe(false);
  });
});
