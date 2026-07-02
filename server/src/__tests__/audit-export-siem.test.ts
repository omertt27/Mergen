/**
 * audit-export-siem.test.ts — GET /audit/export?format=siem (P0.5).
 *
 * Pull-based counterpart to siem-forward.ts's push delivery. Mounts just
 * createAuditExportRouter() against mocked audit-fetch helpers.
 */
import net from 'net';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetchBlunderEntries = vi.fn();
const mockFetchHttpAuditEntries = vi.fn();
const mockFetchChainVerification = vi.fn();

vi.mock('../sensor/audit-fetch.js', () => ({
  fetchBlunderEntries: (...a: unknown[]) => mockFetchBlunderEntries(...a),
  fetchHttpAuditEntries: (...a: unknown[]) => mockFetchHttpAuditEntries(...a),
  fetchChainVerification: (...a: unknown[]) => mockFetchChainVerification(...a),
}));

import { createAuditExportRouter } from '../routes/audit-export.js';

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
  mockFetchBlunderEntries.mockReset().mockResolvedValue([
    { id: 'b1', recordedAt: Date.now(), actor: 'agent', blunderType: 'pipeline_block', command: 'rm -rf /', blockReason: 'x', service: 'api', tag: null, pid: null, previousHash: 'a'.repeat(64), hash: 'b'.repeat(64) },
  ]);
  mockFetchHttpAuditEntries.mockReset().mockResolvedValue([
    { ts: new Date().toISOString(), actor: 'agent', method: 'POST', path: '/gate/evaluate', status: 200, durationMs: 5, ip: '127.0.0.1' },
  ]);
  mockFetchChainVerification.mockReset().mockResolvedValue({ valid: true, verified: 1, tamperEvidenceLevel: 'hash-chain', hmacProtected: false });

  port = await findFreePort();
  const app = express();
  app.use(express.json());
  app.use(createAuditExportRouter());
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterEach(() => { server.close(); });

describe('GET /audit/export?format=siem', () => {
  it('returns only blunder entries, ignoring type=http', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/audit/export?format=siem&type=http`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.source).toBe('blunder_log');
    // type=http was overridden to blunders-only — the HTTP fetch should never have been called.
    expect(mockFetchHttpAuditEntries).not.toHaveBeenCalled();
  });

  it('does not include a SOC2 header line (distinct from format=soc2)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/audit/export?format=siem`);
    const text = await res.text();
    expect(text).not.toContain('__export_header__');
  });

  it('sets a mergen-siem filename', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/audit/export?format=siem`);
    expect(res.headers.get('content-disposition')).toMatch(/mergen-siem-/);
  });

  it('format=soc2 still includes the header (regression — siem addition did not break soc2)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/audit/export?format=soc2`);
    const text = await res.text();
    expect(text).toContain('__export_header__');
    expect(text).toContain('tamperEvidenceLevel');
  });
});
