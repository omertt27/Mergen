import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';

// ── Redirect OVERRIDE_CORPUS_FILE to a temp path using globalThis to support hoisting ──
vi.mock('../sensor/paths.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../sensor/paths.js')>();
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  
  if (!(globalThis as any).__overrideCorpusTemp) {
    const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mergen-postmortem-test-'));
    (globalThis as any).__overrideCorpusTemp = pathMod.join(tmp, 'override-corpus.json');
    (globalThis as any).__overrideCorpusTempDir = tmp;
  }
  
  return {
    ...orig,
    OVERRIDE_CORPUS_FILE: (globalThis as any).__overrideCorpusTemp,
  };
});

const OVERRIDE_CORPUS_TEMP = (globalThis as any).__overrideCorpusTemp;
const tmpDir = (globalThis as any).__overrideCorpusTempDir;

// ── Mock Slack and other autopilot deps ───────────────────────────────────────
const mockFetchSlackThread = vi.fn();

vi.mock('../intelligence/slack.js', () => ({
  postIncidentAlert: vi.fn(),
  postThreadReply: vi.fn(),
  handleSlackActions: vi.fn(),
  handleFeedbackLink: vi.fn(),
  postApprovalRequest: vi.fn(),
  fetchIncidentChannelContext: vi.fn(),
  postSimpleWebhookNotification: vi.fn(),
  fetchSlackThread: (...args: any[]) => mockFetchSlackThread(...args),
}));

vi.mock('../intelligence/tools-runbook.js', () => ({
  draftPostmortemDoc: vi.fn().mockResolvedValue('# Mock Postmortem Document\n- Details here'),
}));

vi.mock('../intelligence/incident-autopilot.js', () => ({ runIncidentAutopilot: vi.fn() }));
vi.mock('../datadog/client.js', () => ({ isConfigured: vi.fn().mockReturnValue(false), fetchLatestErrorTrace: vi.fn() }));
vi.mock('../intelligence/calibration.js', () => ({ getRecords: vi.fn().mockReturnValue([]), recordVerdict: vi.fn() }));

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
  generatePostmortem: vi.fn(),
}));
vi.mock('../sensor/commit-context-store.js', () => ({
  commitContextStore: {
    listByWindow: vi.fn().mockReturnValue([]), listByRepo: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0), getBySha: vi.fn().mockReturnValue(null),
    init: vi.fn().mockResolvedValue(undefined),
  },
  extractLinkedIssues: vi.fn().mockReturnValue([]),
}));

// Now import app and createApp
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

const TEST_SECRET = 'test-secret-postmortem';
let server: HttpServer;
let port: number;

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(OVERRIDE_CORPUS_TEMP)) {
    fs.unlinkSync(OVERRIDE_CORPUS_TEMP);
  }
  const lockFile = `${OVERRIDE_CORPUS_TEMP}.lock`;
  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
  }

  port = await findFreePort();
  const app = createApp({ serverVersion: '0.0.0-test', localSecret: TEST_SECRET, port, bindHost: '127.0.0.1' });
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterEach(() => {
  server.close();
  try {
    if (fs.existsSync(OVERRIDE_CORPUS_TEMP)) {
      fs.unlinkSync(OVERRIDE_CORPUS_TEMP);
    }
    const lockFile = `${OVERRIDE_CORPUS_TEMP}.lock`;
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
    }
    fs.rmdirSync(tmpDir);
  } catch (err) {
    // ignore cleanup errors
  }
});

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-mergen-secret': TEST_SECRET };
}

describe('POST /postmortem/from-slack with Override Extraction', () => {
  it('extracts override and writes to override corpus file if resolution thread matches pattern', async () => {
    // Simulate a Slack thread with a proposed command, a manual action, and a batch window keyword.
    const mockSlackThreadContent = `
      Hey team, we should not run \`kubectl rollout restart deployment/api\` right now because of the settlement batch window.
      I will run \`kubectl stop deployment/api\` instead.
    `;
    mockFetchSlackThread.mockResolvedValue(mockSlackThreadContent);

    const payload = {
      thread_url: 'https://myworkspace.slack.com/archives/C12345/p1678901234567',
      service: 'api',
    };

    const res = await fetch(`http://127.0.0.1:${port}/postmortem/from-slack`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { markdown: string; overrideCompiled: boolean; overrideId?: string };
    expect(body.overrideCompiled).toBe(true);
    expect(body.overrideId).toBeDefined();

    // Verify it wrote to the temp corpus file
    expect(fs.existsSync(OVERRIDE_CORPUS_TEMP)).toBe(true);
    const fileContent = JSON.parse(fs.readFileSync(OVERRIDE_CORPUS_TEMP, 'utf8'));
    expect(fileContent.version).toBe(1);
    expect(fileContent.events).toHaveLength(1);
    const recordedEvent = fileContent.events[0];
    expect(recordedEvent.id).toBe(body.overrideId);
    expect(recordedEvent.proposedCommand).toBe('kubectl rollout restart deployment/api');
    expect(recordedEvent.manualAction).toBe('kubectl stop deployment/api');
    expect(recordedEvent.overrideReason).toBe('batch-window');
  });

  it('returns overrideCompiled false if the Slack thread does not match any override pattern', async () => {
    // Thread with no command or override indicators
    const mockSlackThreadContent = `
      Incident is resolved now. Thank you everyone.
    `;
    mockFetchSlackThread.mockResolvedValue(mockSlackThreadContent);

    const payload = {
      thread_url: 'https://myworkspace.slack.com/archives/C12345/p1678901234567',
      service: 'api',
    };

    const res = await fetch(`http://127.0.0.1:${port}/postmortem/from-slack`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { markdown: string; overrideCompiled: boolean; overrideId?: string };
    expect(body.overrideCompiled).toBe(false);
    expect(body.overrideId).toBeUndefined();

    // File should not contain any events (or might not exist yet)
    if (fs.existsSync(OVERRIDE_CORPUS_TEMP)) {
      const fileContent = JSON.parse(fs.readFileSync(OVERRIDE_CORPUS_TEMP, 'utf8'));
      expect(fileContent.events).toHaveLength(0);
    }
  });
});
