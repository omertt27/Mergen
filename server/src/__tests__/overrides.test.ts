/**
 * overrides.test.ts — Integration tests for the overrides / override-corpus router.
 *
 * Covers: POST /overrides, PATCH /overrides/:id/outcome, GET /override-corpus, GET /overrides/:tag
 */

import net from 'net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';

// ── Mock override corpus ──────────────────────────────────────────────────────

const mockOverrideEvent = {
  id: 'evt-1',
  incidentTag: 'db_timeout',
  proposedCommand: 'kubectl rollout restart deployment/api',
  overrideReason: 'wrong-fix' as const,
  service: 'api',
  environment: 'production',
  actor: 'alice',
  recordedAt: Date.now(),
  dayOfWeek: 1,
  hourOfDay: 14,
  outcome: null,
};

const mockRecordOverride = vi.fn().mockReturnValue(mockOverrideEvent);
const mockUpdateOutcome  = vi.fn().mockReturnValue(true);
const mockGetSummary     = vi.fn().mockReturnValue([{ tag: 'db_timeout', count: 3, dominantReason: 'wrong-fix' }]);
const mockGetForTag      = vi.fn().mockReturnValue([mockOverrideEvent]);

vi.mock('../intelligence/override-corpus.js', () => ({
  recordOverride: (...args: unknown[]) => mockRecordOverride(...args),
  updateOutcome:  (...args: unknown[]) => mockUpdateOutcome(...args),
  getOverrideSummary: () => mockGetSummary(),
  getOverridesForTag: (...args: unknown[]) => mockGetForTag(...args),
  OVERRIDE_REASONS: [
    'batch-window', 'cost-constraint', 'on-call-discretion',
    'compliance-hold', 'prefer-read-replica', 'maintenance-window',
    'wrong-diagnosis', 'wrong-fix', 'other',
  ],
}));

vi.mock('../intelligence/slack.js', () => ({
  postIncidentAlert: vi.fn(), postThreadReply: vi.fn(),
  handleSlackActions: vi.fn(), handleFeedbackLink: vi.fn(),
  postApprovalRequest: vi.fn(), fetchIncidentChannelContext: vi.fn(),
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

const TEST_SECRET = 'test-secret-overrides';

let server: HttpServer;
let port: number;

beforeEach(async () => {
  vi.clearAllMocks();
  mockRecordOverride.mockReturnValue(mockOverrideEvent);
  mockUpdateOutcome.mockReturnValue(true);
  mockGetSummary.mockReturnValue([{ tag: 'db_timeout', count: 3, dominantReason: 'wrong-fix' }]);
  mockGetForTag.mockReturnValue([mockOverrideEvent]);

  port = await findFreePort();
  const app = createApp({ serverVersion: '0.0.0-test', localSecret: TEST_SECRET, port, bindHost: '127.0.0.1' });
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterEach(() => { server.close(); });

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-mergen-secret': TEST_SECRET };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /overrides', () => {
  const validBody = {
    incidentTag:     'db_timeout',
    proposedCommand: 'kubectl rollout restart deployment/api',
    overrideReason:  'wrong-fix',
    service:         'api',
    environment:     'production',
    actor:           'alice',
  };

  it('records a valid override and returns 201', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/overrides`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; override: typeof mockOverrideEvent };
    expect(body.ok).toBe(true);
    expect(body.override.id).toBe('evt-1');
    expect(mockRecordOverride).toHaveBeenCalled();
  });

  it('returns 400 for missing required fields', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/overrides`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ incidentTag: 'db_timeout' }), // missing proposedCommand etc.
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid overrideReason', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/overrides`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...validBody, overrideReason: 'totally_invalid' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when reason is "other" but note is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/overrides`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...validBody, overrideReason: 'other' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/note is required/);
  });

  it('accepts override with reason "other" and a note', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/overrides`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...validBody, overrideReason: 'other', note: 'friday freeze' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /overrides/:id/outcome', () => {
  it('updates outcome and returns 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/overrides/evt-1/outcome`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ outcome: 'resolved' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockUpdateOutcome).toHaveBeenCalledWith('evt-1', 'resolved');
  });

  it('returns 404 when override is not found', async () => {
    mockUpdateOutcome.mockReturnValue(false);
    const res = await fetch(`http://127.0.0.1:${port}/overrides/missing/outcome`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ outcome: 'resolved' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid outcome', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/overrides/evt-1/outcome`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ outcome: 'totally_invalid' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /override-corpus', () => {
  it('returns corpus summary', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/override-corpus`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; corpus: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.corpus)).toBe(true);
    expect(mockGetSummary).toHaveBeenCalled();
  });
});

describe('GET /overrides/:tag', () => {
  it('returns override history for a tag', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/overrides/db_timeout`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; tag: string; overrides: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.tag).toBe('db_timeout');
    expect(Array.isArray(body.overrides)).toBe(true);
    expect(mockGetForTag).toHaveBeenCalledWith('db_timeout');
  });

  it('returns empty array for unknown tag', async () => {
    mockGetForTag.mockReturnValue([]);
    const res = await fetch(`http://127.0.0.1:${port}/overrides/unknown_tag`);
    expect(res.status).toBe(200);
    const body = await res.json() as { overrides: unknown[] };
    expect(body.overrides).toEqual([]);
  });
});
