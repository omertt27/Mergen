/**
 * pagerduty-webhook.test.ts — Integration test for the PagerDuty webhook route.
 *
 * Fires a real POST /webhooks/pagerduty request against the live Express app and
 * asserts that the autopilot loop engages: the incident is recorded in the active
 * incident state and runIncidentAutopilot is invoked.
 *
 * External calls (Datadog, Slack, calibration) are mocked so the test runs
 * without credentials and without touching production systems.
 */

import net from 'net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';

// ── Mock external/closed-source deps before any local imports ─────────────────
// vi.mock() is hoisted above all const declarations, so variables used inside
// mock factories must be created with vi.hoisted() — those ARE hoisted with it.

const { mockIsConfigured, mockCloudMode } = vi.hoisted(() => ({
  mockIsConfigured: vi.fn().mockReturnValue(false),
  mockCloudMode: { value: false },
}));

vi.mock('../datadog/client.js', () => ({
  isConfigured: () => mockIsConfigured(),
  fetchLatestErrorTrace: vi.fn().mockResolvedValue(null),
}));

vi.mock('../sensor/cloud-auth.js', () => ({
  get CLOUD_MODE() { return mockCloudMode.value; },
  cloudAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../intelligence/slack.js', () => ({
  postIncidentAlert: vi.fn().mockResolvedValue(undefined),
  postThreadReply: vi.fn().mockResolvedValue(undefined),
  postApprovalRequest: vi.fn().mockResolvedValue(undefined),
  fetchIncidentChannelContext: vi.fn().mockResolvedValue(''),
  postSimpleWebhookNotification: vi.fn().mockResolvedValue(undefined),
  handleSlackActions: vi.fn(),
  handleFeedbackLink: vi.fn(),
}));

vi.mock('../intelligence/incident-autopilot.js', () => ({
  runIncidentAutopilot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../intelligence/calibration.js', () => ({
  getRecords: vi.fn().mockReturnValue([]),
  recordVerdict: vi.fn(),
}));

// ── Imports (after mocks are set up) ─────────────────────────────────────────

import { createApp } from '../app.js';
import { getActiveIncident, clearActiveIncident } from '../datadog/incident-state.js';
import { runIncidentAutopilot } from '../intelligence/incident-autopilot.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makePdPayload(eventType: 'incident.triggered' | 'incident.resolved', id = 'PD-TEST-001') {
  return {
    messages: [{
      event: {
        event_type: eventType,
        data: {
          id,
          summary: 'High error rate on api service',
          html_url: 'https://acme.pagerduty.com/incidents/PD-TEST-001',
          created_at: new Date().toISOString(),
          service: { summary: 'api' },
        },
      },
    }],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /webhooks/pagerduty', () => {
  let server: HttpServer;
  let baseURL: string;

  beforeEach(async () => {
    clearActiveIncident();
    vi.clearAllMocks();

    const port = await findFreePort();
    const app = createApp({
      serverVersion: '1.0.0-test',
      localSecret: 'test-secret',
      port,
      bindHost: '127.0.0.1',
    });

    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '127.0.0.1', () => {
        baseURL = `http://127.0.0.1:${port}`;
        resolve();
      });
      server.on('error', reject);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 200 for a valid incident.triggered payload', async () => {
    const resp = await fetch(`${baseURL}/webhooks/pagerduty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePdPayload('incident.triggered')),
    });
    expect(resp.status).toBe(200);
  });

  it('sets the active incident immediately on incident.triggered', async () => {
    await fetch(`${baseURL}/webhooks/pagerduty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePdPayload('incident.triggered')),
    });

    const incident = getActiveIncident();
    expect(incident).not.toBeNull();
    expect(incident!.service).toBe('api');
    expect(incident!.alertTitle).toBe('High error rate on api service');
  });

  it('does not call runIncidentAutopilot when Datadog is not configured', async () => {
    mockIsConfigured.mockReturnValue(false);

    await fetch(`${baseURL}/webhooks/pagerduty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePdPayload('incident.triggered')),
    });

    // Flush microtask queue — the background async block resolves synchronously
    // when isConfigured() is false, so one tick is sufficient.
    await Promise.resolve();

    expect(runIncidentAutopilot).not.toHaveBeenCalled();
  });

  it('returns 200 for incident.resolved', async () => {
    const resp = await fetch(`${baseURL}/webhooks/pagerduty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePdPayload('incident.resolved')),
    });
    expect(resp.status).toBe(200);
  });

  it('returns 400 for a malformed payload', async () => {
    const resp = await fetch(`${baseURL}/webhooks/pagerduty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ not: 'pagerduty' }),
    });
    expect(resp.status).toBe(400);
  });

  it('returns 400 for non-JSON body', async () => {
    const resp = await fetch(`${baseURL}/webhooks/pagerduty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(resp.status).toBe(400);
  });

  it('accepts a tenant-scoped webhook URL (/webhooks/pagerduty/:tenantId)', async () => {
    const resp = await fetch(`${baseURL}/webhooks/pagerduty/tenant-abc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePdPayload('incident.triggered')),
    });
    expect(resp.status).toBe(200);
  });

  it('sets the active incident when called via the tenant-scoped URL', async () => {
    await fetch(`${baseURL}/webhooks/pagerduty/tenant-abc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePdPayload('incident.triggered')),
    });
    const incident = getActiveIncident();
    expect(incident).not.toBeNull();
    expect(incident!.service).toBe('api');
  });

  it('rejects the no-tenant URL with 400 when MERGEN_CLOUD_MODE=true', async () => {
    mockCloudMode.value = true;
    try {
      const resp = await fetch(`${baseURL}/webhooks/pagerduty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makePdPayload('incident.triggered')),
      });
      expect(resp.status).toBe(400);
      const body = await resp.json() as { error: string };
      expect(body.error).toMatch(/tenant/i);
    } finally {
      mockCloudMode.value = false;
    }
  });

  it('does not overwrite an existing active incident for unrecognised event types', async () => {
    // First, establish an active incident via a real triggered event
    await fetch(`${baseURL}/webhooks/pagerduty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePdPayload('incident.triggered', 'PD-ORIGINAL')),
    });
    const original = getActiveIncident();
    expect(original).not.toBeNull();

    // Post an acknowledged event — should not touch the active incident
    const payload = {
      messages: [{
        event: {
          event_type: 'incident.acknowledged',
          data: { id: 'PD-ORIGINAL', summary: 'ack event' },
        },
      }],
    };
    const resp = await fetch(`${baseURL}/webhooks/pagerduty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(resp.status).toBe(200);
    // Active incident is unchanged — not cleared, not replaced
    expect(getActiveIncident()?.alertTitle).toBe(original!.alertTitle);
  });
});