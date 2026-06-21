/**
 * threshold-optimizer.ts — Derives the execution confidence threshold from the
 * calibration corpus using ROC analysis.
 *
 * The 85% threshold is NOT a constant. It is the threshold that maximizes
 * Youden's J statistic (TPR - FPR) on the historical verdict data.
 * With fewer than MIN_SAMPLE_SIZE verdicts, we fall back to 0.85.
 *
 * ROC methodology:
 *   For each candidate threshold t (0.50 … 0.95, step 0.05):
 *     TP = predictions with score ≥ t that received verdict 'correct'/'partial'
 *     FP = predictions with score ≥ t that received verdict 'wrong'
 *     TN = predictions with score < t that received verdict 'wrong'
 *     FN = predictions with score < t that received verdict 'correct'/'partial'
 *   TPR = TP / (TP + FN)   FPR = FP / (FP + TN)
 *   Youden's J = TPR - FPR
 *
 * Numeric scores: PredictionRecord now carries an optional numericScore field
 * (the raw confidenceScore from the Hypothesis). Historical records that lack
 * it use categorical band midpoints as proxies (LOW=0.55, MED=0.72, HIGH=0.92).
 */

import { getRecords } from './calibration.js';
import type { PredictionRecord } from './calibration.js';

export interface RocPoint {
  threshold: number;
  tpr: number;
  fpr: number;
  precision: number;
  f1: number;
  youdensJ: number;
}

const BAND_MIDPOINT: Record<string, number> = {
  LOW:  0.55,
  MED:  0.72,
  HIGH: 0.92,
};

const MIN_SAMPLE_SIZE = 20;
const CACHE_TTL_MS    = 10 * 60 * 1_000;

/**
 * The baseline execution confidence threshold.
 * Used as the ROC fallback (< 20 verdicts) and as the default in planning-gate /
 * triage_incident. Exported so every execution-path module uses the same value
 * rather than each defining its own 0.85 constant.
 */
export const DEFAULT_EXECUTION_THRESHOLD = 0.85;

let _cachedThreshold: number | null = null;
let _cacheTime = 0;

function scoreOf(r: PredictionRecord): number {
  return (r as PredictionRecord & { numericScore?: number }).numericScore
    ?? BAND_MIDPOINT[r.confidence]
    ?? 0.72;
}

export function computeRocCurve(): RocPoint[] {
  const verdicted = getRecords().filter((r) => r.verdict !== undefined);
  if (verdicted.length < MIN_SAMPLE_SIZE) return [];

  const samples = verdicted.map((r) => ({
    score:     scoreOf(r),
    isCorrect: r.verdict === 'correct' || r.verdict === 'partial',
  }));

  const points: RocPoint[] = [];
  for (let raw = 50; raw <= 95; raw += 5) {
    const threshold = raw / 100;
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const s of samples) {
      const predicted = s.score >= threshold;
      if (predicted  &&  s.isCorrect) tp++;
      if (predicted  && !s.isCorrect) fp++;
      if (!predicted && !s.isCorrect) tn++;
      if (!predicted &&  s.isCorrect) fn++;
    }
    const tpr       = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const fpr       = (fp + tn) > 0 ? fp / (fp + tn) : 0;
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall    = tpr;
    const f1        = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
    points.push({
      threshold,
      tpr:       Math.round(tpr       * 1000) / 1000,
      fpr:       Math.round(fpr       * 1000) / 1000,
      precision: Math.round(precision * 1000) / 1000,
      f1:        Math.round(f1        * 1000) / 1000,
      youdensJ:  Math.round((tpr - fpr) * 1000) / 1000,
    });
  }
  return points;
}

export function getExecutionThreshold(): number {
  const now = Date.now();
  if (_cachedThreshold !== null && now - _cacheTime < CACHE_TTL_MS) {
    return _cachedThreshold;
  }

  const curve = computeRocCurve();
  if (curve.length === 0) {
    _cachedThreshold = DEFAULT_EXECUTION_THRESHOLD;
    _cacheTime = now;
    return DEFAULT_EXECUTION_THRESHOLD;
  }

  const best = curve.reduce((a, b) => (b.youdensJ > a.youdensJ ? b : a));
  const derived = Math.min(0.95, Math.max(0.70, best.threshold));
  _cachedThreshold = derived;
  _cacheTime = now;
  return derived;
}

export function invalidateThresholdCache(): void {
  _cachedThreshold = null;
}
