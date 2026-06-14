/**
 * Open-source stub for the closed-source calibration feedback-loop module.
 */

import { createHash, randomUUID } from 'crypto';
import type { Hypothesis } from './causal.js';

const MIN_SAMPLES = 5;
const DEMOTE_THRESHOLD   = 0.5;
const SUPPRESS_THRESHOLD = 0.2;
const FEEDBACK_TTL_MS    = 7 * 24 * 60 * 60 * 1000; // 7 days

export type VerdictDimension = string;

interface CalibrationRecord {
  pid:              string;
  tag:              string;
  confidence:       string;
  confidenceScore:  number;
  predictedAt:      Date;
  verdict:          'correct' | 'wrong' | 'partial' | null;
  verdictAt:        Date | null;
  note:             string | null;
  verdictDimension: string | null;
  expiresAt:        number;
}

let _records: CalibrationRecord[] = [];

export function _resetForTesting(): void {
  _records = [];
}

// ── recordPrediction ───────────────────────────────────────────────────────────

export type CalibratedHypothesis = Hypothesis & { pid: string; calibrationAction?: string };

export function recordPrediction(hypotheses: Hypothesis[]): CalibratedHypothesis[] {
  return hypotheses.map((h) => {
    const existing = h.pid
      ? _records.find((r) => r.pid === h.pid)
      : null;
    if (existing) return h as CalibratedHypothesis;

    const pid = randomUUID();
    _records.push({
      pid,
      tag:             h.tag,
      confidence:      h.confidence,
      confidenceScore: h.confidenceScore,
      predictedAt:     new Date(),
      verdict:         null,
      verdictAt:       null,
      note:            null,
      verdictDimension: null,
      expiresAt:       Date.now() + FEEDBACK_TTL_MS,
    });
    return { ...h, pid };
  });
}

// ── recordVerdict ──────────────────────────────────────────────────────────────

export function recordVerdict(
  pid: string,
  verdict: 'correct' | 'wrong' | 'partial',
  note?: string,
  dimension?: string,
): { found: boolean; persisted: boolean } {
  const rec = _records.find((r) => r.pid === pid);
  if (!rec) return { found: false, persisted: false };
  rec.verdict          = verdict;
  rec.verdictAt        = new Date();
  rec.note             = note ?? null;
  rec.verdictDimension = dimension ?? null;
  return { found: true, persisted: true };
}

// ── getRecords ─────────────────────────────────────────────────────────────────

export function getRecords(): CalibrationRecord[] {
  return [..._records];
}

// ── getStats ───────────────────────────────────────────────────────────────────

export interface TagStats {
  tag:                string;
  predictions:        number;
  verdicts:           number;
  accuracy:           number;
  trusted:            boolean;
  isEmpirical:        boolean;
  shouldInterrupt:    boolean;
  diagnosisAccuracy:  number;
  remediationAccuracy: number;
  trendDelta:         number | null;
  accuracy7d:         number | null;
  commonFailureModes: Array<{ note: string; count: number }>;
}

function normalizeNote(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, ' ');
}

function computeTagStats(tag: string, recs: CalibrationRecord[]): TagStats {
  const predictions = recs.length;
  const withVerdict = recs.filter((r) => r.verdict !== null);
  const verdicts    = withVerdict.length;

  let correct = 0;
  for (const r of withVerdict) {
    if (r.verdict === 'correct') correct += 1;
    else if (r.verdict === 'partial') correct += 0.5;
  }
  const accuracy = verdicts > 0 ? correct / verdicts : 0;
  const trusted  = verdicts >= MIN_SAMPLES;

  // Common failure modes — group by normalized note, use first occurrence as canonical form
  const noteGroups = new Map<string, { canonical: string; count: number }>();
  for (const r of withVerdict) {
    if (r.note && r.verdict === 'wrong') {
      const key = normalizeNote(r.note);
      const existing = noteGroups.get(key);
      if (existing) {
        existing.count++;
      } else {
        noteGroups.set(key, { canonical: r.note, count: 1 });
      }
    }
  }
  const commonFailureModes = [...noteGroups.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ canonical, count }) => ({ note: canonical, count }));

  return {
    tag,
    predictions,
    verdicts,
    accuracy,
    trusted,
    isEmpirical: trusted,
    shouldInterrupt: trusted && accuracy < SUPPRESS_THRESHOLD,
    diagnosisAccuracy: accuracy,
    remediationAccuracy: accuracy * 0.7,
    trendDelta: null,
    accuracy7d: null,
    commonFailureModes,
  };
}

export function getStats(): TagStats[] {
  const tagMap = new Map<string, CalibrationRecord[]>();
  for (const r of _records) {
    const list = tagMap.get(r.tag) ?? [];
    list.push(r);
    tagMap.set(r.tag, list);
  }
  return [...tagMap.entries()].map(([tag, recs]) => computeTagStats(tag, recs));
}

export function getGlobalStats(): null { return null; }

export function getStatsForTag(tag: string): TagStats | undefined {
  const recs = _records.filter((r) => r.tag === tag);
  if (recs.length === 0) return undefined;
  return computeTagStats(tag, recs);
}

// ── applyCalibration ───────────────────────────────────────────────────────────

export function applyCalibration(
  hypotheses: Hypothesis[],
): { active: CalibratedHypothesis[]; suppressed: CalibratedHypothesis[] } {
  const active: CalibratedHypothesis[] = [];
  const suppressed: CalibratedHypothesis[] = [];

  for (const h of hypotheses) {
    const stats = getStatsForTag(h.tag);

    if (!stats || !stats.trusted) {
      active.push({ ...h, calibrationAction: 'passed' } as CalibratedHypothesis);
      continue;
    }

    if (stats.accuracy >= DEMOTE_THRESHOLD) {
      active.push({ ...h, calibrationAction: 'passed' } as CalibratedHypothesis);
    } else if (stats.accuracy >= SUPPRESS_THRESHOLD) {
      const demoted: CalibratedHypothesis = {
        ...h,
        confidence:      h.confidence === 'HIGH' ? 'MEDIUM' : (h.confidence === 'MEDIUM' ? 'LOW' : 'LOW'),
        confidenceScore: h.confidenceScore * 0.5,
        calibrationAction: 'demoted',
      } as CalibratedHypothesis;
      active.push(demoted);
    } else {
      suppressed.push({ ...h, calibrationAction: 'suppressed' } as CalibratedHypothesis);
    }
  }

  return { active, suppressed };
}

// ── getPendingFeedback ─────────────────────────────────────────────────────────

export function getPendingFeedback(): Array<{ pid: string; expiresAt: number }> {
  const now = Date.now();
  return _records
    .filter((r) => r.verdict === null && r.expiresAt > now)
    .map((r) => ({ pid: r.pid, tag: r.tag, expiresAt: r.expiresAt }));
}

// ── seedCalibration ────────────────────────────────────────────────────────────

export function seedCalibration(
  tag: string,
  counts: { correct?: number; wrong?: number; partial?: number },
): void {
  const { correct = 0, wrong = 0, partial = 0 } = counts;

  const addRecords = (count: number, verdict: 'correct' | 'wrong' | 'partial') => {
    for (let i = 0; i < count; i++) {
      const pid = randomUUID();
      _records.push({
        pid,
        tag,
        confidence:       'HIGH',
        confidenceScore:  0.9,
        predictedAt:      new Date(Date.now() - 60_000),
        verdict,
        verdictAt:        new Date(),
        note:             null,
        verdictDimension: null,
        expiresAt:        Date.now() + FEEDBACK_TTL_MS,
      });
    }
  };

  addRecords(correct, 'correct');
  addRecords(wrong, 'wrong');
  addRecords(partial, 'partial');
}

// ── exportCsv ─────────────────────────────────────────────────────────────────

function csvQuote(s: string | null): string {
  if (s === null || s === undefined) return '';
  if (!/[",\n\r]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export function exportCsv(): string {
  const header = 'pid,tag,confidence,predictedAt,verdict,verdictAt,note,verdictDimension';
  const rows = _records.map((r) => [
    r.pid,
    r.tag,
    r.confidence,
    r.predictedAt.toISOString(),
    r.verdict ?? '',
    r.verdictAt ? r.verdictAt.toISOString() : '',
    csvQuote(r.note),
    r.verdictDimension ?? '',
  ].join(','));

  const dataBlock = rows.length > 0 ? rows.join('\n') : '';
  const sha256 = createHash('sha256').update(dataBlock).digest('hex');
  const comment = `# rows: ${rows.length}, sha256: ${sha256}`;

  if (rows.length === 0) return `${comment}\n${header}`;
  return `${comment}\n${header}\n${dataBlock}\n`;
}

export const CALIBRATION_CONFIG: Record<string, unknown> = {};
