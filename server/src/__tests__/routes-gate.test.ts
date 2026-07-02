/**
 * routes-gate.test.ts — POST /gate/evaluate (routes/gate.ts).
 *
 * Mounts just this router (not the full app) against a mocked applyGate, so
 * the test verifies the route's request/response contract without dragging
 * in createApp's full dependency graph. The route is a thin wrapper — its job
 * is to call applyGate with the right shape and translate the McpResult into
 * { isError, text }, which is what these tests check. Real HTTP requests
 * against an ephemeral port + native fetch, matching this repo's convention
 * in routes-smoke.test.ts (no supertest dependency in this project).
 */
import net from 'net';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockApplyGate = vi.fn();
vi.mock('../intelligence/tool-guard.js', () => ({
  applyGate: (...a: unknown[]) => mockApplyGate(...a),
}));

import { createGateRouter } from '../routes/gate.js';

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
let port: number;

beforeEach(async () => {
  mockApplyGate.mockReset();
  port = await findFreePort();
  const app = express();
  app.use(express.json());
  app.use(createGateRouter(port));
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterEach(() => { server.close(); });

function post(body: object): Promise<{ status: number; body: { isError?: boolean; text?: string; error?: string } }> {
  return fetch(`http://127.0.0.1:${port}/gate/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

describe('POST /gate/evaluate', () => {
  it('400s when command is missing', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(mockApplyGate).not.toHaveBeenCalled();
  });

  it('returns isError:false and the pass-through text on PASS', async () => {
    mockApplyGate.mockResolvedValue({ content: [{ type: 'text', text: 'pass' }] });
    const res = await post({ command: 'ls -la' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isError: false, text: 'pass' });
  });

  it('returns isError:true and the block reason on BLOCK', async () => {
    mockApplyGate.mockResolvedValue({
      content: [{ type: 'text', text: '🚫 Mergen policy gate blocked this tool call.' }],
      isError: true,
    });
    const res = await post({ command: 'terraform destroy' });
    expect(res.status).toBe(200);
    expect(res.body.isError).toBe(true);
    expect(res.body.text).toMatch(/blocked/i);
  });

  it('passes toolName and command through to applyGate as args.command, and never forwards a caller-supplied actor', async () => {
    mockApplyGate.mockResolvedValue({ content: [{ type: 'text', text: 'pass' }] });
    await post({ command: 'npm run migrate', toolName: 'custom_tool', actor: 'human' });
    expect(mockApplyGate).toHaveBeenCalledTimes(1);
    const [toolName, args] = mockApplyGate.mock.calls[0];
    expect(toolName).toBe('custom_tool');
    expect(args).toEqual({ command: 'npm run migrate' });
  });

  it('defaults toolName to cli_exec when not provided', async () => {
    mockApplyGate.mockResolvedValue({ content: [{ type: 'text', text: 'pass' }] });
    await post({ command: 'echo hi' });
    const [toolName] = mockApplyGate.mock.calls[0];
    expect(toolName).toBe('cli_exec');
  });
});
