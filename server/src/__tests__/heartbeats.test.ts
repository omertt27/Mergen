/**
 * heartbeats.test.ts — Integration tests for the heartbeat / cron monitoring router.
 *
 * Covers: POST /heartbeat/:name, GET /heartbeats, GET /heartbeat/:name, DELETE /heartbeat/:name
 */

import net from 'net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';

// ── Mock heartbeat-monitor ────────────────────────────────────────────────────

const mockHeartbeatConfig = {
  name: 'nightly-backup',
  intervalSeconds: 86400,
  graceSeconds: 300,
  description: 'Nightly DB backup job',
  lastPingAt: Date.now(),
  createdAt: Date.now() - 100_000,
};

const mockHeartbeatReport = {
  ...mockHeartbeatConfig,
  status: 'ok' as const,
  nextExpectedAt: Date.now() + 86400_000,
  missedCount: 0,
};

const mockPing          = vi.fn().mockReturnValue(mockHeartbeatConfig);
const mockGetReport     = vi.fn().mockReturnValue(mockHeartbeatReport);
const mockGetAllReports = vi.fn().mockReturnValue([mockHeartbeatReport]);
const mockRemove        = vi.fn().mockReturnValue(true);

vi.mock('../sensor/heartbeat-monitor.js', () => ({
  ping:              (...args: unknown[]) => mockPing(...args),
  getReport:         (...args: unknown[]) => mockGetReport(...args),
  getAllReports:      () => mockGetAllReports(),
  removeHeartbeat:   (...args: unknown[]) => mockRemove(...args),
  startHeartbeatMonitor: vi.fn().mockReturnValue(vi.fn()),
  setHeartbeatAlertFn:   vi.fn(),
}));

vi.mock('../intelligence/slack.js', () => ({
  postIncidentAlert: vi.fn(), postThreadReply: vi.fn(),
  handleSlackActions: vi.fn(), handleFeedbackLink: vi.fn(),
  postApprovalRequest: vi.fn(), fetchIncidentChannelContext: vi.fn(),
  postSimpleWebhookNotification: vi.fn(),
}));
vi.mock('../intelligence/incident-autopilot.js', () => ({ runIncidentAutopilot: vi.fn() }));
vi.mock('../datadog/client.js', () => ({ isConfigured: vi.fn().mockReturnValue(false), fetchLatestErrorTrace: vi.fn() }));
vi.mock('../intelligence/calibration.js', () => ({ getRecords: vi.fn().mockReturnValue([]), recordVerdict: vi.fn() }));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { createApp } from '../app.js';

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
  vi.clearAllMocks();
  mockPing.mockReturnValue(mockHeartbeatConfig);
  mockGetReport.mockReturnValue(mockHeartbeatReport);
  mockGetAllReports.mockReturnValue([mockHeartbeatReport]);
  mockRemove.mockReturnValue(true);

  port = await findFreePort();
  const app = createApp({ serverVersion: '0.0.0-test', localSecret: '', port, bindHost: '127.0.0.1' });
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterEach(() => { server.close(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /heartbeat/:name', () => {
  it('records a ping and returns heartbeat status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/heartbeat/nightly-backup?interval=86400&grace=300`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; heartbeat: typeof mockHeartbeatReport };
    expect(body.ok).toBe(true);
    expect(body.heartbeat.name).toBe('nightly-backup');
    expect(mockPing).toHaveBeenCalledWith('nightly-backup', 86400, 300, undefined);
  });

  it('accepts interval from request body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/heartbeat/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval: 3600, grace: 60, description: 'Hourly sync' }),
    });
    expect(res.status).toBe(200);
    expect(mockPing).toHaveBeenCalledWith('backup', 3600, 60, 'Hourly sync');
  });

  it('returns 400 for invalid name (special chars)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/heartbeat/my%20job%20with%20spaces`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for name longer than 80 chars', async () => {
    const longName = 'a'.repeat(81);
    const res = await fetch(`http://127.0.0.1:${port}/heartbeat/${longName}`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('clamps interval to minimum of 60s', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/heartbeat/fast-job?interval=10`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(mockPing).toHaveBeenCalledWith('fast-job', 60, undefined, undefined);
  });
});

describe('GET /heartbeats', () => {
  it('lists all heartbeats with summary', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/heartbeats`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; total: number; missing: number; heartbeats: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(1);
    expect(body.missing).toBe(0);
    expect(Array.isArray(body.heartbeats)).toBe(true);
  });

  it('counts missing heartbeats correctly', async () => {
    mockGetAllReports.mockReturnValue([
      { ...mockHeartbeatReport, status: 'ok' },
      { ...mockHeartbeatReport, name: 'job-2', status: 'missing' },
      { ...mockHeartbeatReport, name: 'job-3', status: 'never-pinged' },
    ]);
    const res = await fetch(`http://127.0.0.1:${port}/heartbeats`);
    const body = await res.json() as { total: number; missing: number };
    expect(body.total).toBe(3);
    expect(body.missing).toBe(2);
  });
});

describe('GET /heartbeat/:name', () => {
  it('returns single heartbeat status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/heartbeat/nightly-backup`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; heartbeat: typeof mockHeartbeatReport };
    expect(body.ok).toBe(true);
    expect(body.heartbeat.name).toBe('nightly-backup');
    expect(mockGetReport).toHaveBeenCalledWith('nightly-backup');
  });

  it('returns 404 for unknown heartbeat', async () => {
    mockGetReport.mockReturnValue(null);
    const res = await fetch(`http://127.0.0.1:${port}/heartbeat/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe('DELETE /heartbeat/:name', () => {
  it('removes a heartbeat', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/heartbeat/nightly-backup`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; removed: string };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe('nightly-backup');
    expect(mockRemove).toHaveBeenCalledWith('nightly-backup');
  });

  it('returns 404 when heartbeat does not exist', async () => {
    mockRemove.mockReturnValue(false);
    const res = await fetch(`http://127.0.0.1:${port}/heartbeat/ghost`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});
