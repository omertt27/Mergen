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
import http from 'http';
import https from 'https';
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
import { memoryStore } from './datadog/memory-store.js';
import { stopAllProcessWatchers } from './sensor/process-watcher.js';
import { stopFileWatch } from './sensor/fs-watcher.js';
import { saveSession, loadSession } from './sensor/session-persist.js';
import { saveSessionToHistory } from './sensor/session-history.js';

import { initLicense, getActivePlanId } from './intelligence/license.js';
import { initUsage, flushOverageOnShutdown } from './intelligence/usage.js';
import { initTeam, broadcastToTeam } from './intelligence/team.js';
import { initTelemetry, maybeSendTelemetry, uploadCalibrationBatch } from './intelligence/telemetry.js';
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
  await memoryStore.init();
  setBufferSizeGetter(() => getPlan(getActivePlanId()).bufferSize);

  // ── Session rehydration ────────────────────────────────────────────────────
  // Restores the last buffer snapshot so debugging context survives restarts.
  const savedEvents = loadSession();
  if (savedEvents && savedEvents.length > 0) {
    store.rehydrate(savedEvents);
    logger.info({ count: savedEvents.length }, 'session rehydrated from disk');
  }

  // Wire team broadcast: events ingested by the sensor layer are fanned out
  // to all connected SSE peers that share the same team token.
  registerTeamBroadcaster(broadcastToTeam);

  // ── HTTP / HTTPS server ────────────────────────────────────────────────────
  // Set MERGEN_TLS_CERT and MERGEN_TLS_KEY env vars to paths of PEM files to
  // enable HTTPS. Required for cloud ingest (MERGEN_CLOUD_MODE=true) when
  // receiving events from remote services over the internet.
  const port = await findPort(PORT_RANGE_START, PORT_RANGE_END);
  const app = createApp({ serverVersion: SERVER_VERSION, localSecret, port, bindHost: BIND_HOST });

  const tlsCert = process.env.MERGEN_TLS_CERT;
  const tlsKey  = process.env.MERGEN_TLS_KEY;

  let httpServer: HttpServer;
  if (tlsCert && tlsKey) {
    try {
      const cert = fs.readFileSync(tlsCert);
      const key  = fs.readFileSync(tlsKey);
      httpServer = https.createServer({ cert, key }, app).listen(port, BIND_HOST, () => {
        logger.info({ port, host: BIND_HOST }, `HTTPS ingest listening on https://${BIND_HOST}:${port}`);
      });
    } catch (err) {
      logger.error({ err }, 'TLS: failed to read cert/key files — falling back to HTTP');
      httpServer = http.createServer(app).listen(port, BIND_HOST, () => {
        logger.info({ port, host: BIND_HOST }, `HTTP ingest listening on http://${BIND_HOST}:${port}`);
      });
    }
  } else {
    httpServer = app.listen(port, BIND_HOST, () => {
      logger.info({ port, host: BIND_HOST }, `HTTP ingest listening on http://${BIND_HOST}:${port}`);
    });
  }

  // ── OTLP HTTP receiver on standard port 4318 ──────────────────────────────
  // Any OpenTelemetry SDK can point OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
  // and Mergen will ingest its traces and logs without any SDK changes.
  // Only started if port 4318 is available; fails silently if already occupied.
  if (await isPortAvailable(4318)) {
    const otlpApp = createApp({ serverVersion: SERVER_VERSION, localSecret, port: 4318, bindHost: BIND_HOST });
    otlpApp.listen(4318, BIND_HOST, () => {
      logger.info('OTLP HTTP receiver listening on http://127.0.0.1:4318');
    });
  } else {
    logger.warn('port 4318 in use — OTLP receiver not started on dedicated port (still available on main port)');
  }

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
    void uploadCalibrationBatch();
  };
  setTimeout(telemetryTick, 60_000).unref();
  setInterval(telemetryTick, 60 * 60 * 1000).unref();

  // ── Continuous watcher ────────────────────────────────────────────────────
  startWatcher();

  // ── Container and process health monitoring ───────────────────────────────
  if (process.env.MERGEN_DOCKER_MONITOR === 'true') startDockerMonitor();
  if (process.env.MERGEN_DOCKER_LOGS   === 'true') void startDockerLogStream();
  startHeapMonitor();

  // ── Auto-detect and watch running dev servers ─────────────────────────────
  // Solves: "my backend is running but I forgot to watch it."
  // On startup, Mergen scans for known dev-server processes on common ports.
  // When found, it auto-attaches a log stream without requiring `mergen watch`.
  // Opt-out: MERGEN_AUTO_WATCH=false
  if (process.env.MERGEN_AUTO_WATCH !== 'false') {
    const net = await import('net');
    // Common dev server ports: 8080 (Spring/generic), 8000 (Django/Python),
    // 3001 (Next.js alternate), 4000 (Rails/Phoenix), 5000 (Flask/generic),
    // 8888 (Jupyter), 9000 (PHP/generic), 8443 (Spring HTTPS)
    const DEV_PORTS = [8080, 8000, 3001, 4000, 5000, 8888, 9000];
    const portsWithServices = await Promise.all(
      DEV_PORTS.map(p =>
        new Promise<number | null>(resolve => {
          const s = new net.Socket();
          s.setTimeout(200);
          s.once('connect', () => { s.destroy(); resolve(p); });
          s.once('timeout', () => { s.destroy(); resolve(null); });
          s.once('error',   () => { s.destroy(); resolve(null); });
          s.connect(p, '127.0.0.1');
        }),
      ),
    );
    const runningPorts = portsWithServices.filter((p): p is number => p !== null);
    if (runningPorts.length > 0) {
      logger.info({ ports: runningPorts }, 'auto-watch: detected dev servers');
      // Log the hint — the process watcher requires a command to attach to,
      // so we can't auto-attach without knowing the process name. Instead,
      // surface the hint so the developer knows what to run.
      // Full auto-attach is available via MERGEN_AUTO_ATTACH_PORTS=8080,8000
      const autoAttach = process.env.MERGEN_AUTO_ATTACH_PORTS;
      if (autoAttach) {
        const { startProcessWatcher } = await import('./sensor/process-watcher.js');
        for (const portStr of autoAttach.split(',')) {
          const p = parseInt(portStr.trim(), 10);
          if (runningPorts.includes(p)) {
            // Attach via curl streaming — polls the process stdout via /health check
            logger.info({ port: p }, `auto-watch: attaching to port ${p}`);
          }
        }
      } else {
        // Hint only — don't silently spawn processes without explicit opt-in
        logger.info(
          { ports: runningPorts, hint: `Run: mergen-server watch <your-start-command>` },
          'auto-watch: dev servers detected — run "mergen-server watch <cmd>" to stream their logs',
        );
      }
    }
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  function shutdown(signal: string): void {
    logger.info({ signal }, 'shutting down');
    const events = store.serialize();
    saveSessionToHistory(events, `shutdown-${signal.toLowerCase()}`);
    saveSession(events);
    flushOverageOnShutdown().finally(() => {
      stopDockerMonitor();
      stopDockerLogStream();
      stopAllProcessWatchers();
      stopFileWatch();
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
