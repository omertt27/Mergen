/**
 * calibration.ts — The accountability layer for the Hypothesis Engine.
 *
 * Why this exists (and why it's the most important file in the repo):
 *
 *   A senior engineer's first question is not "what does it claim" but
 *   "how do we know the claims are true?" If our system says HIGH and is
 *   wrong, trust collapses — and once it collapses we never get it back.
 *
 *   This module is the ground-truth feedback loop:
 *
 *     1. Every hypothesis we surface is logged with a stable `pid`
 *        (prediction id). The user (or VS Code, or the AI host) can later
 *        POST {pid, verdict: 'correct' | 'wrong' | 'partial'} to /feedback.
 *     2. We aggregate verdicts per-detector-tag to compute a calibration
 *        score: P(correct | this detector said HIGH).
 *     3. The `applyCalibration()` helper *demotes* (or culls) hypotheses
 *        from detectors with a track record below the trust threshold.
 *
 *   Net effect: a noisy detector that fires HIGH and is wrong 5x in a row
 *   automatically gets pushed down to MEDIUM/LOW or suppressed entirely.
 *   The user never has to disable anything; the system disciplines itself.
 *
 * Storage:
 *   ~/.mergen/calibration.json   — bounded ring of last N=500 verdicts
 *
 * Privacy:
 *   We store *tag* + *confidence* + *verdict* only. Never error messages,
 *   stack traces, URLs, or anything that could leak code/data. This file
 *   is safe to ship in `mergen doctor` bundles.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths.js';
import logger from './logger.js';
import type { Hypothesis, ConfidenceLevel } from './causal.js';

// ── Storage ─────────────────────────────────────────────────────────────────

const CALIBRATION_FILE = path.join(DATA_DIR, 'calibration.json');

/** Bounded ring — we never want this file to grow without limit. */
const MAX_VERDICTS = 500;

/** Minimum sample size before calibration affects ranking. Below this we
 * trust the detector's published confidence — small samples are noisy. */
const MIN_SAMPLES_FOR_TRUST = 5;

/** Below this empirical accuracy we demote a HIGH → MEDIUM. */
const DEMOTE_THRESHOLD = 0.50;
/** Below this we suppress entirely. A detector that's wrong 80%+ of the
 * time is actively harmful — better to show nothing than mislead. */
const SUPPRESS_THRESHOLD = 0.20;

/** Below this empirical accuracy a *trusted* detector should not be
 *  allowed to interrupt the user (status-bar warning, panel pop-out, etc).
 *  Untrusted detectors fall through — small samples are noisy and we still
 *  let them speak so they can earn or lose trust. */
export const MIN_INTERRUPT_ACCURACY = 0.60;

export type Verdict = 'correct' | 'wrong' | 'partial';

/** Free-form text the user can attach to a 'wrong' or 'partial' verdict to
 *  explain *why* the diagnosis missed. We surface the most-frequent notes
 *  per detector as `commonFailureModes` — turning silent failures into a
 *  visible "often incorrect when:" hint. PII-light: clamped to 140 chars. */
const MAX_NOTE_LEN = 140;

export interface PredictionRecord {
  /** Stable id used by /feedback to look up the prediction. */
  pid: string;
  /** Detector tag (e.g. "auth_token_not_persisted"). */
  tag: string;
  /** Confidence the detector assigned at prediction time. */
  confidence: ConfidenceLevel;
  /** When the prediction was issued (ms epoch). */
  predictedAt: number;
  /** User-supplied verdict, if any. */
  verdict?: Verdict;
  /** When the verdict landed (ms epoch). */
  verdictAt?: number;
  /** Optional user-supplied "why was this wrong" note (clamped). */
  note?: string;
}

interface CalibrationFile {
  version: 1;
  records: PredictionRecord[];
}

let _records: PredictionRecord[] = [];
let _loaded = false;

function load(): void {
  if (_loaded) return;
  _loaded = true;
  try {
    if (!fs.existsSync(CALIBRATION_FILE)) return;
    const raw = fs.readFileSync(CALIBRATION_FILE, 'utf8');
    const parsed = JSON.parse(raw) as CalibrationFile;
    if (parsed?.version === 1 && Array.isArray(parsed.records)) {
      _records = parsed.records.slice(-MAX_VERDICTS);
    }
  } catch (err) {
    logger.warn({ err }, 'calibration: failed to load, starting fresh');
    _records = [];
  }
}

function persist(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload: CalibrationFile = { version: 1, records: _records };
    // Atomic write — never leave a half-written calibration file.
    const tmp = CALIBRATION_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, CALIBRATION_FILE);
  } catch (err) {
    logger.warn({ err }, 'calibration: failed to persist');
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

let _pidCounter = 0;
function newPid(): string {
  _pidCounter += 1;
  return `${Date.now().toString(36)}-${_pidCounter.toString(36)}`;
}

/**
 * Tag a freshly-built list of hypotheses with stable prediction ids and
 * record them. Returns the same hypotheses with a `pid` field added.
 *
 * Idempotent: hypotheses that already have a `pid` are returned untouched
 * (so re-rendering the panel doesn't double-count).
 */
export function recordPrediction(hypotheses: Array<Hypothesis & { pid?: string }>): Array<Hypothesis & { pid: string }> {
  load();
  const now = Date.now();
  const tagged: Array<Hypothesis & { pid: string }> = [];
  for (const h of hypotheses) {
    if (h.pid) {
      tagged.push(h as Hypothesis & { pid: string });
      continue;
    }
    const pid = newPid();
    _records.push({
      pid,
      tag: h.tag,
      confidence: h.confidence,
      predictedAt: now,
    });
    tagged.push({ ...h, pid });
  }
  // Cap.
  if (_records.length > MAX_VERDICTS) {
    _records = _records.slice(-MAX_VERDICTS);
  }
  // Best-effort persist; failures are logged, never thrown.
  persist();
  return tagged;
}

/**
 * Record a verdict for a previously-issued prediction. Returns true if the
 * pid was found, false otherwise (so callers can return 404).
 *
 * `note` is an optional free-text explanation (only meaningful for `wrong`
 * or `partial`). Clamped to MAX_NOTE_LEN to keep the JSON file small and
 * to discourage accidentally pasting code/logs.
 */
export function recordVerdict(pid: string, verdict: Verdict, note?: string): boolean {
  load();
  const r = _records.find((x) => x.pid === pid);
  if (!r) return false;
  r.verdict = verdict;
  r.verdictAt = Date.now();
  if (note && (verdict === 'wrong' || verdict === 'partial')) {
    const trimmed = note.trim().slice(0, MAX_NOTE_LEN);
    if (trimmed) r.note = trimmed;
  }
  persist();
  return true;
}

/** Per-tag accuracy snapshot used by /calibration and applyCalibration. */
export interface TagStats {
  tag: string;
  predictions: number;
  verdicts: number;
  /** P(verdict === 'correct'). `partial` counts as 0.5. */
  accuracy: number;
  /** Are we above MIN_SAMPLES_FOR_TRUST? Below this, accuracy is advisory. */
  trusted: boolean;
  /** True iff `trusted && accuracy >= MIN_INTERRUPT_ACCURACY`. The status
   *  bar / nudge layer uses this to decide whether to grab attention. */
  shouldInterrupt: boolean;
  /** "Last 7 days" accuracy — same definition, narrower window. `null`
   *  when there aren't enough verdicts in the window to be meaningful. */
  accuracy7d: number | null;
  /** verdicts7d - verdicts pre-7d. Lets the panel render a tiny trend line
   *  ("up from 52% → 74% in 7 days"). `null` when no historical baseline. */
  trendDelta: number | null;
  /** Up to 3 most-frequent user-supplied "why was this wrong" notes, with
   *  occurrence counts. Powers the panel's "Often incorrect when:" hint —
   *  we don't just learn we were wrong, we explain *how* we were wrong. */
  commonFailureModes: Array<{ note: string; count: number }>;
}

export function getStats(): TagStats[] {
  load();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - SEVEN_DAYS_MS;

  // Aggregate twice: lifetime and last-7d. We do it in one pass for cache locality.
  const buckets = new Map<string, {
    preds: number; verdicts: number; score: number;
    verdicts7d: number; score7d: number;
    verdictsOld: number; scoreOld: number;
    notes: Map<string, number>;
  }>();
  for (const r of _records) {
    const b = buckets.get(r.tag) ?? {
      preds: 0, verdicts: 0, score: 0,
      verdicts7d: 0, score7d: 0,
      verdictsOld: 0, scoreOld: 0,
      notes: new Map<string, number>(),
    };
    b.preds += 1;
    if (r.verdict) {
      const credit = r.verdict === 'correct' ? 1 : r.verdict === 'partial' ? 0.5 : 0;
      b.verdicts += 1;
      b.score    += credit;
      const at = r.verdictAt ?? r.predictedAt;
      if (at >= cutoff) { b.verdicts7d += 1; b.score7d += credit; }
      else              { b.verdictsOld += 1; b.scoreOld += credit; }
      if (r.note) {
        b.notes.set(r.note, (b.notes.get(r.note) ?? 0) + 1);
      }
    }
    buckets.set(r.tag, b);
  }

  const out: TagStats[] = [];
  for (const [tag, b] of buckets) {
    const accuracy   = b.verdicts > 0 ? b.score / b.verdicts : 0;
    const accuracy7d = b.verdicts7d >= 3 ? b.score7d / b.verdicts7d : null;
    const accOld     = b.verdictsOld >= 3 ? b.scoreOld / b.verdictsOld : null;
    const trusted    = b.verdicts >= MIN_SAMPLES_FOR_TRUST;
    const commonFailureModes = [...b.notes.entries()]
      .sort((a, c) => c[1] - a[1])
      .slice(0, 3)
      .map(([note, count]) => ({ note, count }));
    out.push({
      tag,
      predictions: b.preds,
      verdicts: b.verdicts,
      accuracy,
      trusted,
      shouldInterrupt: trusted && accuracy >= MIN_INTERRUPT_ACCURACY,
      accuracy7d,
      trendDelta: accuracy7d !== null && accOld !== null ? accuracy7d - accOld : null,
      commonFailureModes,
    });
  }
  out.sort((a, b) => b.predictions - a.predictions);
  return out;
}

/** Convenience: stats for a single tag (or null if never predicted). */
export function getStatsForTag(tag: string): TagStats | null {
  return getStats().find((s) => s.tag === tag) ?? null;
}

/**
 * Apply learned calibration to a fresh list of hypotheses:
 *   • If a detector's empirical accuracy < SUPPRESS_THRESHOLD, drop it.
 *   • If it's < DEMOTE_THRESHOLD, downgrade HIGH→MEDIUM, MEDIUM→LOW.
 *   • Untrusted detectors (n < MIN_SAMPLES_FOR_TRUST) are passed through.
 *
 * This is the "self-discipline" loop: a detector that lies will quietly
 * be pushed below the fold instead of poisoning the user's first view.
 */
export function applyCalibration<T extends Hypothesis>(hypotheses: T[]): T[] {
  load();
  const stats = new Map(getStats().map((s) => [s.tag, s]));
  const out: T[] = [];
  for (const h of hypotheses) {
    const s = stats.get(h.tag);
    if (!s || !s.trusted) {
      out.push(h);
      continue;
    }
    if (s.accuracy < SUPPRESS_THRESHOLD) {
      // Detector is doing more harm than good — drop entirely.
      logger.info({ tag: h.tag, accuracy: s.accuracy }, 'calibration: suppressing untrusted detector');
      continue;
    }
    if (s.accuracy < DEMOTE_THRESHOLD) {
      const demoted = demote(h.confidence);
      out.push({ ...h, confidence: demoted, confidenceScore: h.confidenceScore * 0.5 });
      continue;
    }
    out.push(h);
  }
  return out;
}

function demote(c: ConfidenceLevel): ConfidenceLevel {
  switch (c) {
    case 'HIGH':         return 'MEDIUM';
    case 'MEDIUM':       return 'LOW';
    case 'LOW':          return 'INSUFFICIENT';
    case 'INSUFFICIENT': return 'INSUFFICIENT';
  }
}

/** Test-only reset. Never call from production paths. */
export function _resetForTesting(): void {
  _records = [];
  _loaded = true; // skip disk load on next call
}
