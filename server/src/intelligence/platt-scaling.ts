/**
 * platt-scaling.ts — Probability calibration for hypothesis confidence scores.
 *
 * The core enterprise trust problem: when Mergen says "85% confident", does that
 * actually mean 85 out of 100 historically similar predictions were correct?
 * If not, the number is marketing — not engineering.
 *
 * Platt scaling fits: P = sigmoid(A * f + B)
 * where f = raw confidence score (0–1) and A, B are learned from the verdict
 * corpus via maximum likelihood / gradient descent.
 *
 * After fitting:
 *   - plattScale(0.9) might return 0.82 if the model is overconfident
 *   - plattScale(0.5) might return 0.51 if the model is well-calibrated here
 *
 * Models are fit both globally (all tags) and per-tag (when ≥10 verdicts exist).
 * Calibrated scores are what get surfaced in Slack messages and the /trust-score
 * endpoint — the raw scores are used internally for ranking only.
 *
 * Reference: Platt, 1999 — "Probabilistic outputs for support vector machines".
 */

import { getRecords, getStats } from './calibration.js';
import path from 'path';
import fs from 'fs';
import { DATA_DIR } from '../sensor/paths.js';

const LEARNING_RATE = 0.1;
const EPOCHS        = 200;
const MIN_SAMPLES   = 10;
const CACHE_TTL_MS  = 5 * 60_000; // refit at most every 5 minutes
const FEDERATED_FILE = path.join(DATA_DIR, 'federated-calibration.json');

interface PlattParams {
  A: number;
  B: number;
  n: number;     // training set size
  holdoutAccuracy: number; // Leave-one-out cross validation accuracy
}

interface FederatedData {
  tags?: Record<string, { A: number; B: number; n: number; accuracy: number }>;
}

const _cache = new Map<string, { params: PlattParams; fittedAt: number }>();
let _federatedCache: FederatedData | null = null;
let _federatedLoadedAt = 0;

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** Return cached federated Platt params from ~/.mergen/federated-calibration.json */
function getFederatedParams(tag: string): PlattParams | null {
  const now = Date.now();
  if (!_federatedCache || now - _federatedLoadedAt > CACHE_TTL_MS) {
    try {
      if (fs.existsSync(FEDERATED_FILE)) {
        const raw = fs.readFileSync(FEDERATED_FILE, 'utf8');
        _federatedCache = JSON.parse(raw) as FederatedData;
        _federatedLoadedAt = now;
      } else {
        _federatedCache = { tags: {} };
      }
    } catch {
      _federatedCache = { tags: {} };
    }
  }
  if (_federatedCache && _federatedCache.tags && _federatedCache.tags[tag]) {
    const val = _federatedCache.tags[tag];
    return {
      A: val.A,
      B: val.B,
      n: val.n,
      holdoutAccuracy: val.accuracy,
    };
  }
  return null;
}

function fitPlattParams(
  samples: Array<{ score: number; isCorrect: boolean }>,
  y_pos: number,
  y_neg: number
): { A: number; B: number } {
  let A = -1.0;  // initialise with slight negative slope (scores tend to be overconfident)
  let B =  0.0;

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    let dA = 0, dB = 0;
    for (const { score, isCorrect } of samples) {
      const p = sigmoid(A * score + B);
      const y = isCorrect ? y_pos : y_neg;
      const err = p - y;
      dA += err * score;
      dB += err;
    }
    A -= LEARNING_RATE * dA / samples.length;
    B -= LEARNING_RATE * dB / samples.length;
  }
  return { A, B };
}

/**
 * Fit Platt parameters from (score, isCorrect) samples using SGD.
 * Returns null if fewer than MIN_SAMPLES are available.
 */
function fitPlatt(samples: Array<{ score: number; isCorrect: boolean }>): PlattParams | null {
  if (samples.length < MIN_SAMPLES) return null;

  // Platt label smoothing
  const N_pos = samples.filter((s) => s.isCorrect).length;
  const N_neg = samples.length - N_pos;
  const y_pos = (N_pos + 1) / (N_pos + 2);
  const y_neg = 1 / (N_neg + 2);

  // 1. Fit parameters A and B on the entire sample set
  const { A, B } = fitPlattParams(samples, y_pos, y_neg);

  // 2. Compute LOOCV holdout accuracy
  let looCorrect = 0;
  for (let i = 0; i < samples.length; i++) {
    const subset = samples.slice(0, i).concat(samples.slice(i + 1));
    const sub_N_pos = subset.filter((s) => s.isCorrect).length;
    const sub_N_neg = subset.length - sub_N_pos;
    const sub_y_pos = (sub_N_pos + 1) / (sub_N_pos + 2);
    const sub_y_neg = 1 / (sub_N_neg + 2);

    const { A: subA, B: subB } = fitPlattParams(subset, sub_y_pos, sub_y_neg);
    const target = samples[i];
    const p = sigmoid(subA * target.score + subB);
    const predictedCorrect = p >= 0.5;
    if (predictedCorrect === target.isCorrect) {
      looCorrect++;
    }
  }

  const holdoutAccuracy = looCorrect / samples.length;

  return { A, B, n: samples.length, holdoutAccuracy };
}

type ScoredRecord = ReturnType<typeof getRecords>[number] & { numericScore?: number; confidenceScore?: number };

function scoreOfRecord(r: ScoredRecord): number {
  return r.numericScore ?? r.confidenceScore ?? 0;
}

/** Return cached or freshly fit Platt params for a given tag (or 'global'). */
function getParams(tag: string): PlattParams | null {
  const now = Date.now();
  const cached = _cache.get(tag);
  if (cached && now - cached.fittedAt < CACHE_TTL_MS) return cached.params;

  const records = (getRecords() as ScoredRecord[]).filter(
    (r) => r.verdict !== null && (r.numericScore !== undefined || r.confidenceScore !== undefined),
  );

  let samples: Array<{ score: number; isCorrect: boolean }>;
  if (tag === 'global') {
    samples = records.map((r) => ({
      score: scoreOfRecord(r),
      isCorrect: r.verdict === 'correct' || r.verdict === 'partial',
    }));
  } else {
    samples = records
      .filter((r) => r.tag === tag)
      .map((r) => ({
        score: scoreOfRecord(r),
        isCorrect: r.verdict === 'correct' || r.verdict === 'partial',
      }));
  }

  const params = fitPlatt(samples);
  if (params) _cache.set(tag, { params, fittedAt: now });
  return params;
}

/**
 * Return a calibrated probability P(correct | rawScore, tag).
 *
 * Falls back gracefully:
 *   1. Per-tag Platt model (if ≥10 verdicts for this tag)
 *   2. Federated per-tag Platt model (loaded from federated calibration cache)
 *   3. Global Platt model (if ≥10 total verdicts)
 *   4. Tag's empirical accuracy from stats (if trusted)
 *   5. Raw score unchanged (no calibration data yet)
 */
export function plattScale(rawScore: number, tag?: string): {
  calibrated: number;
  source: 'tag-platt' | 'federated-platt' | 'global-platt' | 'empirical' | 'raw';
  n: number;
} {
  // Try per-tag model first
  if (tag) {
    const tagParams = getParams(tag);
    if (tagParams) {
      return {
        calibrated: Math.min(0.99, Math.max(0.01, sigmoid(tagParams.A * rawScore + tagParams.B))),
        source: 'tag-platt',
        n: tagParams.n,
      };
    }
  }

  // Try federated per-tag model
  if (tag) {
    const fedParams = getFederatedParams(tag);
    if (fedParams) {
      return {
        calibrated: Math.min(0.99, Math.max(0.01, sigmoid(fedParams.A * rawScore + fedParams.B))),
        source: 'federated-platt',
        n: fedParams.n,
      };
    }
  }

  // Fall back to global model
  const globalParams = getParams('global');
  if (globalParams) {
    return {
      calibrated: Math.min(0.99, Math.max(0.01, sigmoid(globalParams.A * rawScore + globalParams.B))),
      source: 'global-platt',
      n: globalParams.n,
    };
  }

  // Fall back to empirical tag accuracy
  if (tag) {
    const stats = getStats().find((s) => s.tag === tag);
    if (stats?.trusted) {
      return { calibrated: stats.accuracy, source: 'empirical', n: stats.verdicts };
    }
  }

  // No calibration data — return raw score unchanged
  return { calibrated: rawScore, source: 'raw', n: 0 };
}

/** Invalidate all cached Platt models (call after bulk verdict imports). */
export function invalidatePlattCache(): void {
  _cache.clear();
}

/** Diagnostic snapshot of all fitted models. */
export function getPlattDiagnostics(): Array<{
  tag: string; A: number; B: number; n: number; holdoutAccuracy: number;
}> {
  const now = Date.now();
  return [..._cache.entries()]
    .filter(([, v]) => now - v.fittedAt < CACHE_TTL_MS)
    .map(([tag, { params }]) => ({
      tag,
      A: params.A,
      B: params.B,
      n: params.n,
      holdoutAccuracy: params.holdoutAccuracy,
    }));
}
