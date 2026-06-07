/**
 * heartbeat-monitor.ts — Cron job and scheduled task monitoring.
 *
 * Solves the silent failure problem: a cron job that doesn't run produces
 * zero logs, zero errors, zero alerts. Engineers only find out when a report
 * is missing or data is stale.
 *
 * Usage (in your cron job or scheduled task):
 *
 *   curl -s http://localhost:3000/heartbeat/daily-backup
 *
 * If Mergen doesn't receive a ping within the configured interval + grace
 * period, it creates an incident and notifies your configured channels.
 *
 * Storage: ~/.mergen/heartbeats.json
 */

import fs from 'fs';
import { DATA_DIR } from './paths.js';
import logger from './logger.js';

const HEARTBEAT_FILE = `${DATA_DIR}/heartbeats.json`;
const CHECK_INTERVAL_MS = 60_000; // check every 60 seconds

export interface HeartbeatConfig {
  /** Unique name for this heartbeat (URL-safe). */
  name: string;
  /** Expected ping interval in seconds. Alert if silent longer than this + grace. */
  intervalSeconds: number;
  /** Extra seconds before alerting. Handles slow cron jobs. Default: 10% of interval. */
  graceSeconds: number;
  /** When the heartbeat was first registered (ms). */
  createdAt: number;
  /** When the last ping arrived (ms). null = never pinged. */
  lastPingAt: number | null;
  /** How many times we've successfully received a ping. */
  pingCount: number;
  /** When we last fired an alert for this heartbeat (ms). null = never alerted. */
  lastAlertedAt: number | null;
  /** Optional description shown in alerts. */
  description?: string;
}

type HeartbeatStatus = 'ok' | 'late' | 'missing' | 'never-pinged';

export interface HeartbeatReport extends HeartbeatConfig {
  status: HeartbeatStatus;
  secondsSinceLastPing: number | null;
  nextExpectedAt: number | null;
  overdueSeconds: number | null;
}

interface HeartbeatFile {
  version: 1;
  heartbeats: Record<string, HeartbeatConfig>;
}

// ── Storage ───────────────────────────────────────────────────────────────────

let _state: Record<string, HeartbeatConfig> = {};
let _loaded = false;

function load(): void {
  if (_loaded) return;
  _loaded = true;
  if (!fs.existsSync(HEARTBEAT_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8')) as HeartbeatFile;
    if (raw?.version === 1 && raw.heartbeats) _state = raw.heartbeats;
  } catch (err) {
    logger.warn({ err }, 'heartbeat-monitor: failed to load state — starting fresh');
  }
}

let _tmpCounter = 0;
function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload: HeartbeatFile = { version: 1, heartbeats: _state };
    _tmpCounter = (_tmpCounter + 1) >>> 0;
    const tmp = `${HEARTBEAT_FILE}.tmp.${process.pid}.${Date.now().toString(36)}.${_tmpCounter}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, HEARTBEAT_FILE);
  } catch (err) {
    logger.warn({ err }, 'heartbeat-monitor: persist failed');
  }
}

// ── Status computation ────────────────────────────────────────────────────────

function computeStatus(hb: HeartbeatConfig): HeartbeatReport {
  const now = Date.now();
  const deadline = (hb.intervalSeconds + hb.graceSeconds) * 1000;

  if (!hb.lastPingAt) {
    const age = now - hb.createdAt;
    return {
      ...hb,
      status: age > deadline ? 'never-pinged' : 'ok',
      secondsSinceLastPing: null,
      nextExpectedAt: hb.createdAt + deadline,
      overdueSeconds: age > deadline ? Math.round((age - deadline) / 1000) : null,
    };
  }

  const elapsed = now - hb.lastPingAt;
  const isLate = elapsed > hb.intervalSeconds * 1000;
  const isMissing = elapsed > deadline;

  return {
    ...hb,
    status: isMissing ? 'missing' : isLate ? 'late' : 'ok',
    secondsSinceLastPing: Math.round(elapsed / 1000),
    nextExpectedAt: hb.lastPingAt + hb.intervalSeconds * 1000,
    overdueSeconds: isMissing ? Math.round((elapsed - deadline) / 1000) : null,
  };
}

// ── Alert callback ────────────────────────────────────────────────────────────

// Set by startHeartbeatMonitor — avoids circular import with incident-autopilot
type AlertFn = (name: string, description: string) => void;
let _alertFn: AlertFn | null = null;

export function setHeartbeatAlertFn(fn: AlertFn): void {
  _alertFn = fn;
}

// ── Background monitor ────────────────────────────────────────────────────────

function checkHeartbeats(): void {
  load();
  const now = Date.now();
  for (const hb of Object.values(_state)) {
    const report = computeStatus(hb);
    if (report.status !== 'missing' && report.status !== 'never-pinged') continue;

    // Only alert once per interval — don't spam if the check keeps firing
    const alertCooldown = hb.intervalSeconds * 1000;
    if (hb.lastAlertedAt && now - hb.lastAlertedAt < alertCooldown) continue;

    const msg = report.status === 'never-pinged'
      ? `Heartbeat \`${hb.name}\` has never received a ping — expected within ${hb.intervalSeconds}s of registration.`
      : `Heartbeat \`${hb.name}\` missed — ${report.overdueSeconds}s overdue (interval: ${hb.intervalSeconds}s, grace: ${hb.graceSeconds}s).`;

    logger.warn({ name: hb.name, status: report.status, overdueSeconds: report.overdueSeconds }, 'heartbeat-monitor: missed heartbeat');

    if (_alertFn) _alertFn(hb.name, hb.description ? `${msg} — ${hb.description}` : msg);

    // Record that we alerted so we don't spam
    _state[hb.name] = { ...hb, lastAlertedAt: now };
    persist();
  }
}

let _checkHandle: ReturnType<typeof setInterval> | null = null;

export function startHeartbeatMonitor(): () => void {
  _checkHandle = setInterval(checkHeartbeats, CHECK_INTERVAL_MS);
  _checkHandle.unref();
  logger.info('heartbeat-monitor: started');
  return () => {
    if (_checkHandle) { clearInterval(_checkHandle); _checkHandle = null; }
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a ping for a heartbeat. Creates it if it doesn't exist.
 *
 * @param name             — URL-safe heartbeat name
 * @param intervalSeconds  — expected ping interval (default: 86400 = 24h)
 * @param graceSeconds     — grace period before alerting (default: 10% of interval)
 * @param description      — optional description for alerts
 */
export function ping(
  name: string,
  intervalSeconds = 86_400,
  graceSeconds?: number,
  description?: string,
): HeartbeatConfig {
  load();
  const grace = graceSeconds ?? Math.max(60, Math.round(intervalSeconds * 0.1));
  const existing = _state[name];
  const updated: HeartbeatConfig = {
    name,
    intervalSeconds,
    graceSeconds: grace,
    createdAt: existing?.createdAt ?? Date.now(),
    lastPingAt: Date.now(),
    pingCount: (existing?.pingCount ?? 0) + 1,
    lastAlertedAt: existing?.lastAlertedAt ?? null,
    description: description ?? existing?.description,
  };
  _state[name] = updated;
  persist();
  logger.debug({ name, pingCount: updated.pingCount }, 'heartbeat-monitor: ping received');
  return updated;
}

export function getReport(name: string): HeartbeatReport | null {
  load();
  const hb = _state[name];
  if (!hb) return null;
  return computeStatus(hb);
}

export function getAllReports(): HeartbeatReport[] {
  load();
  return Object.values(_state).map(computeStatus).sort((a, b) => {
    // Missing/never-pinged first, then alphabetical
    const order: Record<HeartbeatStatus, number> = { missing: 0, 'never-pinged': 1, late: 2, ok: 3 };
    return (order[a.status] - order[b.status]) || a.name.localeCompare(b.name);
  });
}

export function removeHeartbeat(name: string): boolean {
  load();
  if (!_state[name]) return false;
  delete _state[name];
  persist();
  return true;
}
