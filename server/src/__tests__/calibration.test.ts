/**
 * calibration.test.ts — Proves that the self-discipline loop works.
 *
 * The accountability rules:
 *   • Untrusted detector (n < 5)        → pass-through, no demotion.
 *   • accuracy ≥ 50%                    → pass-through.
 *   • 20% ≤ accuracy < 50%              → demote one band.
 *   • accuracy < 20%                    → suppress entirely.
 *
 * If any of these regress, the "Is the signal actually good?" guarantee
 * is broken and we have to ship a fix before the next release.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordPrediction,
  recordVerdict,
  applyCalibration,
  getStats,
  exportCsv,
  getPendingFeedback,
  seedCalibration,
  _resetForTesting,
} from '../intelligence/calibration.js';
import type { Hypothesis } from '../intelligence/causal.js';

function fakeHyp(tag: string, confidence: Hypothesis['confidence'] = 'HIGH'): Hypothesis {
  return {
    tag,
    summary: `summary for ${tag}`,
    confidence,
    confidenceScore: confidence === 'HIGH' ? 0.9 : confidence === 'MEDIUM' ? 0.6 : 0.3,
    evidence: [],
    causalPath: [],
    fixHint: null,
  };
}

beforeEach(() => _resetForTesting());

describe('calibration', () => {
  it('assigns stable pids and persists predictions', () => {
    const tagged = recordPrediction([fakeHyp('a'), fakeHyp('b')]);
    expect(tagged).toHaveLength(2);
    expect(tagged[0].pid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(tagged[1].pid).not.toBe(tagged[0].pid);

    // Idempotent — re-recording an already-tagged hypothesis keeps its pid.
    const again = recordPrediction(tagged);
    expect(again[0].pid).toBe(tagged[0].pid);
  });

  it('records verdicts and reflects them in /calibration stats', () => {
    const tagged = recordPrediction([fakeHyp('x'), fakeHyp('x'), fakeHyp('y')]);
    expect(recordVerdict(tagged[0].pid!, 'correct')).toMatchObject({ found: true });
    expect(recordVerdict(tagged[1].pid!, 'wrong')).toMatchObject({ found: true });
    expect(recordVerdict('not-a-real-pid', 'correct')).toMatchObject({ found: false });

    const stats = getStats();
    const x = stats.find((s) => s.tag === 'x')!;
    expect(x.predictions).toBe(2);
    expect(x.verdicts).toBe(2);
    expect(x.accuracy).toBe(0.5);
    expect(x.trusted).toBe(false); // n < MIN_SAMPLES_FOR_TRUST
  });

  it('stores verdictDimension on the record', () => {
    const [h] = recordPrediction([fakeHyp('d')]);
    recordVerdict(h.pid!, 'wrong', 'bad fix', 'fix_hint');
    const stats = getStats();
    // We don't expose verdictDimension in TagStats (it's per-record), so just
    // confirm the verdict landed correctly in the stats.
    expect(stats.find((s) => s.tag === 'd')!.accuracy).toBe(0);
  });

  it('passes hypotheses through untouched until detector is trusted', () => {
    // Only 4 verdicts on 'noisy' — not yet trusted.
    const seed = recordPrediction(Array.from({ length: 4 }, () => fakeHyp('noisy')));
    for (const h of seed) recordVerdict(h.pid!, 'wrong');

    const { active } = applyCalibration([fakeHyp('noisy', 'HIGH')]);
    expect(active).toHaveLength(1);
    expect(active[0].confidence).toBe('HIGH'); // not yet penalised — small sample
    expect(active[0].calibrationAction).toBe('passed');
  });

  it('demotes HIGH→MEDIUM for a trusted detector with 20%–50% accuracy', () => {
    // 5 verdicts, 2 correct, 3 wrong → 40% accuracy → trusted, demote.
    seedCalibration('mediocre', { correct: 2, wrong: 3 });

    const { active } = applyCalibration([fakeHyp('mediocre', 'HIGH')]);
    expect(active).toHaveLength(1);
    expect(active[0].confidence).toBe('MEDIUM');
    expect(active[0].calibrationAction).toBe('demoted');
    expect(active[0].confidenceScore).toBeLessThan(0.9); // halved
  });

  it('suppresses detectors with < 20% empirical accuracy', () => {
    // 5 verdicts, 0 correct → 0% accuracy → suppressed.
    seedCalibration('liar', { wrong: 5 });

    const { active, suppressed } = applyCalibration([fakeHyp('liar', 'HIGH')]);
    expect(active).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].tag).toBe('liar');
    expect(suppressed[0].calibrationAction).toBe('suppressed');
  });

  it('partial verdicts count as half-credit', () => {
    // 6 partials → 50% effective accuracy → trusted, on the boundary, pass-through.
    seedCalibration('half', { partial: 6 });

    const stats = getStats().find((s) => s.tag === 'half')!;
    expect(stats.accuracy).toBe(0.5);
    expect(stats.trusted).toBe(true);
    // 50% accuracy is *not* below DEMOTE_THRESHOLD (0.50) — pass through.
    const { active } = applyCalibration([fakeHyp('half', 'HIGH')]);
    expect(active).toHaveLength(1);
    expect(active[0].confidence).toBe('HIGH');
    expect(active[0].calibrationAction).toBe('passed');
  });

  it('seedCalibration is equivalent to manual record+verdict loops', () => {
    seedCalibration('fast', { correct: 3, wrong: 1, partial: 1 });
    const stats = getStats().find((s) => s.tag === 'fast')!;
    expect(stats.verdicts).toBe(5);
    expect(stats.trusted).toBe(true);
    // accuracy = (3*1 + 1*0 + 1*0.5) / 5 = 3.5/5 = 0.7
    expect(stats.accuracy).toBeCloseTo(0.7, 5);
  });
});

describe('calibration: pending feedback', () => {
  it('returns unrated predictions that have not yet expired', () => {
    recordPrediction([fakeHyp('ping'), fakeHyp('pong')]);
    const pending = getPendingFeedback();
    expect(pending).toHaveLength(2);
    expect(pending.every((p) => !('verdict' in p))).toBe(true);
    expect(pending[0].expiresAt).toBeGreaterThan(Date.now());
  });

  it('excludes predictions that already have a verdict', () => {
    const [h1, h2] = recordPrediction([fakeHyp('a'), fakeHyp('b')]);
    recordVerdict(h1.pid!, 'correct');
    const pending = getPendingFeedback();
    expect(pending).toHaveLength(1);
    expect(pending[0].pid).toBe(h2.pid);
  });
});

describe('calibration: note deduplication', () => {
  it('groups notes that differ only in case and punctuation', () => {
    const hyps = recordPrediction(Array.from({ length: 6 }, () => fakeHyp('dup')));
    recordVerdict(hyps[0].pid!, 'wrong', 'Wrong URL');
    recordVerdict(hyps[1].pid!, 'wrong', 'wrong url!');
    recordVerdict(hyps[2].pid!, 'wrong', 'WRONG URL');
    recordVerdict(hyps[3].pid!, 'wrong', 'wrong url');
    recordVerdict(hyps[4].pid!, 'wrong', 'different issue');
    recordVerdict(hyps[5].pid!, 'wrong', 'different issue.');

    const stats = getStats().find((s) => s.tag === 'dup')!;
    // All four "wrong url" variants should be a single group
    const urlGroup = stats.commonFailureModes.find((m) => m.note.toLowerCase().includes('wrong url'));
    expect(urlGroup).toBeDefined();
    expect(urlGroup!.count).toBe(4);
    expect(stats.commonFailureModes).toHaveLength(2); // "wrong url" + "different issue"
  });
});

describe('calibration: CSV export', () => {
  it('emits an integrity comment and header when no records exist', () => {
    const csv = exportCsv();
    const lines = csv.split('\n');
    expect(lines[0]).toMatch(/^# rows: 0, sha256: [0-9a-f]{64}$/);
    expect(lines[1]).toBe('pid,tag,confidence,predictedAt,verdict,verdictAt,note,verdictDimension');
    expect(lines).toHaveLength(2); // comment + header, no trailing newline when no rows
  });

  it('emits one row per prediction with ISO timestamps and trailing newline', () => {
    const tagged = recordPrediction([fakeHyp('a'), fakeHyp('b')]);
    recordVerdict(tagged[0].pid, 'correct');

    const csv = exportCsv();
    const lines = csv.split('\n');
    // integrity comment + header + 2 data rows + trailing empty
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^# rows: 2, sha256: [0-9a-f]{64}$/);
    expect(lines[1]).toBe('pid,tag,confidence,predictedAt,verdict,verdictAt,note,verdictDimension');
    expect(lines[2]).toMatch(
      new RegExp(`^${tagged[0].pid},a,HIGH,\\d{4}-\\d{2}-\\d{2}T.*Z,correct,\\d{4}-\\d{2}-\\d{2}T.*Z,,$`),
    );
    expect(lines[3]).toMatch(new RegExp(`^${tagged[1].pid},b,HIGH,.*,,,,$`));
    expect(lines[4]).toBe('');
  });

  it('includes verdictDimension in the row', () => {
    const [h] = recordPrediction([fakeHyp('dim')]);
    recordVerdict(h.pid!, 'wrong', 'bad root cause', 'root_cause');

    const csv = exportCsv();
    expect(csv).toContain(',root_cause\n');
  });

  it('quotes notes containing commas, quotes, and newlines per RFC-4180', () => {
    const tagged = recordPrediction([fakeHyp('q')]);
    recordVerdict(tagged[0].pid, 'wrong', 'has, "quote" and\nnewline');

    const csv = exportCsv();
    // The note must be wrapped in quotes and inner " doubled. We check
    // the raw csv (not split on \n — the embedded newline lives *inside*
    // the quoted field, which is exactly what RFC-4180 lets us do).
    expect(csv).toContain(',"has, ""quote"" and\nnewline",\n');
  });

  it('sha256 changes when records change', () => {
    recordPrediction([fakeHyp('x')]);
    const csv1 = exportCsv();
    recordPrediction([fakeHyp('y')]);
    const csv2 = exportCsv();

    const hash1 = csv1.split('\n')[0].split('sha256: ')[1];
    const hash2 = csv2.split('\n')[0].split('sha256: ')[1];
    expect(hash1).not.toBe(hash2);
  });
});
