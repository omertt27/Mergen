/**
 * baseline.ts — Anomaly detection using time-bucketed historical error rates.
 *
 * Answers: "Is this error rate higher than normal for this time of day?"
 *
 * Method:
 *   1. Query the SQLite history store for all console errors in the last N days.
 *   2. Bucket them by (day-of-week × hour-of-day) — e.g. "Tuesday 2pm".
 *   3. Compute the mean and standard deviation per bucket.
 *   4. Compare the current hour's count to that bucket's normal range.
 *   5. Flag as anomaly when current > mean + 2σ (or mean × MIN_MULTIPLIER).
 *
 * The 7-day window means you need ~7 days of data for reliable baselines.
 * For fresh installs (< 7 days of data), we degrade gracefully: report the
 * raw counts and flag as "insufficient baseline data" without false positives.
 *
 * Dependencies: sqlite-store (read-only) + error-fingerprint (normalisation).
 */

import type { ConsoleEvent } from '../sensor/buffer.js';
import { normaliseMessage } from './error-fingerprint.js';
import logger from '../sensor/logger.js';

const BASELINE_DAYS       = 7;
const MIN_SAMPLES         = 5;    // need at least 5 hourly samples to trust the baseline
const ANOMALY_MULTIPLIER  = 3.0;  // current > 3× mean → anomaly
const ANOMALY_SIGMA       = 2.0;  // or current > mean + 2σ → anomaly

export interface BaselineResult {
  /** The error fingerprint this result covers. Empty string = all errors. */
  fingerprint: string;
  /** Errors/hour for the matching day-of-week + hour-of-day bucket. */
  normalRate: number;
  /** Errors in the current hour (last 60 minutes). */
  currentCount: number;
  /** currentCount / normalRate — >3 is anomalous. */
  multiplier: number;
  isAnomaly: boolean;
  /** True if there's not enough history to establish a reliable baseline. */
  insufficientData: boolean;
  /** Human-readable explanation. */
  summary: string;
}

/** Compute per-bucket (dow × hour) mean across historical events. */
function computeBucketMean(
  events: Array<{ timestamp: number }>,
  targetDow: number,
  targetHour: number,
): { mean: number; sigma: number; sampleCount: number } {
  // Group by date at the target (dow, hour) across all weeks in the data
  const countsPerDay = new Map<string, number>();

  for (const e of events) {
    const d = new Date(e.timestamp);
    if (d.getDay() !== targetDow) continue;
    if (d.getHours() !== targetHour) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    countsPerDay.set(key, (countsPerDay.get(key) ?? 0) + 1);
  }

  const counts = [...countsPerDay.values()];
  if (counts.length === 0) return { mean: 0, sigma: 0, sampleCount: 0 };

  const mean = counts.reduce((s, n) => s + n, 0) / counts.length;
  const variance = counts.reduce((s, n) => s + (n - mean) ** 2, 0) / counts.length;
  return { mean, sigma: Math.sqrt(variance), sampleCount: counts.length };
}

export async function computeAnomaly(
  historyEvents: ConsoleEvent[],  // from SQLite — last BASELINE_DAYS
  currentEvents: ConsoleEvent[],  // from ring buffer — last 60 min
  fingerprint = '',               // empty = all errors
): Promise<BaselineResult> {
  const now   = Date.now();
  const dow   = new Date(now).getDay();
  const hour  = new Date(now).getHours();

  // Filter to target fingerprint (or all errors if empty)
  const matchesFilter = (e: ConsoleEvent): boolean => {
    if (e.level !== 'error') return false;
    if (!fingerprint) return true;
    return normaliseMessage(e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')) === fingerprint;
  };

  const historicalFiltered = historyEvents.filter(matchesFilter);
  const currentFiltered    = currentEvents.filter(matchesFilter);

  const currentCount = currentFiltered.length;
  const { mean, sigma, sampleCount } = computeBucketMean(historicalFiltered, dow, hour);

  const insufficientData = sampleCount < MIN_SAMPLES;
  const normalRate = mean;

  let multiplier = 0;
  let isAnomaly  = false;

  if (!insufficientData && normalRate > 0) {
    multiplier = currentCount / normalRate;
    isAnomaly  = multiplier > ANOMALY_MULTIPLIER || currentCount > mean + ANOMALY_SIGMA * sigma;
  } else if (!insufficientData && normalRate === 0 && currentCount >= 3) {
    // Normal is zero but we're seeing errors now — always anomalous
    multiplier = Infinity;
    isAnomaly  = true;
  }

  const timeLabel = `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow]} ${hour}:00`;
  let summary: string;

  if (insufficientData) {
    summary = `${currentCount} error(s) this hour — baseline not yet established (need ${MIN_SAMPLES} days of data)`;
  } else if (isAnomaly) {
    const mStr = isFinite(multiplier) ? `${multiplier.toFixed(1)}×` : 'far above';
    summary = `${currentCount} error(s) this hour vs normal ${normalRate.toFixed(1)} on ${timeLabel} — ${mStr} above baseline 🚨`;
  } else {
    summary = `${currentCount} error(s) this hour — normal for ${timeLabel} (baseline: ~${normalRate.toFixed(1)}/hr)`;
  }

  logger.debug({ fingerprint: fingerprint || 'all', currentCount, normalRate, multiplier, isAnomaly }, 'baseline check');

  return { fingerprint, normalRate, currentCount, multiplier, isAnomaly, insufficientData, summary };
}

/**
 * Run baseline check across ALL distinct error fingerprints in the current buffer.
 * Returns only the anomalous ones, sorted by multiplier descending.
 */
export async function getAnomalousPatterns(
  historyEvents: ConsoleEvent[],
  currentEvents: ConsoleEvent[],
): Promise<BaselineResult[]> {
  const fps = [...new Set(
    currentEvents
      .filter((e) => e.level === 'error')
      .map((e) => normaliseMessage(e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '))),
  )];

  const results = await Promise.all(
    fps.map((fp) => computeAnomaly(historyEvents, currentEvents, fp)),
  );

  return results
    .filter((r) => r.isAnomaly && !r.insufficientData)
    .sort((a, b) => (isFinite(b.multiplier) ? b.multiplier : 999) - (isFinite(a.multiplier) ? a.multiplier : 999));
}
