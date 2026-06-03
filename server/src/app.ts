/**
 * app.ts — Express application factory.
 *
 * Assembles middleware and all route modules into a single Express app.
 * Kept separate from index.ts so the app can be imported in tests without
 * binding a port, and from server.ts so port-discovery logic stays isolated.
 *
 * Call order matters:
 *   1. billingRouter   — needs raw body for HMAC, must precede express.json()
 *   2. express.json()  — parses the rest
 *   3. CORS headers
 *   4. Secret guard    — blocks unauthenticated mutating requests
 *   5. Route modules
 *   6. Error handler
 */
import express from 'express';
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
import { createCIRouter } from './routes/ci.js';
import { createIncidentsRouter } from './routes/incidents.js';
import { createTicketsRouter } from './routes/tickets.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { handleSlackActions, handleFeedbackLink } from './intelligence/slack.js';

/** Paths that require the x-mergen-secret header on non-GET requests. */
const MUTATING_PATHS = ['/feedback', '/license', '/clear', '/checkpoint', '/telemetry', '/otel-config'];

/** Hostnames always valid for local-only mode. */
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

export function createApp(opts: { serverVersion: string; localSecret: string; port: number; bindHost: string }): express.Express {
  const { serverVersion, localSecret, port, bindHost } = opts;
  const app = express();

  // ── Billing webhook — raw body for HMAC, MUST precede express.json() ──────
  app.use(billingRouter);

  // ── Sentry webhook — raw body for HMAC, MUST precede express.json() ───────
  app.use(sentryRouter);

  app.use(express.json({ strict: true, limit: '1mb' }));

  // ── CORS ──────────────────────────────────────────────────────────────────
  // Binding to 127.0.0.1 means only local processes connect, so wildcard is
  // safe. Content scripts run under the page's origin (e.g. localhost:5173),
  // not chrome-extension://, so we must allow *.
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mergen-secret');
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
  // Browser clients (extension popup, dashboard) read this once to obtain the
  // shared secret for mutating requests. Protected by the Host-header check
  // above, so only callers on 127.0.0.1:<port> can retrieve it.
  app.get('/local-secret', (_req, res) => {
    res.json({ secret: localSecret });
  });

  // ── Local-secret guard ────────────────────────────────────────────────────
  // VS Code / Cursor extensions read ~/.mergen/secret and send it as
  // x-mergen-secret. The Host check above blocks DNS rebinding for routes not
  // in this list; this guard adds a second factor for privileged admin actions.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'OPTIONS') { next(); return; }
    if (!MUTATING_PATHS.some((p) => req.path === p || req.path.startsWith(p + '/'))) { next(); return; }
    if (req.headers['x-mergen-secret'] !== localSecret) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  // ── Route modules ─────────────────────────────────────────────────────────
  app.use(createDashboardRouter(serverVersion)); // Read-only web dashboard
  app.use(createSetupRouter()); // Setup wizard UI
  app.use(createSensorRouter(serverVersion));
  app.use(createLicenseRouter());
  app.use(createCalibrationRouter());
  app.use(createTelemetryRouter());
  app.use(teamRouter);
  app.use(ingestRouter);
  app.use(layersRouter); // Layer 2-4 routes
  app.use(otelRouter);   // OpenTelemetry export config
  app.use(createCIRouter());       // CI/CD and deployment events
  app.use(createIncidentsRouter()); // Incident workflow (acknowledge/assign/resolve/note)
  app.use(createTicketsRouter());   // Linear + Jira one-click ticket creation

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
