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
import { createDashboardRouter } from './routes/dashboard.js';
import { handleSlackActions, handleFeedbackLink } from './intelligence/slack.js';

/** Paths that require the x-mergen-secret header on non-GET requests. */
const MUTATING_PATHS = ['/feedback', '/license', '/clear', '/checkpoint', '/telemetry', '/otel-config'];

export function createApp(opts: { serverVersion: string; localSecret: string }): express.Express {
  const { serverVersion, localSecret } = opts;
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

  app.options('*', (_req, res) => res.status(204).end());

  // ── Local-secret guard ────────────────────────────────────────────────────
  // Any browser tab on the machine can reach 127.0.0.1 — the browser sends
  // the request even when CORS blocks reading the response. For POSTs/DELETEs
  // the damage is already done. We require the shared secret (written to
  // ~/.mergen/secret on first start) on all state-changing routes.
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
