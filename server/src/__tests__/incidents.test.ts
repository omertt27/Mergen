/**
 * incidents.test.ts — Integration tests for the incidents router.
 *
 * Covers: list, get, create, acknowledge, assign, resolve, note, impact-report,
 * graph, interactions, commit-contexts, postmortems, replay-snapshots, replay.
 */

import net from 'net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';

// ── Mock store dependencies ───────────────────────────────────────────────────
// vi.mock() is hoisted to the top of the file before variable declarations,
// so any values used inside factories must be created with vi.hoisted().

const { mockIncidentStore } = vi.hoisted(() => {
  const mockIncident = {
    pid: 'test-pid',
    status: 'open' as const,
    hypothesis: 'db connection pool exhausted',
    tag: 'db_timeout',
    sha: null,
    environment: null,
    confidence: 0.9,
    createdAt: Date.now(),
    resolvedAt: null,
    resolvedAutonomously: false,
    causallyCorrect: false,
    contextBriefViewedAt: null,
    notes: [] as unknown[],
    service: 'api',
  };
  return {
    mockIncidentStore: {
      list: vi.fn().mockReturnValue([mockIncident]),
      get: vi.fn().mockReturnValue(mockIncident),
      upsert: vi.fn().mockImplementation((_pid: string, data: object) => ({ ...mockIncident, ...data })),
      addNote: vi.fn().mockReturnValue({ ...mockIncident, notes: [{ text: 'test note', author: 'alice', createdAt: Date.now() }] }),
      markContextViewed: vi.fn(),
      getInteractionGraph: vi.fn().mockReturnValue([]),
      init: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const mockIncident = {
  pid: 'test-pid',
  status: 'open' as const,
  hypothesis: 'db connection pool exhausted',
  tag: 'db_timeout',
  sha: null,
  environment: null,
  confidence: 0.9,
  createdAt: Date.now(),
  resolvedAt: null,
  resolvedAutonomously: false,
  causallyCorrect: false,
  contextBriefViewedAt: null,
  notes: [],
  service: 'api',
};

vi.mock('../sensor/incident-store.js', () => ({ incidentStore: mockIncidentStore }));

vi.mock('../datadog/memory-store.js', () => ({
  memoryStore: {
    listOpen: vi.fn().mockReturnValue([]),
    closeIncident: vi.fn(),
    recordAttributionFeedback: vi.fn(),
  },
  inferResolutionType: vi.fn().mockReturnValue('unknown'),
}));

vi.mock('../datadog/incident-state.js', () => ({
  getActiveIncident: vi.fn().mockReturnValue(null),
  clearActiveIncident: vi.fn(),
  setActiveIncident: vi.fn(),
}));

vi.mock('../intelligence/incident-replay.js', () => ({
  replayIncident: vi.fn().mockResolvedValue(null),
  listSnapshotPids: vi.fn().mockReturnValue(['pid-1', 'pid-2']),
}));

vi.mock('../intelligence/postmortem-store.js', () => ({
  postmortemStore: {
    list: vi.fn().mockReturnValue([]),
    getByTag: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0),
    tagStats: vi.fn().mockReturnValue({}),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../sensor/commit-context-store.js', () => ({
  commitContextStore: {
    listByWindow: vi.fn().mockReturnValue([]),
    listByRepo: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0),
    getBySha: vi.fn().mockReturnValue(null),
    init: vi.fn().mockResolvedValue(undefined),
  },
  extractLinkedIssues: vi.fn().mockReturnValue([]),
}));

// Slack/autopilot are not exercised by incidents routes but createApp imports them
vi.mock('../intelligence/slack.js', () => ({
  postIncidentAlert: vi.fn(),
  postThreadReply: vi.fn(),
  handleSlackActions: vi.fn(),
  handleFeedbackLink: vi.fn(),
  postApprovalRequest: vi.fn(),
  fetchIncidentChannelContext: vi.fn(),
}));
vi.mock('../intelligence/incident-autopilot.js', () => ({ runIncidentAutopilot: vi.fn() }));
vi.mock('../datadog/client.js', () => ({ isConfigured: vi.fn().mockReturnValue(false), fetchLatestErrorTrace: vi.fn() }));
vi.mock('../intelligence/calibration.js', () => ({ getRecords: vi.fn().mockReturnValue([]), recordVerdict: vi.fn() }));

// ── Test helpers ──────────────────────────────────────────────────────────────

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
  mockIncidentStore.list.mockReturnValue([mockIncident]);
  mockIncidentStore.get.mockReturnValue(mockIncident);
  mockIncidentStore.upsert.mockImplementation((_pid: string, data: object) => ({ ...mockIncident, ...data }));
  mockIncidentStore.addNote.mockReturnValue({ ...mockIncident, notes: [{ text: 'note', author: 'alice', createdAt: Date.now() }] });

  port = await findFreePort();
  const app = createApp({ serverVersion: '0.0.0-test', localSecret: '', port, bindHost: '127.0.0.1' });
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterEach(() => {
  server.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /incidents', () => {
  it('returns incident list', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; incidents: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.incidents)).toBe(true);
    expect(mockIncidentStore.list).toHaveBeenCalled();
  });

  it('passes status filter to store', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents?status=open`);
    expect(res.status).toBe(200);
    expect(mockIncidentStore.list).toHaveBeenCalledWith('open', expect.any(Number));
  });
});

describe('GET /incidents/:pid', () => {
  it('returns incident by pid', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/test-pid`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; incident: { pid: string } };
    expect(body.ok).toBe(true);
    expect(body.incident.pid).toBe('test-pid');
  });

  it('returns 404 when not found', async () => {
    mockIncidentStore.get.mockReturnValue(null);
    const res = await fetch(`http://127.0.0.1:${port}/incidents/unknown`);
    expect(res.status).toBe(404);
  });
});

describe('POST /incidents', () => {
  it('creates an incident', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: 'new-pid', hypothesis: 'db timeout', tag: 'db_timeout', confidence: 0.9 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockIncidentStore.upsert).toHaveBeenCalledWith('new-pid', expect.objectContaining({ hypothesis: 'db timeout' }));
  });

  it('returns 400 when pid is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hypothesis: 'test' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /incidents/:pid/acknowledge', () => {
  it('acknowledges an incident', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/test-pid/acknowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'alice' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockIncidentStore.upsert).toHaveBeenCalledWith('test-pid', expect.objectContaining({ status: 'acknowledged' }));
  });

  it('auto-creates incident if not found', async () => {
    mockIncidentStore.get.mockReturnValue(null);
    const res = await fetch(`http://127.0.0.1:${port}/incidents/new-pid/acknowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'bob', hypothesis: 'timeout', tag: 'db' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /incidents/:pid/assign', () => {
  it('assigns an incident', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/test-pid/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'carol' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockIncidentStore.upsert).toHaveBeenCalledWith('test-pid', expect.objectContaining({ assignee: 'carol' }));
  });

  it('returns 400 when to is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/test-pid/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /incidents/:pid/resolve', () => {
  it('resolves an incident', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/test-pid/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'alice', note: 'restarted the db connection pool' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockIncidentStore.upsert).toHaveBeenCalledWith('test-pid', expect.objectContaining({ status: 'resolved' }));
  });
});

describe('POST /incidents/:pid/note', () => {
  it('adds a note to an incident', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/test-pid/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'checked the logs', author: 'alice' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockIncidentStore.addNote).toHaveBeenCalledWith('test-pid', 'checked the logs', 'alice');
  });

  it('returns 400 when text is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/test-pid/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'alice' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when incident does not exist', async () => {
    mockIncidentStore.addNote.mockReturnValue(null);
    const res = await fetch(`http://127.0.0.1:${port}/incidents/unknown/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /incidents/impact-report', () => {
  it('returns impact metrics', async () => {
    const resolved = { ...mockIncident, status: 'resolved' as const, resolvedAt: Date.now() + 1000, createdAt: Date.now() };
    mockIncidentStore.list.mockReturnValue([resolved]);
    const res = await fetch(`http://127.0.0.1:${port}/incidents/impact-report`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; totalResolved: number };
    expect(body.ok).toBe(true);
    expect(typeof body.totalResolved).toBe('number');
  });
});

describe('GET /incidents/graph', () => {
  it('returns service failure mode graph', async () => {
    mockIncidentStore.list.mockReturnValue([{ ...mockIncident, service: 'api', tag: 'db_timeout' }]);
    const res = await fetch(`http://127.0.0.1:${port}/incidents/graph`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; graph: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.graph)).toBe(true);
  });
});

describe('GET /services/interactions', () => {
  it('returns interaction edges', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/services/interactions`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; edges: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });
});

describe('GET /incidents/replay-snapshots', () => {
  it('returns snapshot pids', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/replay-snapshots`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; pids: string[] };
    expect(body.ok).toBe(true);
    expect(body.pids).toEqual(['pid-1', 'pid-2']);
  });
});

describe('POST /incidents/:pid/replay', () => {
  it('returns 404 when no snapshot exists', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/incidents/test-pid/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /commit-contexts', () => {
  it('returns commit context list', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/commit-contexts`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe('GET /commit-contexts/:sha', () => {
  it('returns 404 for unknown sha', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/commit-contexts/abc1234`);
    expect(res.status).toBe(404);
  });
});
