import net from 'net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';
import { createApp } from '../app.js';
import { evaluateEnterprisePolicy } from '../intelligence/enterprise-policy-engine.js';

// Mocks required by routes and startup
vi.mock('../intelligence/slack.js', () => ({
  postIncidentAlert: vi.fn(), postThreadReply: vi.fn(),
  handleSlackActions: vi.fn(), handleFeedbackLink: vi.fn(),
  postApprovalRequest: vi.fn(), fetchIncidentChannelContext: vi.fn(),
  postSimpleWebhookNotification: vi.fn(),
}));
vi.mock('../intelligence/incident-autopilot.js', () => ({ runIncidentAutopilot: vi.fn() }));
vi.mock('../datadog/client.js', () => ({ isConfigured: vi.fn().mockReturnValue(false), fetchLatestErrorTrace: vi.fn() }));
vi.mock('../intelligence/calibration.js', () => ({ getRecords: vi.fn().mockReturnValue([]), recordVerdict: vi.fn() }));

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

describe('New Features - Phase 4 & Enterprise Integration', () => {
  let server: HttpServer;
  let baseURL: string;
  const secret = 'test-secret';

  beforeEach(async () => {
    const port = await findFreePort();
    const app = createApp({ serverVersion: '1.4.0', localSecret: secret, port, bindHost: '127.0.0.1' });
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

  describe('Enterprise Policy Engine', () => {
    it('should block AI auth changes during Friday batch window', () => {
      // Friday (5), 15:00 UTC, AI caller, touching auth file
      const friday15 = new Date('2026-06-26T15:00:00Z').getTime(); // Friday
      const result = evaluateEnterprisePolicy({
        files: ['src/auth_middleware.ts'],
        actor: 'claudecode-agent',
        service: 'api-service',
        timestamp: friday15,
      });

      expect(result.verdict).toBe('block');
      expect(result.triggeredRules).toContain('policy_auth_batch_window');
      expect(result.reasons[0]).toContain('Friday batch settlement window');
    });

    it('should pass if not on Friday', () => {
      // Thursday (4), 15:00 UTC, AI caller, touching auth file
      const thursday15 = new Date('2026-06-25T15:00:00Z').getTime(); // Thursday
      const result = evaluateEnterprisePolicy({
        files: ['src/auth_middleware.ts'],
        actor: 'claudecode-agent',
        service: 'api-service',
        timestamp: thursday15,
      });

      expect(result.verdict).toBe('pass');
    });

    it('should pass if caller is human', () => {
      // Friday (5), 15:00 UTC, Human caller, touching auth file
      const friday15 = new Date('2026-06-26T15:00:00Z').getTime();
      const result = evaluateEnterprisePolicy({
        files: ['src/auth_middleware.ts'],
        actor: 'alice-developer',
        service: 'api-service',
        timestamp: friday15,
      });

      expect(result.verdict).toBe('pass');
    });

    it('should warn when human touches database migration files', () => {
      const result = evaluateEnterprisePolicy({
        files: ['src/db/migrations/123_schema.sql'],
        actor: 'alice-developer',
        service: 'api-service',
      });

      expect(result.verdict).toBe('warn');
      expect(result.triggeredRules).toContain('policy_prod_database_warn');
    });
  });

  describe('POST /ci/gate with Enterprise Policies', () => {
    it('blocks PR when enterprise custom policy blocks it', async () => {
      // Simulated Friday 15:00 UTC
      const friday = new Date('2026-06-26T15:00:00Z').getTime();
      
      // Mock Date.now inside the test
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(friday);

      const resp = await fetch(`${baseURL}/ci/gate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mergen-secret': secret,
        },
        body: JSON.stringify({
          files: ['src/auth_middleware.ts'],
          prTitle: 'refactor auth routing',
          actor: 'claudecode-agent',
          service: 'api-service',
        }),
      });

      expect(resp.status).toBe(200);
      const data = await resp.json() as any;
      expect(data.verdict).toBe('block');
      expect(data.reasons.some((r: string) => r.includes('Friday batch settlement window'))).toBe(true);

      dateSpy.mockRestore();
    });
  });

  describe('Slack Events Webhook (POST /webhooks/slack/events)', () => {
    it('handles slack URL verification challenge', async () => {
      const resp = await fetch(`${baseURL}/webhooks/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mergen-secret': secret,
        },
        body: JSON.stringify({
          type: 'url_verification',
          challenge: 'verify-me-123',
        }),
      });

      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toBe('verify-me-123');
    });

    it('compiles override from postmortem message event', async () => {
      const text = 'incident postmortem: db connection leak resolved. proposed command: `systemctl restart postgresql` reason: `cost-constraint` tag: `infra_db_connection_pool`';
      
      const resp = await fetch(`${baseURL}/webhooks/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mergen-secret': secret,
        },
        body: JSON.stringify({
          type: 'event_callback',
          event: {
            type: 'message',
            text,
            service: 'db-service',
          },
        }),
      });

      expect(resp.status).toBe(200);
      const data = await resp.json() as any;
      expect(data.ok).toBe(true);
      expect(data.overrideCompiled).toBe(true);
      expect(data.overrideId).toBeDefined();
    });
  });

  describe('Git ADR Ingestion (POST /ci/adr)', () => {
    it('ingests ADR and automatically compiles override corpus entry', async () => {
      const resp = await fetch(`${baseURL}/ci/adr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mergen-secret': secret,
        },
        body: JSON.stringify({
          title: 'Limit auth token validation depth',
          decision: 'We will block JWT validation nested depth > 4 on OOM error prevention',
          rationale: 'Deep nesting in token verification triggers server oom',
          status: 'accepted',
        }),
      });

      expect(resp.status).toBe(201);
      const data = await resp.json() as any;
      expect(data.ok).toBe(true);
      expect(data.overrideCompiled).toBe(true);
      expect(data.overrideId).toBeDefined();
      expect(data.adr.id).toBeDefined();
    });
  });
});
