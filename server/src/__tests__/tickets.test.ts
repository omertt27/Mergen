/**
 * tickets.test.ts — Integration tests for the Linear and Jira ticket creation routes.
 *
 * Covers: POST /tickets/linear, POST /tickets/jira
 *
 * External HTTP calls (Linear API, Jira API) are intercepted at the node:https
 * module level so no credentials are needed and tests run offline.
 */

import net from 'net';
import https from 'https';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';
import type { ClientRequest } from 'http';

// ── Mock external deps ────────────────────────────────────────────────────────

// hypothesis-history and repro-steps are closed-source; the shared stub in
// src/__stubs__/closed-source.ts already provides noops for both — no mock needed.

vi.mock('../sensor/git-suspect.js', () => ({
  findCodeOwners: vi.fn().mockReturnValue(null),
  findGitBlame:   vi.fn().mockReturnValue(null),
  findGitLog:     vi.fn().mockReturnValue([]),
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

/** Build a fake https.request that returns a canned JSON response. */
function mockHttpsRequest(responseBody: object): void {
  vi.spyOn(https, 'request').mockImplementation((_opts, callback) => {
    const mockRes = {
      on: (event: string, handler: (data?: Buffer) => void) => {
        if (event === 'data')  handler(Buffer.from(JSON.stringify(responseBody)));
        if (event === 'end')   handler();
        return mockRes;
      },
    };
    if (callback) (callback as (res: unknown) => void)(mockRes);
    return {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    } as unknown as ClientRequest;
  });
}

let server: HttpServer;
let port: number;

beforeEach(async () => {
  vi.clearAllMocks();
  port = await findFreePort();
  const app = createApp({ serverVersion: '0.0.0-test', localSecret: '', port, bindHost: '127.0.0.1' });
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterEach(() => {
  server.close();
  vi.restoreAllMocks();
  delete process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_TEAM_ID;
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
  delete process.env.JIRA_PROJECT_KEY;
});

// ── Linear tests ──────────────────────────────────────────────────────────────

describe('POST /tickets/linear', () => {
  it('returns 400 when LINEAR_API_KEY is not set', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/tickets/linear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: 'TEAM123' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/LINEAR_API_KEY/);
  });

  it('returns 400 when LINEAR_TEAM_ID is not set', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_test_key';
    const res = await fetch(`http://127.0.0.1:${port}/tickets/linear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/LINEAR_TEAM_ID/);
  });

  it('creates a Linear issue when configured', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_test_key';
    process.env.LINEAR_TEAM_ID = 'TEAM-123';
    mockHttpsRequest({
      data: {
        issueCreate: {
          success: true,
          issue: { id: 'abc', identifier: 'ENG-42', url: 'https://linear.app/team/issue/ENG-42' },
        },
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/tickets/linear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; url: string; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe('ENG-42');
  });

  it('accepts team_id from request body over env var', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_test_key';
    process.env.LINEAR_TEAM_ID = 'ENV-TEAM';
    mockHttpsRequest({
      data: {
        issueCreate: {
          success: true,
          issue: { id: 'xyz', identifier: 'ENG-99', url: 'https://linear.app/team/issue/ENG-99' },
        },
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/tickets/linear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: 'BODY-TEAM' }),
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 on Linear API errors in response', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_test_key';
    process.env.LINEAR_TEAM_ID = 'TEAM-123';
    mockHttpsRequest({ errors: [{ message: 'Invalid team' }] });

    const res = await fetch(`http://127.0.0.1:${port}/tickets/linear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Linear API error/);
  });
});

// ── Jira tests ────────────────────────────────────────────────────────────────

describe('POST /tickets/jira', () => {
  it('returns 400 when JIRA_BASE_URL is not set', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/tickets/jira`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/JIRA_BASE_URL/);
  });

  it('returns 400 when JIRA_EMAIL is not set', async () => {
    process.env.JIRA_BASE_URL = 'https://myco.atlassian.net';
    const res = await fetch(`http://127.0.0.1:${port}/tickets/jira`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/JIRA_EMAIL/);
  });

  it('returns 400 when JIRA_API_TOKEN is not set', async () => {
    process.env.JIRA_BASE_URL = 'https://myco.atlassian.net';
    process.env.JIRA_EMAIL    = 'user@co.com';
    const res = await fetch(`http://127.0.0.1:${port}/tickets/jira`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/JIRA_API_TOKEN/);
  });

  it('returns 400 when JIRA_PROJECT_KEY is not set', async () => {
    process.env.JIRA_BASE_URL  = 'https://myco.atlassian.net';
    process.env.JIRA_EMAIL     = 'user@co.com';
    process.env.JIRA_API_TOKEN = 'token123';
    const res = await fetch(`http://127.0.0.1:${port}/tickets/jira`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/JIRA_PROJECT_KEY/);
  });

  it('creates a Jira issue when fully configured', async () => {
    process.env.JIRA_BASE_URL   = 'https://myco.atlassian.net';
    process.env.JIRA_EMAIL      = 'user@co.com';
    process.env.JIRA_API_TOKEN  = 'token123';
    process.env.JIRA_PROJECT_KEY = 'ENG';
    mockHttpsRequest({ key: 'ENG-123', self: 'https://myco.atlassian.net/rest/api/3/issue/ENG-123' });

    const res = await fetch(`http://127.0.0.1:${port}/tickets/jira`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; key: string };
    expect(body.ok).toBe(true);
    expect(body.key).toBe('ENG-123');
  });

  it('accepts project_key from request body', async () => {
    process.env.JIRA_BASE_URL   = 'https://myco.atlassian.net';
    process.env.JIRA_EMAIL      = 'user@co.com';
    process.env.JIRA_API_TOKEN  = 'token123';
    mockHttpsRequest({ key: 'BUG-7', self: 'https://myco.atlassian.net/rest/api/3/issue/BUG-7' });

    const res = await fetch(`http://127.0.0.1:${port}/tickets/jira`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_key: 'BUG' }),
    });
    expect(res.status).toBe(200);
  });
});
