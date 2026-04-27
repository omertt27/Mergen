/**
 * telemetry.ts — Opt-in anonymous product telemetry (D6).
 *
 * What we collect (only when explicitly enabled):
 *   • A random anonymous installId (uuid v4, generated locally — no PII).
 *   • Counts of which MCP tools were invoked.
 *   • The active plan id ('free' / 'solo_standard' / etc.).
 *   • Server version + node major version.
 *
 * What we explicitly DO NOT collect:
 *   • No source code, log lines, network bodies, or Context Packs.
 *   • No license keys, emails, or names (we use only the anonymous installId).
 *   • No IP-based fingerprinting (the endpoint is invoked over the user's network).
 *   • No file paths or repo names.
 *
 * Default state: DISABLED. The user must opt in by setting MERGEN_TELEMETRY=1
 * in the env, or by POSTing { enabled: true } to /telemetry.
 *
 * On-disk file (`~/.mergen/telemetry.json`):
 *   { enabled: boolean, installId: string, lastSentAt: number | null }
 *
 * Send cadence: at most once per 24h, batched. Network failures are silent.
 *
 * The endpoint URL is configurable via MERGEN_TELEMETRY_URL — by default
 * we don't ship a live endpoint (so even if a user opts in by accident,
 * nothing leaves the machine until we explicitly enable a collector).
 */

import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { TELEMETRY_FILE, DATA_DIR } from './paths.js';
import logger from './logger.js';

interface TelemetryState {
  enabled: boolean;
  installId: string;
  lastSentAt: number | null;
}

const SEND_INTERVAL_MS = 24 * 60 * 60 * 1000;

let _state: TelemetryState = {
  enabled: false,
  installId: '',
  lastSentAt: null,
};

let _loaded = false;

async function _ensureLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await fs.readFile(TELEMETRY_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TelemetryState>;
    _state = {
      enabled: Boolean(parsed.enabled),
      installId: typeof parsed.installId === 'string' && parsed.installId.length > 0
        ? parsed.installId
        : randomUUID(),
      lastSentAt: typeof parsed.lastSentAt === 'number' ? parsed.lastSentAt : null,
    };
  } catch {
    _state = { enabled: false, installId: randomUUID(), lastSentAt: null };
  }
  // Env-var override always wins (CI / docker users can opt in without disk writes).
  if (process.env.MERGEN_TELEMETRY === '1') _state.enabled = true;
  if (process.env.MERGEN_TELEMETRY === '0') _state.enabled = false;
  await _persist();
}

async function _persist(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(TELEMETRY_FILE, JSON.stringify(_state, null, 2));
  } catch (err) {
    logger.warn({ err }, 'telemetry persist failed (non-fatal)');
  }
}

export async function initTelemetry(): Promise<void> {
  await _ensureLoaded();
}

export function getTelemetryState(): { enabled: boolean; installId: string; lastSentAt: number | null } {
  return { ..._state };
}

export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  await _ensureLoaded();
  _state.enabled = enabled;
  await _persist();
}

export interface TelemetrySnapshot {
  installId: string;
  serverVersion: string;
  nodeVersion: string;
  planId: string;
  toolCallCounts: Record<string, number>;
  bufferedEvents: number;
  ts: number;
}

/**
 * Send a telemetry snapshot — best effort, silent on failure.
 * Throttled to once per SEND_INTERVAL_MS so we don't hammer the endpoint.
 */
export async function maybeSendTelemetry(snapshot: Omit<TelemetrySnapshot, 'installId' | 'ts'>): Promise<boolean> {
  await _ensureLoaded();
  if (!_state.enabled) return false;

  const now = Date.now();
  if (_state.lastSentAt && (now - _state.lastSentAt) < SEND_INTERVAL_MS) return false;

  const url = process.env.MERGEN_TELEMETRY_URL;
  if (!url) return false; // no endpoint configured — opt-in is a no-op

  const payload: TelemetrySnapshot = {
    ...snapshot,
    installId: _state.installId,
    ts: now,
  };

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3_000),
    });
    _state.lastSentAt = now;
    await _persist();
    return true;
  } catch (err) {
    logger.debug({ err }, 'telemetry send failed (silent)');
    return false;
  }
}
