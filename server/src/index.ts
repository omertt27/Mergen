import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ingestRouter } from './ingest.js';
import { registerTools } from './tools.js';
import { toolCallCounts } from './tools.js';
import { SYSTEM_PROMPT } from './prompts.js';
import logger from './logger.js';
import { store } from './buffer.js';
import { initLicense, getLicenseState, activateKey, deactivateKey, getActivePlanId } from './license.js';
import { initUsage, getUsageSnapshot, flushOverageOnShutdown } from './usage.js';
import { billingRouter } from './billing.js';
import { teamRouter, initTeam, getTeamState, isTeamEnabled } from './team.js';
import { getPlan } from './plans.js';
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
  // ── Init license + usage + team (before HTTP server) ────────────────────────
  await initLicense();
  await initUsage();
  await initTeam();

  // ── Express (HTTP ingest) ──────────────────────────────────────────────────
  const app = express();

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
    res.json({
      ok: true,
      buffered: store.size(),
      errors: store.getLogs(200, 'error').length,
      warnings: store.getLogs(200, 'warn').length,
      networkErrors: store.getNetwork(200).filter((e) => e.status >= 400).length,
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

  // ── Usage endpoint ─────────────────────────────────────────────────────────

  app.get('/usage', (_req, res) => {
    res.json({ ...getUsageSnapshot(), toolCallCounts });
  });

  // ── Billing webhooks (raw body — must be before express.json router) ───────
  app.use(billingRouter);

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
