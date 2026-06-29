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
import express from 'express';
import { LRUCache } from 'lru-cache';
import helmet from 'helmet';
import logger from './sensor/logger.js';
import { timingSafeSecretEqual, timingSafeSecretEqualAny } from './sensor/security-utils.js';
import { billingRouter } from './intelligence/billing.js';
import { teamRouter } from './intelligence/team.js';
import { createIngestRouter } from './sensor/ingest.js';
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
import { createTenantsRouter } from './routes/tenants.js';
import { createRbacRouter } from './routes/rbac.js';
import { createOverridesRouter } from './routes/overrides.js';
import { createShadowReportRouter } from './routes/shadow-report.js';
import { createPRShadowRouter } from './routes/pr-shadow.js';
import { createImpactReportRouter } from './routes/impact-report.js';
import { createBillingOutcomeRouter } from './routes/billing-outcome.js';
import { createBillingDashboardRouter } from './routes/billing-dashboard.js';
import { createOnboardingRouter } from './routes/onboarding.js';
import { createHealthIntegrationsRouter } from './routes/health-integrations.js';
import { createTeamUsageRouter } from './routes/team-usage.js';
import { createActiveAuthorsRouter } from './routes/active-authors.js';
import { createPostmortemRouter } from './routes/postmortem.js';
import { createExplainWhyRouter } from './routes/explain-why.js';
import { createAgentBlundersRouter } from './routes/agent-blunders.js';
import { createHabituationRouter } from './routes/habituation.js';
import { createAdrRouter } from './routes/adr.js';
import { createConfidenceRouter } from './routes/confidence.js';
import { createArchRouter } from './routes/arch.js';
import { createRunbooksRouter } from './routes/runbooks.js';
import { createCIGateRouter } from './routes/ci-gate.js';
import { createHitlRouter } from './routes/hitl.js';
import { createGateAnalyticsRouter } from './routes/gate-analytics.js';
import { createPoliciesRouter } from './routes/policies.js';
import { createRiskReportRouter } from './routes/risk-report.js';
import { createSafetyTestRouter } from './routes/safety-test.js';
import { createAgentActivityRouter } from './routes/agent-activity.js';
import { createPolicyNlRouter } from './routes/policy-nl.js';
import { createAgentsRouter } from './routes/agents.js';
import { createActivityFeedRouter } from './routes/activity-feed.js';
import { createAuditExportRouter } from './routes/audit-export.js';
import { cloudAuthMiddleware, CLOUD_MODE } from './sensor/cloud-auth.js';
import { handleSlackActions, handleFeedbackLink } from './intelligence/slack.js';
import { getPrometheusMetrics } from './sensor/otel-exporter.js';
import { auditMiddleware } from './sensor/audit-log.js';
import { ssoMiddleware } from './sensor/sso.js';
import { serviceGraph } from './sensor/service-graph.js';
import { routeReachability } from './sensor/route-reachability.js';

/** Paths that require the x-mergen-secret header on non-GET requests. */
const MUTATING_PATHS = [
  '/feedback', '/license', '/clear', '/checkpoint', '/telemetry', '/otel-config', '/postmortem',
  // Incident pipeline — triggers autonomous command execution
  '/incident',
  // Infrastructure mutations
  '/ci', '/overrides', '/rbac', '/heartbeats', '/slack/routing', '/slack/test', '/runbooks', '/ci/gate', '/policies',
  // /hitl/approve and /hitl/deny are self-authenticated (HMAC nonce or x-mergen-secret
  // handled inside createHitlRouter). Only /hitl/pending requires the global secret guard.
  '/hitl/pending',
  // Process / container watchers
  '/watchers',
  // Billing & account mutations
  '/api-keys', '/tenants', '/onboarding/dismiss',
  // Shadow report verdict → writes to override corpus (safety gate)
  '/shadow-report',
  // Demo injection routes → write directly to the ring buffer
  '/demo',
];

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

  // Slack interactive actions — raw body needed for HMAC signature verification.
  // Slack sends application/x-www-form-urlencoded; we parse it here and attach
  // rawBody so verifySlackSignature() can compute the correct HMAC.
  app.post('/slack/actions', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      (req as unknown as { rawBody: Buffer }).rawBody = rawBody;
      const ct = (req.headers['content-type'] ?? '').toLowerCase();
      if (ct.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(rawBody.toString('utf8'));
        req.body = Object.fromEntries(params);
      } else {
        try { req.body = JSON.parse(rawBody.toString('utf8')); } catch { req.body = {}; }
      }
      void handleSlackActions(req, res);
    });
  });

  app.use(express.json({ strict: true, limit: '1mb' }));

  // ── Audit log ─────────────────────────────────────────────────────────────
  // Records every non-trivial request to ~/.mergen/audit.log (JSONL).
  // Always-on; overhead is an async appendFileSync on response finish.
  app.use(auditMiddleware);

  // ── Security headers ──────────────────────────────────────────────────────
  // Apply helmet globally. CSP is handled per-route below so we can be strict
  // on API paths while allowing the dashboard/setup UI to embed third-party scripts.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  // ── Route-scoped Content-Security-Policy ──────────────────────────────────
  // Pure-API paths (incidents, overrides, hitl, ingest, webhooks …) serve only
  // JSON / plain text and never need inline scripts or external origins.
  // Applying a strict CSP here limits the blast radius of any XSS that may exist
  // in error messages or dynamic content surfaced through these endpoints.
  //
  // Dashboard / setup / demo routes are excluded because they embed third-party
  // scripts (charts, analytics, CDN assets); those continue with no CSP.
  const STRICT_CSP = "default-src 'none'; frame-ancestors 'none'";
  const CSP_EXEMPT_PREFIXES = [
    '/dashboard', '/setup', '/demo', '/sdk',   // UI with external scripts
    '/feedback',  '/billing',                   // pages with external embeds
    '/slack/actions',                           // form redirect targets
    '/hitl/approve', '/hitl/deny',              // HTML confirmation pages
  ];

  app.use((req, res, next) => {
    const isExempt = CSP_EXEMPT_PREFIXES.some(
      (p) => req.path === p || req.path.startsWith(p + '/') || req.path.startsWith(p + '?'),
    );
    if (!isExempt) {
      res.setHeader('Content-Security-Policy', STRICT_CSP);
    }
    next();
  });

  // ── Local-secret endpoint ─────────────────────────────────────────────────
  // Browser extension popup reads this once to obtain the shared secret.
  // Only served in local mode (127.0.0.1); in team mode the endpoint is
  // disabled — clients must read ~/.mergen/secret directly from disk.
  //
  // SECURITY: registered BEFORE the CORS middleware below so that this
  // route can override the CORS header to 'null' (blocks all cross-origin
  // reads). With CORS *, any HTTP webpage visited by the user could fetch
  // this endpoint and steal the secret. The 'null' value causes browsers to
  // reject the response for cross-origin requests while still serving it to
  // same-origin callers (the extension background service worker).
  //
  // Rate-limited to 10 requests/second to prevent brute-force extraction.
  const _lsBucket = { count: 0, resetAt: 0 };
  app.get('/local-secret', (_req, res) => {
    if (bindHost !== '127.0.0.1') {
      res.status(404).json({ error: 'not available in team mode' });
      return;
    }
    const now = Date.now();
    if (now > _lsBucket.resetAt) { _lsBucket.count = 0; _lsBucket.resetAt = now + 1000; }
    if (++_lsBucket.count > 10) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    // Block cross-origin reads — do not inherit the wildcard CORS header.
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.json({ secret: localSecret });
  });

  // ── CORS ──────────────────────────────────────────────────────────────────
  // Local mode (127.0.0.1): wildcard for all routes except /local-secret
  // (which sets its own header above). Content scripts run under the page
  // origin, not chrome-extension://, so they need CORS.
  // Team mode (0.0.0.0): restrict to MERGEN_ALLOWED_ORIGINS; refuse to start if unset.
  let allowedOrigins: Set<string> | null = null;
  if (process.env.MERGEN_ALLOWED_ORIGINS) {
    const validated = process.env.MERGEN_ALLOWED_ORIGINS
      .split(',')
      .map((s) => s.trim())
      .filter((s) => {
        try { new URL(s); return true; }
        catch { logger.warn({ origin: s }, 'CORS: invalid origin in MERGEN_ALLOWED_ORIGINS — skipped'); return false; }
      });
    allowedOrigins = new Set(validated);
  }

  if (bindHost !== '127.0.0.1' && !allowedOrigins) {
    // In team/cloud mode, running with CORS open to all origins is a security
    // misconfiguration. Refuse to start rather than silently allowing it.
    logger.error(
      'FATAL: MERGEN_BIND is not 127.0.0.1 (team/cloud mode) but MERGEN_ALLOWED_ORIGINS is not set. ' +
      'Set MERGEN_ALLOWED_ORIGINS=https://your-dashboard.example.com to restrict cross-origin access, then restart.',
    );
    process.exit(1);
  }

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
      // Team mode with no allowlist — allow all (preserves previous behaviour).
      // Operators should set MERGEN_ALLOWED_ORIGINS for hardened deployments.
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

  // ── Global rate limiter (per IP) ──────────────────────────────────────────
  // Protects all endpoints against request floods. High-volume ingest paths
  // (/ingest exact, /v1/) are excluded — they receive continuous telemetry streams.
  // LRUCache caps memory at 10,000 unique IPs, evicting least-recently-seen
  // entries to prevent unbounded heap growth under rotating-IP traffic.
  const RATE_WINDOW_MS = 60_000; // 1 minute
  const RATE_MAX       = 600;    // 600 req/min per IP (~10 req/s)
  const _ipBuckets = new LRUCache<string, { count: number; resetAt: number }>({ max: 10_000 });

  // When the server runs behind a trusted reverse proxy (MERGEN_TRUSTED_PROXY=true),
  // extract the real client IP from X-Forwarded-For. Only trust this in cloud/team
  // mode where a proxy is expected; in local mode use the socket address directly.
  const TRUST_PROXY = process.env.MERGEN_TRUSTED_PROXY === 'true' && bindHost !== '127.0.0.1';

  function getClientIp(req: express.Request): string {
    if (TRUST_PROXY) {
      const xff = req.headers['x-forwarded-for'];
      // X-Forwarded-For: client, proxy1, proxy2 — leftmost is the original client.
      const raw = (Array.isArray(xff) ? xff[0] : xff ?? '').split(',')[0].trim();
      if (raw) return raw.replace(/^::ffff:/, '');
    }
    return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  }

  app.use((req, res, next) => {
    // Use exact match for /ingest to avoid accidentally exempting future /ingest-* routes.
    if (req.path === '/ingest' || req.path.startsWith('/v1/')) { next(); return; }
    const ip = getClientIp(req);
    const now = Date.now();
    let bucket = _ipBuckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
      _ipBuckets.set(ip, bucket);
    }
    if (++bucket.count > RATE_MAX) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    next();
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
    if (!timingSafeSecretEqualAny(presented, localSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  // ── Sensitive-data GET guard ──────────────────────────────────────────────
  // These read endpoints expose operational details that should not be
  // reachable by arbitrary browser scripts (DNS-rebinding or XSS).
  // Require x-mergen-secret when the secret is configured (always in prod).
  // Sensitive GET endpoints that expose operational data and require the shared secret.
  // Any path here that starts with a listed prefix will require x-mergen-secret on GET.
  const SENSITIVE_GET_PATHS = [
    '/api/war-room',          // incident attribution + Slack thread history
    '/sessions/history',      // full session event replay
    '/audit',                 // audit log
    '/license',               // plan, customer email, activation date
    '/agent-blunders',        // blocked command history — reveals system constraints
    '/incidents',             // live incident list + MTTR data
    '/override-corpus',       // team's operational override knowledge
    '/shadow-report/entries', // shadow log entries with proposed commands
    '/impact-report',         // autonomous resolution rate + MTTR metrics
    '/hitl/pending',          // currently-held gate tokens + policy reasons
    '/hitl/fatigue',          // HITL fatigue status — operational posture signal
    '/gate-analytics',        // retry success rates, coverage gaps, HITL decision patterns
    '/policies',              // policy rules + trigger counts — reveals enforcement posture
    '/policy-suggestions',    // auto-discovered blunder patterns — reveals enforcement gaps
    '/audit/export',          // full compliance export — tamper-evident audit log
    '/agents',                // per-agent identity + forensics timeline
    '/activity-feed',         // live tool call stream — reveals agent activity patterns
    '/risk-report',           // CISO-grade security risk report — reveals incident rates & rules
  ];
  if (localSecret) {
    app.use((req, res, next) => {
      if (req.method !== 'GET') { next(); return; }
      if (!SENSITIVE_GET_PATHS.some((p) => req.path === p || req.path.startsWith(p + '/'))) { next(); return; }
      // Accept either the x-mergen-secret header (extensions, CLI) or the ?secret=
      // query param (browser navigation to UI pages like /policies and /dashboard).
      const qSecret = req.query['secret'];
      const presented = req.headers['x-mergen-secret'] ??
        (typeof qSecret === 'string' ? qSecret : undefined);
      const valid = timingSafeSecretEqualAny(presented, localSecret);
      if (!valid) { res.status(401).json({ error: 'unauthorized' }); return; }
      next();
    });
  }

  // ── Route modules ─────────────────────────────────────────────────────────
  app.use(createDashboardRouter(serverVersion, localSecret)); // Read-only web dashboard
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
  // localSecret is always set (generated on first start); createIngestRouter uses it
  // as a fallback when MERGEN_SECRET env var is not configured, ensuring /ingest is
  // always authenticated regardless of whether the operator set MERGEN_SECRET.
  app.use(createIngestRouter(localSecret));
  app.use(layersRouter); // Layer 2-4 routes
  app.use(otelRouter);         // OpenTelemetry export config
  app.use(otlpReceiverRouter); // OTLP HTTP receiver (also served on port 4318)
  app.use(createCIRouter());       // CI/CD and deployment events
  app.use(createIncidentsRouter()); // Incident workflow (acknowledge/assign/resolve/note)
  app.use(createTicketsRouter());   // Linear + Jira one-click ticket creation
  app.use(createValidateRouter()); // Fix validation state
  app.use(createSessionsRouter()); // Session history + audit log
  // PagerDuty webhook registered before express.json() above for raw body HMAC
  // In cloud/team mode the generic incident webhook requires an API key — it
  // can trigger autonomous command execution and must not be publicly accessible.
  if (CLOUD_MODE) app.use('/incident', cloudAuthMiddleware);
  app.use(createIncidentWebhookRouter());   // Generic incident webhook (no PagerDuty required)
  app.use(createHeartbeatsRouter());        // Heartbeat / cron-job monitoring
  // GitHub webhook registered before express.json() above for raw body HMAC
  app.use(createWarRoomRouter());       // War room API + attribution feedback
  app.use(createSlackRoutingRouter());  // Service-to-Slack webhook routing rules
  app.use(createApiKeysRouter());       // Cloud-mode API key management
  app.use(createTenantsRouter());       // Cloud-mode tenant provisioning
  app.use(createRbacRouter());          // RBAC membership management
  app.use(createOverridesRouter());     // Engineer override corpus
  app.use(createShadowReportRouter());  // Shadow mode track record (fix execution)
  app.use(createPRShadowRouter());      // PR shadow mode (comment readiness signal)
  app.use(createImpactReportRouter());  // Deck-quality impact artifact
  app.use(createBillingOutcomeRouter()); // Y5: outcome-based billing evidence
  app.use(createBillingDashboardRouter()); // Unified billing dashboard (plan + usage + upgrade)
  app.use(createOnboardingRouter());      // Progressive onboarding checklist
  app.use(createHealthIntegrationsRouter()); // Machine-readable integration health
  app.use(createTeamUsageRouter());       // Team dashboard roll-up
  app.use(createActiveAuthorsRouter());  // Billing unit: unique PR authors per month
  app.use(createPostmortemRouter());    // POST /postmortem/from-slack
  app.use(createExplainWhyRouter());    // GET /explain-why/file?path=
  app.use(createAgentBlundersRouter()); // Agent Blunder Log — safety interceptions
  app.use(createHabituationRouter());   // Organic habituation — weekly engineer engagement
  app.use(createAdrRouter());           // Architectural Decision Records
  app.use(createConfidenceRouter());    // Pre-implementation confidence reports
  app.use(createArchRouter());          // Arch boundary enforcement, risk scoring, graph, critic
  app.use(createRunbooksRouter());      // Pre-approved runbook library
  app.use(createCIGateRouter());        // CI/CD corpus gate for AI-generated PRs
  app.use(createHitlRouter(localSecret)); // Human-in-the-Loop approve/deny for held tool calls
  app.use(createGateAnalyticsRouter()); // Gate feedback: retry success, coverage gaps, HITL patterns
  app.use(createPoliciesRouter(localSecret)); // Policy authoring UI + JSON CRUD API
  app.use(createRiskReportRouter());    // CISO-grade security risk report
  app.use(createSafetyTestRouter());    // Adversarial bypass test suite
  app.use(createAgentActivityRouter()); // Live agent activity dashboard
  app.use(createPolicyNlRouter());      // Natural language policy authoring
  app.use(createAgentsRouter());        // Per-agent identity and permissions
  app.use(createActivityFeedRouter());  // Real-time agent activity feed (JSON + SSE)
  app.use(createAuditExportRouter());   // Compliance-grade audit export (SOC 2 / ISO 27001)

  // GET /service-graph — in cloud mode, require API key (exposes internal topology)
  app.get('/service-graph', ...(CLOUD_MODE ? [cloudAuthMiddleware] : []), (_req, res) => {
    res.json({ ok: true, graph: serviceGraph.toJSON() });
  });

  // GET /route-reachability — live HTTP routes observed in OTLP SERVER spans.
  // Used by the topology filter to suppress hypotheses about unreachable paths.
  app.get('/route-reachability', ...(CLOUD_MODE ? [cloudAuthMiddleware] : []), (_req, res) => {
    res.json({ ok: true, ...routeReachability.toJSON() });
  });

  // ── Prometheus metrics endpoint ───────────────────────────────────────────
  // In cloud mode, require API key — counters reveal internal error rates.
  app.get('/metrics', ...(CLOUD_MODE ? [cloudAuthMiddleware] : []), (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(getPrometheusMetrics());
  });

  // ── Slack feedback link ───────────────────────────────────────────────────
  // /slack/actions is registered in the raw-body section above (before express.json()).
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
