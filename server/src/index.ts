#!/usr/bin/env node
// ↑ Shebang lets `npx -y mergen-server` and any direct `bin` invocation
//   run this file without an explicit `node`. Required for every MCP
//   marketplace's one-line install command.
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ingestRouter } from './ingest.js';
import { registerTools } from './tools.js';
import { toolCallCounts } from './tools.js';
import { SYSTEM_PROMPT } from './prompts.js';
import logger from './logger.js';
import { store, setBufferSizeGetter } from './buffer.js';
import { buildCausalChain } from './causal.js';
import { initLicense, getLicenseState, activateKey, deactivateKey, getActivePlanId } from './license.js';
import { initUsage, getUsageSnapshot, flushOverageOnShutdown } from './usage.js';
import { billingRouter } from './billing.js';
import { teamRouter, initTeam, getTeamState, isTeamEnabled } from './team.js';
import { getPlan } from './plans.js';
import { hypothesisHistory } from './hypothesis-history.js';
import { recordVerdict, getStats } from './calibration.js';
import { initTelemetry, getTelemetryState, setTelemetryEnabled, maybeSendTelemetry } from './telemetry.js';
import { startWatcher } from './watcher.js';
import { lemonSqueezySetup } from '@lemonsqueezy/lemonsqueezy.js';
import net from 'net';
import type { Server as HttpServer } from 'http';
import { createRequire } from 'module';

// P4.4: Read version from package.json — single source of truth
const _require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = _require('../package.json') as { version: string };

const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 3010;

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function findPort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (await isPortAvailable(port)) return port;
    logger.warn(`port ${port} in use, trying next...`);
  }
  logger.error(`all ports ${start}–${end} are in use; kill the conflicting process and restart`);
  process.exit(1);
}

async function main(): Promise<void> {
  // ── Init LemonSqueezy SDK once (before any module that uses it) ────────────
  const lsApiKey = process.env.LS_API_KEY;
  if (lsApiKey) lemonSqueezySetup({ apiKey: lsApiKey });

  // ── Init license + usage + team (before HTTP server) ────────────────────────
  await initLicense();
  await initUsage();
  await initTeam();
  await initTelemetry();

  // Wire plan-aware buffer size limit (free plan = 50 events visible)
  setBufferSizeGetter(() => getPlan(getActivePlanId()).bufferSize);

  // ── Express (HTTP ingest) ──────────────────────────────────────────────────
  const app = express();

  // Billing webhook needs raw body for HMAC — mount BEFORE express.json()
  app.use(billingRouter);

  app.use(express.json({ strict: true, limit: '1mb' }));

  // CORS: binding to 127.0.0.1 means only local processes can connect, so
  // wildcard origin is safe. Content scripts run under the page's origin
  // (e.g. http://localhost:5173), not chrome-extension://, so we must allow *.
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mergen-secret');
    next();
  });

  app.options('*', (_req, res) => res.status(204).end());

  // Health endpoint — used by the extension for port discovery
  app.get('/health', (_req, res) => {
    const teamState = getTeamState();
    const counters = store.getCounters();
    res.json({
      ok: true,
      buffered: store.size(),
      errors: counters.errors,
      warnings: counters.warnings,
      networkErrors: counters.networkErrors,
      signals: store.getSignals(),
      name: 'mergen',
      version: SERVER_VERSION,
      teamSync: isTeamEnabled()
        ? { enabled: true, memberName: teamState?.memberName, connectedPeers: 0 }
        : { enabled: false },
    });
  });

  // Clear endpoint — callable from popup or MCP
  app.post('/clear', (_req, res) => {
    const was = store.size();
    store.clear();
    hypothesisHistory.clear();
    res.json({ ok: true, cleared: was });
  });

  // ── Checkpoint endpoint ────────────────────────────────────────────────────
  // POST /checkpoint { label?: string }
  //
  // Named dev milestone snapshot — injected into the buffer as a console.log
  // event so it appears in the causal timeline and in session_summary output.
  //
  // Called by:
  //   • The git pre-commit hook (installed by setup.mjs --git-hooks)
  //   • A VS Code task run on save (optional, documented in SETUP.md)
  //   • Any script that wants to mark a point in time ("after login impl", etc.)
  //
  // This is the key engagement hook for normal dev flow:
  // the buffer now accumulates across saves + commits, not just crashes.
  app.post('/checkpoint', (req, res) => {
    const { label } = (req.body ?? {}) as { label?: string };
    const name = (typeof label === 'string' && label.trim())
      ? label.trim().slice(0, 120)
      : 'checkpoint';

    store.push({
      type: 'console',
      level: 'log',
      args: [`[mergen:checkpoint] ${name}`],
      url: 'mergen://checkpoint',
      timestamp: Date.now(),
    });

    const signals = store.getSignals();
    res.json({
      ok: true,
      label: name,
      buffered: store.size(),
      signals: signals.length,
      // Surface the top signal immediately — this is the "loop re-entry" moment.
      // A script or IDE plugin can show this to the dev right after each save.
      topSignal: signals[0] ?? null,
    });
  });

  // ── License endpoints ──────────────────────────────────────────────────────

  // GET /license — current plan + activation state
  app.get('/license', (_req, res) => {
    const state = getLicenseState();
    const planId = getActivePlanId();
    const plan = getPlan(planId);
    res.json({
      plan: {
        id: plan.id,
        name: plan.name,
        bufferSize: plan.bufferSize,
        analyzeCreditsPerMonth: plan.analyzeCreditsPerMonth === Infinity ? null : plan.analyzeCreditsPerMonth,
        teamSync: plan.teamSync,
      },
      license: state
        ? { status: state.status, email: state.customerEmail, name: state.customerName, activatedAt: state.activatedAt }
        : null,
    });
  });

  // POST /license { key } — activate a LemonSqueezy license key
  app.post('/license', async (req, res) => {
    const { key } = req.body as { key?: string };
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    try {
      const state = await activateKey(key.trim());
      res.json({ ok: true, plan: state.planId, email: state.customerEmail });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'activation failed';
      logger.warn({ err }, 'license activation failed');
      res.status(422).json({ error: msg });
    }
  });

  // DELETE /license — deactivate and revert to free
  app.delete('/license', async (_req, res) => {
    await deactivateKey();
    res.json({ ok: true, plan: 'free' });
  });

  // ── Diagnose endpoint ─────────────────────────────────────────────────────
  // GET /diagnose
  //
  // Returns the current buffer's contextPack plus a fully-formed OpenAI
  // chat/completions request body. Drop the `openai_request` object straight
  // into curl / fetch to get a structured diagnosis without opening the IDE.
  //
  // Quick test (set OPENAI_API_KEY first):
  //   curl -s http://127.0.0.1:3000/diagnose | node scripts/diagnose.mjs
  //
  // Or pipe the raw request body:
  //   curl -s http://127.0.0.1:3000/diagnose \
  //     | jq .openai_request \
  //     | curl -s https://api.openai.com/v1/chat/completions \
  //         -H "Authorization: Bearer $OPENAI_API_KEY" \
  //         -H "Content-Type: application/json" \
  //         -d @-
  app.get('/diagnose', async (_req, res) => {
    const logs     = store.getLogs(200);
    const network  = store.getNetwork(200);
    const contexts = store.getContext(20);

    const causal = await buildCausalChain(logs, network, contexts);

    const SYSTEM = [
      'You are a concise runtime-debug assistant.',
      'You will receive a structured telemetry report called a "Context Pack".',
      'Your job is to identify the root cause of the bug and the exact fix.',
      '',
      'Rules:',
      '1. Respond with a single JSON object only — no surrounding prose, no markdown fences.',
      '2. Be maximally specific: name the endpoint, field, or code path that is broken.',
      '3. The fix must be a concrete, immediately-applicable action (a code line, not a concept).',
      '4. If you are not confident, say so in missing_signals — do not hallucinate.',
    ].join('\n');

    const USER = [
      causal.contextPack,
      '',
      'Return a single JSON object with exactly these fields:',
      '  root_cause  — one sentence naming what broke and why (be specific: endpoint/field/line)',
      '  fix         — one concrete action: a code line, config change, or exact command',
      '  confidence  — HIGH | MEDIUM | LOW',
      '  missing_signals — what telemetry would make this HIGH confidence, or null',
    ].join('\n');

    const openaiRequest = {
      model: 'gpt-4o',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: USER },
      ],
    };

    res.json({
      ok: true,
      buffered: store.size(),
      hypotheses: causal.hypotheses.length,
      // The context pack rendered as a string — for human inspection
      contextPack: causal.contextPack,
      // Drop this directly into POST https://api.openai.com/v1/chat/completions
      openai_request: openaiRequest,
      // Convenience: the system + user messages as plain text for other LLMs
      prompt: { system: SYSTEM, user: USER },
    });
  });

  // ── Usage endpoint ─────────────────────────────────────────────────────────

  app.get('/usage', (_req, res) => {
    res.json({ ...getUsageSnapshot(), toolCallCounts });
  });

  // ── Hypothesis history (B2 + C1) ───────────────────────────────────────────
  // Both endpoints are FREE — they read the in-memory cache populated by
  // ingest.ts. No analyze_runtime credit is consumed. This is the surface
  // the VS Code panel uses to render the live Context Pack and history list.

  // GET /last-pack — full Context Pack of the most recent diagnosis
  //
  // Calibration enrichment: every hypothesis carries its detector's empirical
  // accuracy (and 7-day trend) so the panel can render a "73% — 11/15 correct"
  // badge inline. This is the *visible* half of the accountability loop:
  // users see the track record before they're asked to trust the verdict.
  app.get('/last-pack', (_req, res) => {
    const latest = hypothesisHistory.latest();
    if (!latest) {
      res.json({ ok: true, hasPack: false });
      return;
    }
    const statsByTag = new Map(getStats().map((s) => [s.tag, s]));
    const enrich = (h: typeof latest.topHypothesis) =>
      h ? { ...h, calibration: statsByTag.get(h.tag) ?? null } : h;
    res.json({
      ok: true,
      hasPack: true,
      builtAt: latest.builtAt,
      builtAtIso: latest.builtAtIso,
      triggerMessage: latest.triggerMessage,
      reason: latest.reason,
      topHypothesis: enrich(latest.topHypothesis),
      hypotheses: latest.chain.hypotheses.map((h) => enrich(h)),
      contextPack: latest.chain.contextPack,
      hypothesesCount: latest.chain.hypotheses.length,
      errorsCount: latest.chain.errors.length,
    });
  });

  // GET /history — list of recent diagnoses (lightweight, no contextPack)
  // Each entry's `topHypothesis` is enriched with its detector calibration so
  // the history list can show accuracy badges without an extra round-trip.
  app.get('/history', (req, res) => {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 10)));
    const statsByTag = new Map(getStats().map((s) => [s.tag, s]));
    const entries = hypothesisHistory.list(limit).map((e) => ({
      ...e,
      topHypothesis: e.topHypothesis
        ? { ...e.topHypothesis, calibration: statsByTag.get(e.topHypothesis.tag) ?? null }
        : null,
    }));
    res.json({ ok: true, entries });
  });

  // ── Feedback / Calibration ─────────────────────────────────────────────────
  // The accountability layer. See server/src/calibration.ts for rationale.
  //
  // POST /feedback { pid, verdict: 'correct' | 'wrong' | 'partial' }
  //   Tells the engine whether the hypothesis with the given prediction id
  //   was actually right. The next time the same detector fires its score
  //   is adjusted by its empirical accuracy. After 5 verdicts a detector is
  //   "trusted"; below 50% accuracy it is demoted, below 20% suppressed.
  //
  // GET /calibration
  //   Per-detector accuracy snapshot. The VS Code panel uses this to render
  //   "Detector accuracy: 7/8 correct (88%)" badges next to each hypothesis,
  //   so users see *why* a result is HIGH and not just *that* it is.
  //
  // Both endpoints are FREE — trust is binary: either users can verify our
  // claims or they correctly stop using us.
  app.post('/feedback', (req, res) => {
    const { pid, verdict, note } = (req.body ?? {}) as { pid?: string; verdict?: string; note?: string };
    if (!pid || typeof pid !== 'string') {
      res.status(400).json({ ok: false, error: 'pid (string) is required' });
      return;
    }
    if (verdict !== 'correct' && verdict !== 'wrong' && verdict !== 'partial') {
      res.status(400).json({ ok: false, error: "verdict must be 'correct' | 'wrong' | 'partial'" });
      return;
    }
    const cleanNote = typeof note === 'string' && note.trim() ? note : undefined;
    const found = recordVerdict(pid, verdict, cleanNote);
    if (!found) {
      res.status(404).json({ ok: false, error: `unknown pid: ${pid}` });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/calibration', (_req, res) => {
    const stats = getStats();
    const trusted = stats.filter((s) => s.trusted);
    const totalVerdicts = trusted.reduce((sum, s) => sum + s.verdicts, 0);
    const overall = totalVerdicts > 0
      ? trusted.reduce((sum, s) => sum + s.accuracy * s.verdicts, 0) / totalVerdicts
      : null;
    res.json({
      ok: true,
      overallAccuracy: overall,            // null until ≥ 5 verdicts on any tag
      trustedDetectors: trusted.length,
      totalDetectors: stats.length,
      perDetector: stats,
    });
  });

  // GET /timeline — interleaved console + network + context events as a flat,
  // chronological stream. This is Mergen's text-based answer to LogRocket's
  // session replay: scrubbable, greppable, AI-readable, and 100 KB instead
  // of 100 MB. Powers a future "scrub the last N seconds" view in the panel.
  //
  //   ?seconds=60   — return only events from the last N seconds (default 60)
  //   ?limit=200    — cap the number of returned events (default 200)
  app.get('/timeline', (req, res) => {
    const seconds = Math.min(600, Math.max(1, Number(req.query.seconds ?? 60)));
    const limit   = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
    const since   = Date.now() - seconds * 1000;

    const logs    = store.getLogs(limit, undefined, since);
    const network = store.getNetwork(limit, undefined, since);
    const ctx     = store.getContext(20, since);

    type Row = {
      ts: number;
      isoTs: string;
      kind: 'log' | 'warn' | 'error' | 'request' | 'context';
      summary: string;
    };

    const rows: Row[] = [];
    for (const e of logs) {
      const summary = e.args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ').slice(0, 200);
      rows.push({
        ts: e.timestamp,
        isoTs: new Date(e.timestamp).toISOString(),
        kind: e.level,
        summary,
      });
    }
    for (const n of network) {
      const isFail = n.status >= 400 || n.status === 0 || !!n.error;
      const label = n.status === 0 ? `network error (${n.error ?? '—'})` : `${n.status} ${n.statusText}`;
      rows.push({
        ts: n.timestamp,
        isoTs: new Date(n.timestamp).toISOString(),
        kind: 'request',
        summary: `${n.method} ${n.url} → ${label} (${n.duration}ms)${isFail ? ' ⚠' : ''}`,
      });
    }
    for (const c of ctx) {
      rows.push({
        ts: c.timestamp,
        isoTs: new Date(c.timestamp).toISOString(),
        kind: 'context',
        summary: `[${c.trigger}] ${c.url}`,
      });
    }
    rows.sort((a, b) => a.ts - b.ts);

    res.json({
      ok: true,
      windowSeconds: seconds,
      count: rows.length,
      rows: rows.slice(-limit),
    });
  });

  // ── Telemetry endpoints (D6) ───────────────────────────────────────────────
  // GET /telemetry — current opt-in state and anonymous installId.
  app.get('/telemetry', (_req, res) => {
    const t = getTelemetryState();
    res.json({
      ok: true,
      enabled: t.enabled,
      installId: t.installId,
      lastSentAt: t.lastSentAt,
      endpointConfigured: Boolean(process.env.MERGEN_TELEMETRY_URL),
    });
  });

  // POST /telemetry { enabled: boolean } — opt in or out.
  app.post('/telemetry', async (req, res) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' });
      return;
    }
    await setTelemetryEnabled(enabled);
    res.json({ ok: true, enabled });
  });

  // ── Team sync routes ───────────────────────────────────────────────────────
  app.use(teamRouter);

  app.use(ingestRouter);

  // Malformed JSON error handler (4-param signature required by Express)
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

  const port = await findPort(PORT_RANGE_START, PORT_RANGE_END);
  const httpServer: HttpServer = app.listen(port, '127.0.0.1', () => {
    logger.info({ port }, `HTTP ingest listening on http://127.0.0.1:${port}`);
  });

  // ── MCP Server (stdio) ────────────────────────────────────────────────────
  const mcp = new McpServer(
    { name: 'mergen', version: SERVER_VERSION },
    { instructions: SYSTEM_PROMPT },
  );

  registerTools(mcp);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info('MCP server ready (stdio transport)');

  // ── Telemetry tick (D6) — opt-in, throttled to once per 24h, silent on err.
  const telemetryTick = (): void => {
    void maybeSendTelemetry({
      serverVersion: SERVER_VERSION,
      nodeVersion: process.versions.node.split('.')[0],
      planId: getActivePlanId(),
      toolCallCounts,
      bufferedEvents: store.size(),
    });
  };
  setTimeout(telemetryTick, 60_000).unref();           // first try after 1 min
  setInterval(telemetryTick, 60 * 60 * 1000).unref();  // hourly retry (throttle is in maybeSendTelemetry)

  // ── Continuous diagnostic loop (the "watcher" pivot) ──────────────────────
  // Ticks every 15 s by default; rebuilds the Context Pack when the buffer
  // has changed since the last tick. This is what makes Mergen *continuous*
  // rather than error-triggered. Disable with MERGEN_WATCH=0.
  startWatcher();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  function shutdown(signal: string): void {
    logger.info({ signal }, 'shutting down');
    // Flush any pending overage before exiting
    flushOverageOnShutdown().finally(() => {
      httpServer.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 5_000).unref();
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
