/**
 * gate-heartbeat.ts — fail-closed liveness contract for the local execution gate.
 *
 * This does not claim to prevent a same-user process from killing Mergen. That
 * requires OS-level privilege separation. It gives wrappers and guarded tool
 * calls a deterministic answer to: "is the gate that should authorize execution
 * currently alive and fresh?"
 */

import fs from 'fs';
import { DATA_DIR, zeroRetentionMode } from './paths.js';
import logger from './logger.js';

export const GATE_HEARTBEAT_FILE = `${DATA_DIR}/gate-heartbeat.json`;

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_MAX_AGE_MS = 10_000;

interface GateHeartbeat {
  version: 1;
  pid: number;
  startedAt: number;
  lastBeatAt: number;
}

let _lastBeatAt = 0;
let _startedAt = 0;
let _handle: ReturnType<typeof setInterval> | null = null;

function heartbeatIntervalMs(): number {
  const raw = Number(process.env.MERGEN_GATE_HEARTBEAT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? raw : DEFAULT_INTERVAL_MS;
}

export function gateHeartbeatMaxAgeMs(): number {
  const raw = Number(process.env.MERGEN_GATE_HEARTBEAT_MAX_AGE_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_MAX_AGE_MS;
}

export function requireGateHeartbeat(): boolean {
  return process.env.MERGEN_REQUIRE_GATE_HEARTBEAT === 'true';
}

function writeBeat(now = Date.now()): void {
  _lastBeatAt = now;
  if (_startedAt === 0) _startedAt = now;
  if (zeroRetentionMode()) return;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload: GateHeartbeat = {
      version: 1,
      pid: process.pid,
      startedAt: _startedAt,
      lastBeatAt: now,
    };
    const tmp = `${GATE_HEARTBEAT_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, GATE_HEARTBEAT_FILE);
  } catch (err) {
    logger.warn({ err }, 'gate-heartbeat: failed to write heartbeat');
  }
}

export function startGateHeartbeat(): () => void {
  if (_handle) return stopGateHeartbeat;
  writeBeat();
  _handle = setInterval(() => writeBeat(), heartbeatIntervalMs());
  _handle.unref();
  logger.info({ maxAgeMs: gateHeartbeatMaxAgeMs() }, 'gate-heartbeat: started');
  return stopGateHeartbeat;
}

export function stopGateHeartbeat(): void {
  if (_handle) {
    clearInterval(_handle);
    _handle = null;
  }
}

export function getGateHeartbeatStatus(now = Date.now()): {
  ok: boolean;
  required: boolean;
  lastBeatAt: number | null;
  ageMs: number | null;
  maxAgeMs: number;
  reason?: string;
} {
  const maxAgeMs = gateHeartbeatMaxAgeMs();
  let lastBeatAt = _lastBeatAt;

  if (!zeroRetentionMode() && fs.existsSync(GATE_HEARTBEAT_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(GATE_HEARTBEAT_FILE, 'utf8')) as Partial<GateHeartbeat>;
      if (raw.version === 1 && typeof raw.lastBeatAt === 'number') {
        lastBeatAt = Math.max(lastBeatAt, raw.lastBeatAt);
      }
    } catch {
      return {
        ok: false,
        required: requireGateHeartbeat(),
        lastBeatAt: lastBeatAt || null,
        ageMs: lastBeatAt ? now - lastBeatAt : null,
        maxAgeMs,
        reason: 'gate heartbeat file is unreadable',
      };
    }
  }

  if (!lastBeatAt) {
    return {
      ok: false,
      required: requireGateHeartbeat(),
      lastBeatAt: null,
      ageMs: null,
      maxAgeMs,
      reason: 'gate heartbeat has not started',
    };
  }

  const ageMs = now - lastBeatAt;
  if (ageMs > maxAgeMs) {
    return {
      ok: false,
      required: requireGateHeartbeat(),
      lastBeatAt,
      ageMs,
      maxAgeMs,
      reason: `gate heartbeat is stale (${ageMs}ms > ${maxAgeMs}ms)`,
    };
  }

  return {
    ok: true,
    required: requireGateHeartbeat(),
    lastBeatAt,
    ageMs,
    maxAgeMs,
  };
}

export function assertGateHeartbeatFresh(): { ok: true } | { ok: false; reason: string } {
  if (!requireGateHeartbeat()) return { ok: true };
  const status = getGateHeartbeatStatus();
  return status.ok ? { ok: true } : { ok: false, reason: status.reason ?? 'gate heartbeat is not fresh' };
}

export function _resetGateHeartbeatForTesting(lastBeatAt = 0): void {
  stopGateHeartbeat();
  _startedAt = lastBeatAt;
  _lastBeatAt = lastBeatAt;
}
