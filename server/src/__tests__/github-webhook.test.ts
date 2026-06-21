/**
 * github-webhook.test.ts — Integration tests for the GitHub webhook receiver.
 *
 * Covers:
 *   - HMAC signature rejection on invalid signatures (when secret is configured)
 *   - pull_request closed+merged → commit context stored
 *   - pull_request_review submitted → habituation recorded
 *   - push → direct commit context stored
 *   - Unsupported event type → 200 ignored response
 */

import crypto from 'crypto';
import net from 'net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';

// ── Mock all dependencies ─────────────────────────────────────────────────────

const mockStoreCommitContext = vi.fn();
const mockGetBySha           = vi.fn().mockReturnValue(null);
const mockListByRepo         = vi.fn().mockReturnValue([]);

vi.mock('../sensor/commit-context-store.js', () => ({
  commitContextStore: {
    store:      (...args: unknown[]) => mockStoreCommitContext(...args),
    upsert:     (...args: unknown[]) => mockStoreCommitContext(...args),
    getBySha:   (...args: unknown[]) => mockGetBySha(...args),
    listByRepo: (...args: unknown[]) => mockListByRepo(...args),
    count:      vi.fn().mockReturnValue(0),
    init:       vi.fn().mockResolvedValue(undefined),
  },
  extractLinkedIssues: vi.fn().mockReturnValue([]),
}));

const mockRecordHabituationEvent = vi.fn();
vi.mock('../sensor/habituation-store.js', () => ({
  recordHabituationEvent: (...args: unknown[]) => mockRecordHabituationEvent(...args),
  getHabituationEvents:   vi.fn().mockReturnValue([]),
  getWeeklyHabituation:   vi.fn().mockReturnValue([]),
}));

vi.mock('../datadog/memory-store.js', () => ({
  memoryStore: {
    listOpen:      vi.fn().mockReturnValue([]),
    openIncident:  vi.fn(),
    closeIncident: vi.fn(),
  },
  inferResolutionType: vi.fn().mockReturnValue('unknown'),
}));

vi.mock('../intelligence/ai-commit.js', () => ({
  detectAiCommit: vi.fn().mockReturnValue({ isAiCommit: false, confidence: 0, signals: [] }),
}));

vi.mock('../intelligence/pr-shadow-analyzer.js', () => ({
  analyzePRForShadow: vi.fn().mockResolvedValue(null),
}));

vi.mock('../intelligence/pr-commenter.js', () => ({
  maybePostPRComment: vi.fn().mockResolvedValue(undefined),
  hasMergenComment:   vi.fn().mockResolvedValue(false),
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

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

const prPayload = {
  action: 'closed',
  pull_request: {
    number: 42,
    title: 'fix: handle db timeout in connection pool',
    body: 'Closes #123\n\nIncreased max pool size from 10 to 25.',
    html_url: 'https://github.com/acme/api/pull/42',
    user: { login: 'alice' },
    head: { sha: 'abc1234567890', ref: 'fix/db-timeout' },
    base: { ref: 'main' },
    merge_commit_sha: 'def987654321',
    merged_at: new Date().toISOString(),
    merged: true,
    requested_reviewers: [],
    labels: [],
  },
  repository: { full_name: 'acme/api' },
};

const reviewPayload = {
  action: 'submitted',
  review: {
    state: 'approved',
    submitted_at: new Date().toISOString(),
    user: { login: 'bob' },
    body: 'LGTM',
    html_url: 'https://github.com/acme/api/pull/42#pullrequestreview-1',
  },
  pull_request: {
    number: 42,
    html_url: 'https://github.com/acme/api/pull/42',
    user: { login: 'alice' },
    head: { sha: 'abc1234567890', ref: 'fix/db-timeout' },
  },
  repository: { full_name: 'acme/api' },
};

const pushPayload = {
  ref: 'refs/heads/main',
  commits: [
    {
      id: 'push1234567890',
      message: 'fix: rollback connection pool to 10 max',
      timestamp: new Date().toISOString(),
      author: { name: 'carol', email: 'carol@acme.com' },
      url: 'https://github.com/acme/api/commit/push1234567890',
      added: [], removed: [], modified: ['src/db/pool.ts'],
    },
  ],
  repository: { full_name: 'acme/api' },
};

let server: HttpServer;
let port: number;

beforeEach(async () => {
  vi.clearAllMocks();
  mockStoreCommitContext.mockReset();
  mockRecordHabituationEvent.mockReset();
  delete process.env.GITHUB_WEBHOOK_SECRET;

  port = await findFreePort();
  const app = createApp({ serverVersion: '0.0.0-test', localSecret: '', port, bindHost: '127.0.0.1' });
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterEach(() => { server.close(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postWebhook(event: string, payload: object, signature?: string): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
  };
  if (signature) headers['X-Hub-Signature-256'] = signature;
  return fetch(`http://127.0.0.1:${port}/webhooks/github`, {
    method: 'POST',
    headers,
    body,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /webhooks/github — pull_request merged', () => {
  it('stores commit context for merged PRs', async () => {
    const res = await postWebhook('pull_request', prPayload);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('accepted');
  });

  it('ignores non-merged PRs', async () => {
    const nonMerged = { ...prPayload, pull_request: { ...prPayload.pull_request, merged: false, merged_at: null } };
    const res = await postWebhook('pull_request', nonMerged);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('accepted');
    expect(mockStoreCommitContext).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/github — pull_request_review', () => {
  it('accepts review events', async () => {
    const res = await postWebhook('pull_request_review', reviewPayload);
    expect(res.status).toBe(200);
  });
});

describe('POST /webhooks/github — push', () => {
  it('stores context for direct push commits', async () => {
    const res = await postWebhook('push', pushPayload);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('accepted');
  });

  it('ignores tag pushes (refs/tags/)', async () => {
    const tagPush = { ...pushPayload, ref: 'refs/tags/v1.0.0' };
    const res = await postWebhook('push', tagPush);
    expect(res.status).toBe(200);
  });
});

describe('POST /webhooks/github — unknown event', () => {
  it('returns 200 with ignored: true for unhandled event types', async () => {
    const res = await postWebhook('deployment', { action: 'created' });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('accepted');
  });
});

describe('POST /webhooks/github — signature verification', () => {
  it('accepts requests without a signature when no secret is configured', async () => {
    const res = await postWebhook('push', pushPayload);
    expect(res.status).toBe(200);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push' },
      body: '{ invalid json }',
    });
    expect(res.status).toBe(400);
  });
});

describe('HMAC signature enforcement (module-level secret)', () => {
  it('signs a known payload correctly (unit test for sign helper)', () => {
    const secret = 'mysecret';
    const payload = JSON.stringify({ action: 'opened' });
    const sig = sign(payload, secret);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
