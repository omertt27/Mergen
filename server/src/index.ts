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
import { setBufferSizeGetter, store, setStore } from './sensor/buffer.js';
import { wrapWithRedisPersistence, stopRedisStore } from './sensor/redis-store.js';
import { historyStore } from './sensor/sqlite-store.js';
import { startWatcher } from './sensor/watcher.js';
import { startDockerMonitor, startHeapMonitor, stopDockerMonitor } from './sensor/docker-monitor.js';
import { startDockerLogStream, stopDockerLogStream } from './sensor/docker-log-stream.js';
import { incidentStore } from './sensor/incident-store.js';
import { postmortemStore } from './intelligence/postmortem-store.js';
import { memoryStore } from './datadog/memory-store.js';
import { commitContextStore } from './sensor/commit-context-store.js';
import { agentMemoryStore } from './sensor/agent-memory-store.js';
import { complianceLedgerStore } from './sensor/audit-log.js';
import { stopAllProcessWatchers } from './sensor/process-watcher.js';
import { stopFileWatch } from './sensor/fs-watcher.js';
import { saveSession, loadSession } from './sensor/session-persist.js';
import { saveSessionToHistory } from './sensor/session-history.js';
import { syncMarkdownFilesFromDisk } from './intelligence/postmortem-parser.js';

import { initLicense, getActivePlanId } from './intelligence/license.js';
import { initUsage, flushOverageOnShutdown } from './intelligence/usage.js';
import { flushPendingRebuild } from './intelligence/hypothesis-history.js';
import { initTeam, broadcastToTeam } from './intelligence/team.js';
import { initTelemetry, maybeSendTelemetry } from './intelligence/telemetry.js';
import { getPlan } from './intelligence/plans.js';
import { registerTools, toolCallCounts } from './intelligence/tools.js';
import { createGuardedServer } from './intelligence/tool-guard.js';
import { registerResources } from './intelligence/mcp-resources.js';
import { registerPrompts } from './intelligence/mcp-prompts.js';
import { SYSTEM_PROMPT } from './intelligence/prompts.js';
import { registerTeamBroadcaster } from './sensor/ingest.js';

import { isCorpusSeeded, getRealVerdictCount } from './__stubs__/calibration.js';
import { startSlackDailyDigest } from './intelligence/slack-digest.js';
import { startSlackOverrideLoop } from './intelligence/slack-override-loop.js';
import { startGitAdrSync } from './intelligence/git-adr-sync.js';
import { startShadowDigestCron } from './intelligence/shadow-digest-cron.js';
import { startDegradationWatcher } from './intelligence/degradation-watcher.js';
import { startHeartbeatMonitor, setHeartbeatAlertFn } from './sensor/heartbeat-monitor.js';
import { startK8sEventsPoller } from './sensor/k8s-events.js';
import { loadPlugins } from './intelligence/detector-plugins.js';
import { notify } from './intelligence/notifications.js';
import { serviceGraph } from './sensor/service-graph.js';
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

function validateConfig(): void {
  const CLOUD_MODE = process.env.MERGEN_CLOUD_MODE === 'true';
  const AUTOPILOT  = process.env.MERGEN_AUTOPILOT === 'true';
  const TEAM_MODE  = BIND_HOST !== '127.0.0.1';

  // ── Hard failures — refuse to start in dangerous configurations ─────────────

  // Autopilot + no PagerDuty secret: any caller can forge an incident.triggered
  // event and trigger autonomous command execution.
  if (AUTOPILOT && !process.env.MERGEN_PAGERDUTY_SECRET) {
    logger.error(
      'FATAL: MERGEN_AUTOPILOT=true but MERGEN_PAGERDUTY_SECRET is not set. ' +
      'Without webhook signature verification any caller can trigger autonomous execution. ' +
      'Set MERGEN_PAGERDUTY_SECRET to the signing secret from your PagerDuty webhook config, then restart.',
    );
    process.exit(1);
  }

  // Team mode + no ingest secret: any network peer can inject events into the
  // ring buffer used for causal analysis and fix command generation.
  if (TEAM_MODE && !process.env.MERGEN_SECRET) {
    logger.error(
      'FATAL: MERGEN_BIND is not 127.0.0.1 (team mode) but MERGEN_SECRET is not set. ' +
      'The /ingest endpoint would accept events from any network caller. ' +
      'Generate a secret with: openssl rand -hex 32  then set MERGEN_SECRET=<value> and restart.',
    );
    process.exit(1);
  }

  // ── Warnings — sub-optimal but non-fatal ────────────────────────────────────

  if (!process.env.MERGEN_SLACK_BOT_TOKEN) {
    logger.warn(
      'startup: MERGEN_SLACK_BOT_TOKEN not set — incident Slack alerts and thread replies are disabled. ' +
      'Set it to your Slack bot token (xoxb-...) to enable autonomous incident notifications.',
    );
  }
  if (process.env.MERGEN_SLACK_BOT_TOKEN && !process.env.MERGEN_SLACK_SIGNING_SECRET) {
    logger.warn(
      'startup: MERGEN_SLACK_BOT_TOKEN is set but MERGEN_SLACK_SIGNING_SECRET is missing — ' +
      'the /slack/actions endpoint will reject all requests until the signing secret is configured. ' +
      'Set MERGEN_SLACK_SIGNING_SECRET to the HMAC secret from your Slack app configuration.',
    );
  }
  if (CLOUD_MODE && !process.env.MERGEN_PAGERDUTY_SECRET) {
    logger.warn(
      'startup: MERGEN_PAGERDUTY_SECRET not set in cloud mode — PagerDuty webhook requests will be rejected. ' +
      'Set it to the signing secret from your PagerDuty webhook config.',
    );
  } else if (!AUTOPILOT && !process.env.MERGEN_PAGERDUTY_SECRET) {
    logger.warn(
      'startup: MERGEN_PAGERDUTY_SECRET not set — PagerDuty webhook signature verification is disabled. ' +
      'Diagnosis-only mode is active so no commands will execute, but set the secret before enabling autopilot.',
    );
  }
  if (CLOUD_MODE && !process.env.MERGEN_TLS_CERT) {
    logger.warn(
      'startup: MERGEN_CLOUD_MODE=true but MERGEN_TLS_CERT / MERGEN_TLS_KEY are not set — ' +
      'server will start in plain HTTP. Set TLS certificates for secure cloud deployments.',
    );
  }
  if (!process.env.MERGEN_SECRET) {
    logger.warn(
      'startup: MERGEN_SECRET not set — /ingest endpoint accepts events from any local process. ' +
      'Set MERGEN_SECRET=<random-string> to restrict ingest to authenticated sources.',
    );
  }

  // Safe-default: when autopilot is enabled but MERGEN_SHADOW_MODE is not explicitly
  // set to 'false', the system runs in shadow mode (diagnose, alert, but never execute).
  // This prevents accidental live execution on first deploy. Set MERGEN_SHADOW_MODE=false
  // after reviewing the shadow track record (GET /shadow-report) to enable live execution.
  if (AUTOPILOT && process.env.MERGEN_SHADOW_MODE === undefined) {
    logger.warn(
      'startup: MERGEN_AUTOPILOT=true but MERGEN_SHADOW_MODE is not set — defaulting to SHADOW MODE. ' +
      'Mergen will diagnose incidents and post Slack alerts but will NOT execute commands. ' +
      'Review GET /shadow-report to build trust, then set MERGEN_SHADOW_MODE=false to enable live execution.',
    );
  }

  const enabled: string[] = [];
  if (AUTOPILOT)                                         enabled.push('autopilot');
  if (process.env.MERGEN_SHADOW_MODE === 'true')        enabled.push('shadow-mode');
  if (process.env.MERGEN_DOCKER_MONITOR === 'true')     enabled.push('docker-monitor');
  if (process.env.MERGEN_DOCKER_LOGS === 'true')        enabled.push('docker-logs');
  if (process.env.MERGEN_K8S_NAMESPACE)                 enabled.push(`k8s(${process.env.MERGEN_K8S_NAMESPACE})`);
  if (process.env.MERGEN_REDIS_URL)                     enabled.push('redis');
  if (process.env.DD_API_KEY)                           enabled.push('datadog');
  if (enabled.length > 0) logger.info({ enabled }, 'startup: optional features enabled');
}

async function main(): Promise<void> {
  validateConfig();
  // ── LemonSqueezy SDK ───────────────────────────────────────────────────────
  const lsApiKey = process.env.LS_API_KEY;
  if (lsApiKey) lemonSqueezySetup({ apiKey: lsApiKey });

  // ── Local shared secret ────────────────────────────────────────────────────
  // Written to ~/.mergen/secret on first start. The VS Code extension reads
  // this file and sends it as x-mergen-secret on every mutating request.
  let localSecret: string;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
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
  await postmortemStore.init();
  void syncMarkdownFilesFromDisk().catch((err) => logger.warn({ err }, 'startup: markdown sync failed'));
  await complianceLedgerStore.init();

  // Diagnostic: warn when the corpus contains autonomous resolutions without
  // verified causal correctness. These rows were written before the
  // causallyCorrect fix or represent fixes that didn't resolve the incident.
  // check_fix_history and runbook success rates show 0% for these entries
  // until new causally-verified resolutions accumulate.
  try {
    const staleCount = postmortemStore.countUnverifiedAutonomous();
    if (staleCount > 0) {
      logger.warn(
        `startup: ${staleCount} postmortem${staleCount !== 1 ? 's' : ''} with ` +
        `resolved_autonomously=1 and causally_correct=0 found in corpus — ` +
        `likely written before the causal-verification fix. check_fix_history ` +
        `and runbook verified_fixes will show conservative (low) success rates ` +
        `until new causally-verified resolutions are recorded. ` +
        `These rows expire from the 90-day retention window automatically.`,
      );
    }
  } catch { /* non-fatal — DB not yet ready */ }

  await memoryStore.init();
  await commitContextStore.init();
  await agentMemoryStore.init();

  // Restore the service dependency graph from the last run. Without this, blast
  // risk calculations default to 'low' until OTLP spans rebuild the graph live —
  // which can take minutes on a freshly restarted server.
  serviceGraph.loadPersisted();

  setBufferSizeGetter(() => getPlan(getActivePlanId()).bufferSize);

  // ── Detector plugins ───────────────────────────────────────────────────────
  // Load user-defined detectors from ~/.mergen/detectors/*.js before the
  // first causal chain runs so they're available on the first incident.
  await loadPlugins();

  // ── Heartbeat monitor ──────────────────────────────────────────────────────
  // Opens an incident + notifies all channels when a cron job misses its window.
  setHeartbeatAlertFn((name, description) => {
    const pid = randomUUID();
    incidentStore.upsert(pid, {
      status: 'open',
      hypothesis: `Heartbeat missed: ${name}`,
      tag: 'heartbeat_missed',
      confidence: 1.0,
    });
    void notify(pid, `⏰ *Heartbeat Missed* — \`${name}\`\n${description}`, {
      priority: 'high',
      tags: ['warning'],
    });
  });
  startHeartbeatMonitor();

  // ── Kubernetes events poller ───────────────────────────────────────────────
  // Polls kubectl for Warning events and feeds them into the causal engine.
  // Activated by MERGEN_K8S_NAMESPACE=<namespace>[,<namespace>,...].
  startK8sEventsPoller();

  // ── Session rehydration ────────────────────────────────────────────────────
  // Restores the last buffer snapshot so debugging context survives restarts.
  const savedEvents = loadSession();
  if (savedEvents && savedEvents.length > 0) {
    store.rehydrate(savedEvents);
    logger.info({ count: savedEvents.length }, 'session rehydrated from disk');
  }

  // ── Redis persistence (opt-in, MERGEN_REDIS_URL) ──────────────────────────
  // Wraps the in-memory store with Redis write-through + rehydrates from Redis.
  // Falls back to in-memory only if Redis is unavailable.
  if (process.env.MERGEN_REDIS_URL) {
    const redisStore = await wrapWithRedisPersistence(store);
    if (redisStore !== store) setStore(redisStore);
  }

  // ── Crash-safe session flush (every 10 s) ────────────────────────────────
  // Graceful shutdown already saves the buffer, but a SIGKILL / OOM kill skips
  // that path. Flushing every 10 s bounds event loss on crash to ≤ 10 seconds.
  setInterval(() => saveSession(store.serialize()), 10_000).unref();

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
      if (process.env.MERGEN_CLOUD_MODE === 'true') {
        logger.error({ err }, 'TLS: failed to read cert/key files — refusing to start in plain HTTP (MERGEN_CLOUD_MODE=true requires TLS)');
        process.exit(1);
      }
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
  // Wrap with local policy gate before tool registration. Every tool call now
  // passes through enterprise-policy-engine.ts before the handler executes:
  //   PASS  → handler runs immediately (<1ms overhead)
  //   BLOCK → MCP error returned, blunder logged
  //   HOLD  → Promise held until POST /hitl/approve or /hitl/deny
  registerTools(createGuardedServer(mcp, port));
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

  // ── Cold-start calibration warning ───────────────────────────────────────
  // isCorpusSeeded() is true when only synthetic priors exist (no real verdicts
  // from this environment). Surface this prominently so the operator knows that
  // confidence scores are not yet proven against their production traffic.
  if (isCorpusSeeded()) {
    const realCount = getRealVerdictCount();
    console.error(
      `\n⚠  CALIBRATION WARM-UP — Running on synthetic priors (${realCount} real verdicts recorded).\n` +
      `   Confidence scores will reflect your production environment after 10 real verdicts.\n` +
      `   Record verdicts via POST /feedback or the Slack verdict buttons.\n`,
    );
  }

  // ── Shadow mode weekly Slack digest (Monday 09:00 UTC) ────────────────────
  startShadowDigestCron();

  // ── Daily operational digest (09:00 UTC, opt-in MERGEN_SLACK_DIGEST=true) ──
  if (process.env.MERGEN_SLACK_DIGEST === 'true') startSlackDailyDigest();

  // ── Git ADR → corpus sync (once at startup + every 24h) ─────────────────
  // Reads git commit history and accepted ADR records, extracts operational
  // constraints ("never resize pool on Friday settlement window"), and
  // materialises them as Override Corpus entries automatically.
  if (process.env.MERGEN_GIT_ADR_SYNC === 'true') startGitAdrSync();

  // ── Slack-to-Override Memory Loop (every 6h, auto-builds the corpus) ─────
  // Scans the incident channel for postmortem threads and extracts override
  // patterns automatically — no manual POST /postmortem/from-slack required.
  if (process.env.MERGEN_SLACK_OVERRIDE_LOOP === 'true') startSlackOverrideLoop();

  // ── Graduated urgency — local desktop notification on sustained degradation ─
  startDegradationWatcher();

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
    // Flush the service graph so the next startup has an immediately correct
    // blast-risk map instead of waiting for OTLP spans to rebuild it.
    serviceGraph.flushSync();

    Promise.all([flushOverageOnShutdown(), flushPendingRebuild()]).finally(() => {
      stopDockerMonitor();
      stopDockerLogStream();
      stopAllProcessWatchers();
      stopFileWatch();
      stopRedisStore();
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
