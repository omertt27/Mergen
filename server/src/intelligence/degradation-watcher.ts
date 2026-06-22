/**
 * degradation-watcher.ts — Graduated urgency for the Passive Status Surface.
 *
 * Problem: the existing /health and doctor endpoints only surface "this started
 * failing N hours ago" when the developer checks. A real production-down event
 * and a minor warning get identical treatment: silent, wait for the dev.
 *
 * This module closes that gap without reintroducing alert fatigue:
 *
 *   - Polls the ring buffer every POLL_INTERVAL_MS
 *   - If error count in the last SEVERE_WINDOW_MS exceeds SEVERE_ERR_COUNT
 *     AND the degradation has persisted for SEVERE_DURATION_MS → one notification
 *   - One notification per sustained incident (de-duped by degradation start time)
 *   - Resets when error count drops below threshold
 *   - Never fires Slack / Discord / ntfy — stays local and passive by design
 *
 * Notification mechanism (no new deps):
 *   1. macOS:  osascript display notification
 *   2. Linux:  notify-send (if available)
 *   3. always: stderr with bell char (\x07) as universal fallback
 *
 * Thresholds are absolute error counts (not rate-relative) because baseline
 * comparison would require per-service traffic data not readily in the buffer.
 * Baseline-relative detection is a documented follow-up, not blocking.
 *
 * Configuration (all optional — conservative defaults ship out of the box):
 *   MERGEN_SEVERE_ERR_COUNT     errors in window to qualify as severe (default 10)
 *   MERGEN_SEVERE_WINDOW_MS     measurement window in ms (default 300000 = 5 min)
 *   MERGEN_SEVERE_DURATION_MS   sustained degradation before alerting (default 300000 = 5 min)
 *   MERGEN_DEGRADATION_WATCH    set to 'false' to disable entirely (default: enabled)
 */

import { exec } from 'child_process';
import { store } from '../sensor/buffer.js';
import logger from '../sensor/logger.js';

// ── Config ────────────────────────────────────────────────────────────────────

const ENABLED            = process.env.MERGEN_DEGRADATION_WATCH !== 'false';
const SEVERE_ERR_COUNT   = Math.max(1, parseInt(process.env.MERGEN_SEVERE_ERR_COUNT  ?? '10', 10));
const SEVERE_WINDOW_MS   = Math.max(60_000,  parseInt(process.env.MERGEN_SEVERE_WINDOW_MS  ?? '300000', 10));
const SEVERE_DURATION_MS = Math.max(60_000,  parseInt(process.env.MERGEN_SEVERE_DURATION_MS ?? '300000', 10));
const POLL_INTERVAL_MS   = 60_000;

// ── State ─────────────────────────────────────────────────────────────────────

// Unix ms when the current degradation window started. null = healthy.
let _degradedSince: number | null = null;
// The _degradedSince value we already notified for — prevents repeat fires.
let _notifiedForDegradedSince: number | null = null;

// Exported so /health can surface the current degradation state without polling.
export interface DegradationState {
  /** Whether the system is currently in a severe degradation window. */
  degraded: boolean;
  /** Unix ms when the current degradation started. null when healthy. */
  degradedSince: number | null;
  /** How many errors triggered the current degradation window. 0 when healthy. */
  errorCount: number;
  /** Human-readable "6 hours ago" string. null when healthy. */
  durationLabel: string | null;
}

let _lastState: DegradationState = {
  degraded: false,
  degradedSince: null,
  errorCount: 0,
  durationLabel: null,
};

export function getDegradationState(): DegradationState { return _lastState; }

// ── Notification ──────────────────────────────────────────────────────────────

function humanDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  const hours = Math.floor(minutes / 60);
  const rem   = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours} hour${hours !== 1 ? 's' : ''}`;
}

function fireNotification(errorCount: number, durationMs: number): void {
  const dur  = humanDuration(durationMs);
  const body = `${errorCount} errors in the last window — sustained for ${dur}. Check Mergen.`;
  const title = 'Mergen — Degradation Alert';

  // stderr fallback — always fires so something is visible even if desktop fails
  process.stderr.write(`\x07\n[MERGEN] ${title}: ${body}\n`);

  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: system notification center — no installation required
    const escaped = body.replace(/'/g, "'\\''");
    exec(`osascript -e 'display notification "${escaped}" with title "${title}" sound name "Submarine"'`, (err) => {
      if (err) logger.debug({ err }, 'degradation-watcher: osascript notification failed (stderr fallback used)');
    });
  } else if (platform === 'linux') {
    // Linux: notify-send (commonly installed on desktop distributions)
    const escaped = body.replace(/"/g, '\\"');
    exec(`notify-send "${title}" "${escaped}" --urgency=critical`, (err) => {
      if (err) logger.debug({ err }, 'degradation-watcher: notify-send failed (stderr fallback used)');
    });
  }
  // Windows: no clean zero-dep path — stderr fallback only
}

// ── Poll logic ────────────────────────────────────────────────────────────────

function poll(): void {
  const now = Date.now();
  const blastRadius = store.getBlastRadius({ since: now - SEVERE_WINDOW_MS });
  const errCount = blastRadius.errorCount;

  if (errCount >= SEVERE_ERR_COUNT) {
    // Degradation detected or ongoing
    if (_degradedSince === null) {
      _degradedSince = now;
      logger.debug({ errCount, threshold: SEVERE_ERR_COUNT }, 'degradation-watcher: severe degradation started');
    }

    const sustainedMs = now - _degradedSince;
    const label = humanDuration(now - _degradedSince);

    _lastState = {
      degraded: true,
      degradedSince: _degradedSince,
      errorCount: errCount,
      durationLabel: label,
    };

    // Fire one notification per sustained-incident-start
    if (sustainedMs >= SEVERE_DURATION_MS && _notifiedForDegradedSince !== _degradedSince) {
      _notifiedForDegradedSince = _degradedSince;
      logger.info({ errCount, sustainedMs, threshold: SEVERE_ERR_COUNT }, 'degradation-watcher: sustained severe degradation — firing notification');
      fireNotification(errCount, sustainedMs);
    }
  } else {
    // Healthy — reset incident tracking
    if (_degradedSince !== null) {
      logger.debug({ previousDegradedSince: _degradedSince }, 'degradation-watcher: degradation cleared');
    }
    _degradedSince = null;
    _notifiedForDegradedSince = null;
    _lastState = { degraded: false, degradedSince: null, errorCount: 0, durationLabel: null };
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;

export function startDegradationWatcher(): void {
  if (!ENABLED) {
    logger.debug('degradation-watcher: disabled via MERGEN_DEGRADATION_WATCH=false');
    return;
  }
  if (_timer !== null) return; // already running
  logger.debug(
    { severeErrCount: SEVERE_ERR_COUNT, severeWindowMs: SEVERE_WINDOW_MS, severeDurationMs: SEVERE_DURATION_MS },
    'degradation-watcher: started',
  );
  _timer = setInterval(poll, POLL_INTERVAL_MS);
  _timer.unref(); // don't prevent clean server shutdown
}

export function stopDegradationWatcher(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** For testing only — resets internal state. */
export function _resetWatcherForTesting(): void {
  _degradedSince = null;
  _notifiedForDegradedSince = null;
  _lastState = { degraded: false, degradedSince: null, errorCount: 0, durationLabel: null };
}