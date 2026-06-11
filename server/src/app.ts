/**
 * app.ts — Express application factory.
 *
 * Assembles middleware and all route modules into a single Express app.
 * Kept separate from index.ts so the app can be imported in tests without
 * binding a port, and from server.ts so port-discovery logic stays isolated.
 *
 * Call order matters:
 *   1. Raw-body webhook routers (billing, sentry, github, pagerduty) — HMAC needs raw bytes
 *   2. express.json()   — parses everything else
 *   3. helmet()         — security headers
 *   4. CORS headers
 *   5. Secret guard     — blocks unauthenticated mutating requests
 *   6. Route modules
 *   7. Error handler
 */
import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import { billingRouter } from './intelligence/billing.js';
import { teamRouter } from './intelligence/team.js';
import { ingestRouter } from './sensor/ingest.js';
import { createSensorRouter } from './routes/sensor.js';
import { createLicenseRouter } from './routes/license.js';
import { createCalibrationRouter } from './routes/calibration.js';
import { createTelemetryRouter } from './routes/telemetry.js';
import { createSetupRouter } from './routes/setup-ui.js';
import { layersRouter } from './routes/layers.js';
import { sentryRouter } from './routes/sentry.js';
import { otelRouter } from './routes/otel.js';
import { otlpReceiverRouter } from './routes/otlp-receiver.js';
import { createCIRouter } from './routes/ci.js';
import { createIncidentsRouter } from './routes/incidents.js';
import { createTicketsRouter } from './routes/tickets.js';
import { createValidateRouter } from './routes/validate.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createDemoRouter } from './routes/demo.js';
import { createSdkRouter } from './routes/sdk.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createPagerDutyRouter } from './routes/pagerduty.js';
import { createIncidentWebhookRouter } from './routes/incident-webhook.js';
import { createHeartbeatsRouter } from './routes/heartbeats.js';
import { createGitHubWebhookRouter } from './routes/github-webhook.js';
import { createWarRoomRouter } from './routes/war-room.js';
import { createSlackRoutingRouter } from './routes/slack-routing.js';
import { createApiKeysRouter } from './routes/api-keys.js';
import { createRbacRouter } from './routes/rbac.js';
import { createOverridesRouter } from './routes/overrides.js';
import { createShadowReportRouter } from './routes/shadow-report.js';
import { createPRShadowRouter } from './routes/pr-shadow.js';
import { createImpactReportRouter } from './routes/impact-report.js';
import { createBillingOutcomeRouter } from './routes/billing-outcome.js';
import { createPostmortemRouter } from './routes/postmortem.js';
import { createExplainWhyRouter } from './routes/explain-why.js';
import { createAgentBlundersRouter } from './routes/agent-blunders.js';
import { createHabituationRouter } from './routes/habituation.js';
import { cloudAuthMiddleware, CLOUD_MODE } from './sensor/cloud-auth.js';
import { handleSlackActions, handleFeedbackLink } from './intelligence/slack.js';
import { getPrometheusMetrics } from './sensor/otel-exporter.js';
import { auditMiddleware } from './sensor/audit-log.js';
import { ssoMiddleware } from './sensor/sso.js';
import { serviceGraph } from './sensor/service-graph.js';

/** Paths that require the x-mergen-secret header on non-GET requests. */
const MUTATING_PATHS = ['/feedback', '/license', '/clear', '/checkpoint', '/telemetry', '/otel-config', '/postmortem'];

/** Hostnames always valid for local-only mode. */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

export function createApp(opts: { serverVersion: string; localSecret: string; port: number; bindHost: string }): express.Express {
  const { serverVersion, localSecret, port, bindHost } = opts;
  const app = express();

  // ── Raw-body webhook routers — MUST precede express.json() ─────────────────
  app.use(billingRouter);
  app.use(sentryRouter);
  app.use(createGitHubWebhookRouter());
  app.use(createPagerDutyRouter()); // raw-body HMAC — must stay before express.json()

  app.use(express.json({ strict: true, limit: '1mb' }));

  // ── Audit log ─────────────────────────────────────────────────────────────
  // Records every non-trivial request to ~/.mergen/audit.log (JSONL).
  // Always-on; overhead is an async appendFileSync on response finish.
  app.use(auditMiddleware);

  // ── Security headers ──────────────────────────────────────────────────────
  // helmet sets X-Content-Type-Options, X-Frame-Options, Referrer-Policy, etc.
  // CSP and COEP are disabled — the dashboard/setup UI embed third-party scripts.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  // ── CORS ──────────────────────────────────────────────────────────────────
  // Local mode (127.0.0.1): wildcard is safe — only local processes can reach the
  // server and content scripts run under the page origin, not chrome-extension://.
  // Team mode (0.0.0.0): restrict to MERGEN_ALLOWED_ORIGINS; warn if unset.
  const allowedOrigins = process.env.MERGEN_ALLOWED_ORIGINS
    ? new Set(process.env.MERGEN_ALLOWED_ORIGINS.split(',').map((s) => s.trim()))
    : null;
  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined;
    if (bindHost === '127.0.0.1') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (allowedOrigins) {
      if (origin && allowedOrigins.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    } else {
      // Team mode with no allowlist — allow all (preserves previous behaviour)
      // but operators should set MERGEN_ALLOWED_ORIGINS for hardened deployments.
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mergen-secret, x-api-key');
    next();
  });

  // ── DNS-rebinding / Host-header validation ────────────────────────────────
  // In local-only mode every legitimate caller sets Host: 127.0.0.1:<port> or
  // Host: localhost:<port>. A DNS-rebinding attack or an XSS payload running on
  // a different localhost port would send a different Host value and is rejected
  // here before it reaches any route. Skipped in team mode (MERGEN_BIND ≠
  // 127.0.0.1) where the server is intentionally reachable from the network.
  if (bindHost === '127.0.0.1') {
    app.use((req, res, next) => {
      if (req.method === 'OPTIONS') { next(); return; }
      const raw = req.headers.host ?? '';
      // Strip brackets from IPv6 literal hosts like [::1]:3000
      const hostname = raw.replace(/^\[([^\]]+)\].*$/, '$1').split(':')[0];
      const hostPort = raw.includes(':') ? raw.split(':').pop() : null;
      if (!LOCAL_HOSTNAMES.has(hostname) || (hostPort !== null && hostPort !== String(port))) {
        res.status(421).json({ error: 'misdirected request' });
        return;
      }
      next();
    });
  }

  app.options('*', (_req, res) => res.status(204).end());

  // ── Local-secret endpoint ─────────────────────────────────────────────────
  // Browser extension popup reads this once to obtain the shared secret.
  // Only served in local mode (127.0.0.1); in team mode the endpoint is
  // disabled — clients must read ~/.mergen/secret directly from disk.
  // Cache-Control: no-store prevents the browser from caching the secret.
  app.get('/local-secret', (_req, res) => {
    if (bindHost !== '127.0.0.1') {
      res.status(404).json({ error: 'not available in team mode' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ secret: localSecret });
  });

  // ── SSO guard (enterprise) ────────────────────────────────────────────────
  // Only active when MERGEN_SSO_REQUIRED=true + MERGEN_SSO_TOKEN is set.
  // Validates Authorization: Bearer <token> on all mutating requests.
  app.use(ssoMiddleware);

  // ── Local-secret guard ────────────────────────────────────────────────────
  // VS Code / Cursor extensions read ~/.mergen/secret and send it as
  // x-mergen-secret. The Host check above blocks DNS rebinding for routes not
  // in this list; this guard adds a second factor for privileged admin actions.
  // Comparison is timing-safe to prevent brute-force oracle attacks.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'OPTIONS') { next(); return; }
    if (!MUTATING_PATHS.some((p) => req.path === p || req.path.startsWith(p + '/'))) { next(); return; }
    const presented = req.headers['x-mergen-secret'];
    const valid = typeof presented === 'string' &&
      presented.length === localSecret.length &&
      crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(localSecret));
    if (!valid) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  // ── Route modules ─────────────────────────────────────────────────────────
  app.use(createDashboardRouter(serverVersion)); // Read-only web dashboard
  app.use(createSetupRouter()); // Setup wizard UI
  app.use(createDemoRouter()); // 3-minute interactive demo
  app.use(createSdkRouter()); // serves @mergen/browser as /sdk.js — one <script> tag install
  app.use(createSensorRouter(serverVersion));
  app.use(createLicenseRouter());
  app.use(createCalibrationRouter());
  app.use(createTelemetryRouter());
  app.use(teamRouter);
  // ── Cloud-mode API key auth — guards ingest in MERGEN_CLOUD_MODE=true ────────
  app.use('/ingest', cloudAuthMiddleware);
  app.use('/v1', cloudAuthMiddleware);   // OTLP paths
  app.use(ingestRouter);
  app.use(layersRouter); // Layer 2-4 routes
  app.use(otelRouter);         // OpenTelemetry export config
  app.use(otlpReceiverRouter); // OTLP HTTP receiver (also served on port 4318)
  app.use(createCIRouter());       // CI/CD and deployment events
  app.use(createIncidentsRouter()); // Incident workflow (acknowledge/assign/resolve/note)
  app.use(createTicketsRouter());   // Linear + Jira one-click ticket creation
  app.use(createValidateRouter()); // Fix validation state
  app.use(createSessionsRouter()); // Session history + audit log
  // PagerDuty webhook registered before express.json() above for raw body HMAC
  app.use(createIncidentWebhookRouter());   // Generic incident webhook (no PagerDuty required)
  app.use(createHeartbeatsRouter());        // Heartbeat / cron-job monitoring
  // GitHub webhook registered before express.json() above for raw body HMAC
  app.use(createWarRoomRouter());       // War room API + attribution feedback
  app.use(createSlackRoutingRouter());  // Service-to-Slack webhook routing rules
  app.use(createApiKeysRouter());       // Cloud-mode API key management
  app.use(createRbacRouter());          // RBAC membership management
  app.use(createOverridesRouter());     // Engineer override corpus
  app.use(createShadowReportRouter());  // Shadow mode track record (fix execution)
  app.use(createPRShadowRouter());      // PR shadow mode (comment readiness signal)
  app.use(createImpactReportRouter());  // Deck-quality impact artifact
  app.use(createBillingOutcomeRouter()); // Y5: outcome-based billing evidence
  app.use(createPostmortemRouter());    // POST /postmortem/from-slack
  app.use(createExplainWhyRouter());    // GET /explain-why/file?path=
  app.use(createAgentBlundersRouter()); // Agent Blunder Log — safety interceptions
  app.use(createHabituationRouter());   // Organic habituation — weekly engineer engagement

  // GET /service-graph — in cloud mode, require API key (exposes internal topology)
  app.get('/service-graph', ...(CLOUD_MODE ? [cloudAuthMiddleware] : []), (_req, res) => {
    res.json({ ok: true, graph: serviceGraph.toJSON() });
  });

  // ── Prometheus metrics endpoint ───────────────────────────────────────────
  // In cloud mode, require API key — counters reveal internal error rates.
  app.get('/metrics', ...(CLOUD_MODE ? [cloudAuthMiddleware] : []), (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(getPrometheusMetrics());
  });

  // ── Slack interactive actions & feedback link ─────────────────────────────
  app.post('/slack/actions', (req, res) => { void handleSlackActions(req, res); });
  app.get('/feedback', (req, res) => { void handleFeedbackLink(req, res); });

  // ── Malformed JSON handler ────────────────────────────────────────────────
  app.use(
    (
      err: Error & { type?: string },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (err.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'malformed JSON' });
        return;
      }
      next(err);
    },
  );

  return app;
}
