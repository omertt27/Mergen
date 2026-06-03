#!/usr/bin/env node
// ↑ Shebang lets `npx -y mergen-server` and any direct `bin` invocation
//   run this file without an explicit `node`. Required for every MCP
//   marketplace's one-line install command.
/**
 * index.ts — Boot entrypoint. Responsible for exactly four things:
 *   1. Init services (license, usage, team, telemetry).
 *   2. Load or generate the local shared secret.
 *   3. Start the HTTP server (via app.ts) on an available port.
 *   4. Start the MCP stdio server.
 *
 * All route logic lives in src/routes/. All Express assembly lives in app.ts.
 * Keep this file under 130 lines.
 */
import fs from 'fs';
import net from 'net';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import type { Server as HttpServer } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { lemonSqueezySetup } from '@lemonsqueezy/lemonsqueezy.js';

import logger from './sensor/logger.js';
import { DATA_DIR, SECRET_FILE } from './sensor/paths.js';
import { setBufferSizeGetter, store } from './sensor/buffer.js';
import { historyStore } from './sensor/sqlite-store.js';
import { startWatcher } from './sensor/watcher.js';
import { startDockerMonitor, startHeapMonitor, stopDockerMonitor } from './sensor/docker-monitor.js';
import { startDockerLogStream, stopDockerLogStream } from './sensor/docker-log-stream.js';
import { incidentStore } from './sensor/incident-store.js';
import { stopAllProcessWatchers } from './sensor/process-watcher.js';

import { initLicense, getActivePlanId } from './intelligence/license.js';
import { initUsage, flushOverageOnShutdown } from './intelligence/usage.js';
import { initTeam, broadcastToTeam } from './intelligence/team.js';
import { initTelemetry, maybeSendTelemetry } from './intelligence/telemetry.js';
import { getPlan } from './intelligence/plans.js';
import { registerTools, toolCallCounts } from './intelligence/tools.js';
import { registerResources } from './intelligence/mcp-resources.js';
import { registerPrompts } from './intelligence/mcp-prompts.js';
import { SYSTEM_PROMPT } from './intelligence/prompts.js';
import { registerTeamBroadcaster } from './sensor/ingest.js';

import { createApp } from './app.js';
import { checkForUpdates, formatUpdateMessage } from './update-checker.js';

const _require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = _require('../package.json') as { version: string };

const PORT_RANGE_START = 3000;
const PORT_RANGE_END   = 3010;

// MERGEN_BIND=0.0.0.0 enables team mode — CI runners and remote browsers
// can POST to this instance. Defaults to 127.0.0.1 (local-only, safe default).
const BIND_HOST = process.env.MERGEN_BIND ?? '127.0.0.1';

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, BIND_HOST);
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
  // ── LemonSqueezy SDK ───────────────────────────────────────────────────────
  const lsApiKey = process.env.LS_API_KEY;
  if (lsApiKey) lemonSqueezySetup({ apiKey: lsApiKey });

  // ── Local shared secret ────────────────────────────────────────────────────
  // Written to ~/.mergen/secret on first start. The VS Code extension reads
  // this file and sends it as x-mergen-secret on every mutating request.
  let localSecret: string;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SECRET_FILE)) {
      localSecret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    } else {
      localSecret = randomUUID();
      fs.writeFileSync(SECRET_FILE, localSecret, { encoding: 'utf8', mode: 0o600 });
    }
  } catch (err) {
    logger.warn({ err }, 'secret: could not read/write secret file, generating ephemeral secret');
    localSecret = randomUUID();
  }

  // ── Services ───────────────────────────────────────────────────────────────
  await initLicense();
  await initUsage();
  await initTeam();
  await initTelemetry();
  await historyStore.init();
  await incidentStore.init();
  setBufferSizeGetter(() => getPlan(getActivePlanId()).bufferSize);

  // Wire team broadcast: events ingested by the sensor layer are fanned out
  // to all connected SSE peers that share the same team token.
  registerTeamBroadcaster(broadcastToTeam);

  // ── HTTP server ────────────────────────────────────────────────────────────
  const port = await findPort(PORT_RANGE_START, PORT_RANGE_END);
  const app = createApp({ serverVersion: SERVER_VERSION, localSecret, port, bindHost: BIND_HOST });
  const httpServer: HttpServer = app.listen(port, BIND_HOST, () => {
    logger.info({ port, host: BIND_HOST }, `HTTP ingest listening on http://${BIND_HOST}:${port}`);
  });

  // ── MCP stdio server ───────────────────────────────────────────────────────
  const mcp = new McpServer(
    { name: 'mergen', version: SERVER_VERSION },
    { instructions: SYSTEM_PROMPT },
  );
  registerTools(mcp);
  registerResources(mcp);
  registerPrompts(mcp);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info('MCP server ready (stdio transport)');

  // ── Update check (once per 24 h) ──────────────────────────────────────────
  checkForUpdates(SERVER_VERSION).then((latestVersion) => {
    if (latestVersion) {
      console.error(formatUpdateMessage(SERVER_VERSION, latestVersion));
    }
  }).catch(() => {
    // Silently ignore update check failures
  });

  // ── Telemetry tick (opt-in, throttled to once per 24 h) ───────────────────
  const telemetryTick = (): void => {
    void maybeSendTelemetry({
      serverVersion: SERVER_VERSION,
      nodeVersion: process.versions.node.split('.')[0],
      planId: getActivePlanId(),
      toolCallCounts,
      bufferedEvents: store.size(),
    });
  };
  setTimeout(telemetryTick, 60_000).unref();
  setInterval(telemetryTick, 60 * 60 * 1000).unref();

  // ── Continuous watcher ────────────────────────────────────────────────────
  startWatcher();

  // ── Container and process health monitoring ───────────────────────────────
  if (process.env.MERGEN_DOCKER_MONITOR === 'true') startDockerMonitor();
  if (process.env.MERGEN_DOCKER_LOGS   === 'true') void startDockerLogStream();
  startHeapMonitor();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  function shutdown(signal: string): void {
    logger.info({ signal }, 'shutting down');
    flushOverageOnShutdown().finally(() => {
      stopDockerMonitor();
      stopDockerLogStream();
      stopAllProcessWatchers();
      httpServer.close(() => { logger.info('HTTP server closed'); process.exit(0); });
      setTimeout(() => process.exit(1), 5_000).unref();
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
