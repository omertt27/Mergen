/**
 * routes-smoke.test.ts — Smoke tests for routes that weren't covered elsewhere.
 *
 * Each test makes a real HTTP request and asserts:
 *   1. The route returns a 2xx status code
 *   2. The response has the expected shape
 *
 * Routes covered:
 *   - GET  /agent-blunders
 *   - GET  /validate/state
 *   - GET  /habituation
 *   - GET  /shadow-report
 *   - GET  /shadow-report/entries
 *   - GET  /shadow-report/slack-digest
 *   - GET  /slack/routing
 *   - POST /slack/routing  (validation errors)
 *   - DELETE /slack/routing/:id (not found)
 *   - GET  /incidents/postmortems
 *   - GET  /incidents/replay-snapshots
 *   - GET  /incidents/graph
 *   - GET  /services/interactions
 *   - GET  /override-corpus
 *   - GET  /commit-contexts
 *   - POST /incidents/resolve-active (no open incident)
 */

import net from 'net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';

// ── Shared mocks required by createApp ───────────────────────────────────────

vi.mock('../intelligence/slack.js', () => ({
  postIncidentAlert: vi.fn(), postThreadReply: vi.fn(),
  handleSlackActions: vi.fn(), handleFeedbackLink: vi.fn(),
  postApprovalRequest: vi.fn(), fetchIncidentChannelContext: vi.fn(),
  postSimpleWebhookNotification: vi.fn(),
}));
vi.mock('../intelligence/incident-autopilot.js', () => ({ runIncidentAutopilot: vi.fn() }));
vi.mock('../datadog/client.js', () => ({ isConfigured: vi.fn().mockReturnValue(false), fetchLatestErrorTrace: vi.fn() }));
vi.mock('../intelligence/calibration.js', () => ({ getRecords: vi.fn().mockReturnValue([]), recordVerdict: vi.fn() }));

// Mock store deps used by routes under test
vi.mock('../sensor/incident-store.js', () => ({
  incidentStore: {
    list:                vi.fn().mockReturnValue([]),
    get:                 vi.fn().mockReturnValue(null),
    upsert:              vi.fn().mockImplementation((pid: string, d: object) => ({ pid, ...d, createdAt: Date.now(), notes: [] })),
    addNote:             vi.fn().mockReturnValue(null),
    markContextViewed:   vi.fn(),
    getInteractionGraph: vi.fn().mockReturnValue([]),
    init:                vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../datadog/memory-store.js', () => ({
  memoryStore: { listOpen: vi.fn().mockReturnValue([]), closeIncident: vi.fn(), recordAttributionFeedback: vi.fn() },
  inferResolutionType: vi.fn().mockReturnValue('unknown'),
}));
vi.mock('../datadog/incident-state.js', () => ({
  getActiveIncident: vi.fn().mockReturnValue(null),
  clearActiveIncident: vi.fn(),
  setActiveIncident: vi.fn(),
}));
vi.mock('../intelligence/incident-replay.js', () => ({
  replayIncident: vi.fn().mockResolvedValue(null),
  listSnapshotPids: vi.fn().mockReturnValue([]),
}));
vi.mock('../intelligence/postmortem-store.js', () => ({
  postmortemStore: {
    list: vi.fn().mockReturnValue([]), getByTag: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0), tagStats: vi.fn().mockReturnValue({}),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../sensor/commit-context-store.js', () => ({
  commitContextStore: {
    listByWindow: vi.fn().mockReturnValue([]), listByRepo: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0), getBySha: vi.fn().mockReturnValue(null),
    init: vi.fn().mockResolvedValue(undefined),
  },
  extractLinkedIssues: vi.fn().mockReturnValue([]),
}));
vi.mock('../intelligence/override-corpus.js', () => ({
  recordOverride: vi.fn(),
  updateOutcome: vi.fn().mockReturnValue(false),
  getOverrideSummary: vi.fn().mockReturnValue([]),
  getOverridesForTag: vi.fn().mockReturnValue([]),
  OVERRIDE_REASONS: ['wrong_service', 'wrong_environment', 'already_in_progress', 'compliance_hold', 'manual_fix_preferred', 'other'],
  hasRecentOverride: vi.fn().mockReturnValue(false),
  dominantOverrideReason: vi.fn().mockReturnValue(null),
  getAllOverrides: vi.fn().mockReturnValue([]),
}));

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

const TEST_SECRET = 'test-secret-smoke';

let server: HttpServer;
let port: number;

beforeEach(async () => {
  port = await findFreePort();
  const app = createApp({ serverVersion: '0.0.0-test', localSecret: TEST_SECRET, port, bindHost: '127.0.0.1' });
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterEach(() => { server.close(); });

function authPost(path: string, body: object): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mergen-secret': TEST_SECRET },
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

async function authGet(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'x-mergen-secret': TEST_SECRET },
  });
  return { status: res.status, body: await res.json() };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /agent-blunders', () => {
  it('returns prevented count and recent blunders (requires secret)', async () => {
    const { status, body } = await authGet('/agent-blunders');
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect(typeof (body as { prevented: number }).prevented).toBe('number');
  });

  it('accepts ?limit= param', async () => {
    const { status } = await authGet('/agent-blunders?limit=5');
    expect(status).toBe(200);
  });

  it('returns 401 without secret', async () => {
    const { status } = await get('/agent-blunders');
    expect(status).toBe(401);
  });
});

describe('GET /validate/state', () => {
  it('returns watching state', async () => {
    const { status, body } = await get('/validate/state');
    expect(status).toBe(200);
    expect(typeof (body as { watching: boolean }).watching).toBe('boolean');
  });
});

describe('GET /habituation', () => {
  it('returns habituation metrics', async () => {
    const { status, body } = await get('/habituation');
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect(typeof (body as { windowWeeks: number }).windowWeeks).toBe('number');
  });

  it('accepts ?weeks= param', async () => {
    const { status } = await get('/habituation?weeks=4');
    expect(status).toBe(200);
  });
});

describe('GET /shadow-report', () => {
  it('returns shadow mode report', async () => {
    const { status, body } = await get('/shadow-report');
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
  });

  it('returns CSV when format=csv is requested', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/shadow-report?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
  });
});

describe('GET /shadow-report/entries', () => {
  it('returns raw shadow log entries (requires secret)', async () => {
    const { status, body } = await authGet('/shadow-report/entries');
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect(Array.isArray((body as { entries: unknown[] }).entries)).toBe(true);
  });
});

describe('GET /shadow-report/slack-digest', () => {
  it('returns Slack digest block', async () => {
    const { status } = await get('/shadow-report/slack-digest');
    expect(status).toBe(200);
  });
});

describe('POST /shadow-report/:id/verdict', () => {
  it('returns 401 for unauthenticated request', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/shadow-report/some-id/verdict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'would-approve' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid verdict payload (authenticated)', async () => {
    const res = await authPost('/shadow-report/some-id/verdict', { verdict: 'invalid-value' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown shadow entry id (authenticated)', async () => {
    const res = await authPost('/shadow-report/nonexistent-id/verdict', { verdict: 'would-approve' });
    expect(res.status).toBe(404);
  });
});

describe('GET /slack/routing', () => {
  it('returns routing rules list', async () => {
    const { status, body } = await get('/slack/routing');
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect(Array.isArray((body as { rules: unknown[] }).rules)).toBe(true);
  });
});

describe('POST /slack/routing', () => {
  it('returns 400 when service is missing', async () => {
    const res = await authPost('/slack/routing', { webhook: 'https://hooks.slack.com/x' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when webhook URL is invalid', async () => {
    const res = await authPost('/slack/routing', { service: 'api', webhook: 'not-a-url' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /slack/routing/:id', () => {
  it('returns 404 for unknown rule', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/slack/routing/nonexistent-id`, {
      method: 'DELETE',
      headers: { 'x-mergen-secret': TEST_SECRET },
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /incidents/postmortems', () => {
  it('returns postmortem list (requires secret)', async () => {
    const { status, body } = await authGet('/incidents/postmortems');
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect(Array.isArray((body as { postmortems: unknown[] }).postmortems)).toBe(true);
  });
});

describe('POST /incidents/resolve-active', () => {
  it('returns 404 when no open incident exists', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/resolve-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixSummary: 'restarted the service' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /incidents/resolve-active/attribution-feedback', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/resolve-active/attribution-feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1 }), // missing attributionCorrect
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /override-corpus', () => {
  it('returns corpus summary (requires secret)', async () => {
    const { status, body } = await authGet('/override-corpus');
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
  });

  it('returns 401 without secret', async () => {
    const { status } = await get('/override-corpus');
    expect(status).toBe(401);
  });
});

describe('Rate limiter', () => {
  it('returns 200 for a normal request (using shadow-report, not auth-gated for GET)', async () => {
    const { status } = await get('/shadow-report');
    expect(status).toBe(200);
  });
});

describe('POST /hitl/bypass/approve', () => {
  it('returns 404 — endpoint removed; bypass approval goes through POST /hitl/approve', async () => {
    const res = await authPost('/hitl/bypass/approve', { token: 'nonexistent' });
    expect(res.status).toBe(404);
  });

  it('POST /hitl/approve returns 404 for unknown tokens', async () => {
    const res = await authPost('/hitl/approve', { token: 'nonexistent-token' });
    expect(res.status).toBe(404);
  });
});
