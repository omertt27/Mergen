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
    expect(tagged[0].pid).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(tagged[1].pid).not.toBe(tagged[0].pid);

    // Idempotent — re-recording an already-tagged hypothesis keeps its pid.
    const again = recordPrediction(tagged);
    expect(again[0].pid).toBe(tagged[0].pid);
  });

  it('records verdicts and reflects them in /calibration stats', () => {
    const tagged = recordPrediction([fakeHyp('x'), fakeHyp('x'), fakeHyp('y')]);
    expect(recordVerdict(tagged[0].pid!, 'correct')).toBe(true);
    expect(recordVerdict(tagged[1].pid!, 'wrong')).toBe(true);
    expect(recordVerdict('not-a-real-pid', 'correct')).toBe(false);

    const stats = getStats();
    const x = stats.find((s) => s.tag === 'x')!;
    expect(x.predictions).toBe(2);
    expect(x.verdicts).toBe(2);
    expect(x.accuracy).toBe(0.5);
    expect(x.trusted).toBe(false); // n < MIN_SAMPLES_FOR_TRUST
  });

  it('passes hypotheses through untouched until detector is trusted', () => {
    // Only 4 verdicts on 'noisy' — not yet trusted.
    const seed = recordPrediction(Array.from({ length: 4 }, () => fakeHyp('noisy')));
    for (const h of seed) recordVerdict(h.pid!, 'wrong');

    const fresh = [fakeHyp('noisy', 'HIGH')];
    const out = applyCalibration(fresh);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('HIGH'); // not yet penalised — small sample
  });

  it('demotes HIGH→MEDIUM for a trusted detector with 20%–50% accuracy', () => {
    // 5 verdicts, 2 correct, 3 wrong → 40% accuracy → trusted, demote.
    const seed = recordPrediction(Array.from({ length: 5 }, () => fakeHyp('mediocre')));
    recordVerdict(seed[0].pid!, 'correct');
    recordVerdict(seed[1].pid!, 'correct');
    recordVerdict(seed[2].pid!, 'wrong');
    recordVerdict(seed[3].pid!, 'wrong');
    recordVerdict(seed[4].pid!, 'wrong');

    const out = applyCalibration([fakeHyp('mediocre', 'HIGH')]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('MEDIUM');
    expect(out[0].confidenceScore).toBeLessThan(0.9); // halved
  });

  it('suppresses detectors with < 20% empirical accuracy', () => {
    // 5 verdicts, 0 correct → 0% accuracy → suppressed.
    const seed = recordPrediction(Array.from({ length: 5 }, () => fakeHyp('liar')));
    for (const h of seed) recordVerdict(h.pid!, 'wrong');

    const out = applyCalibration([fakeHyp('liar', 'HIGH')]);
    expect(out).toHaveLength(0);
  });

  it('partial verdicts count as half-credit', () => {
    // 6 partials → 50% effective accuracy → trusted, on the boundary, pass-through.
    const seed = recordPrediction(Array.from({ length: 6 }, () => fakeHyp('half')));
    for (const h of seed) recordVerdict(h.pid!, 'partial');

    const stats = getStats().find((s) => s.tag === 'half')!;
    expect(stats.accuracy).toBe(0.5);
    expect(stats.trusted).toBe(true);
    // 50% accuracy is *not* below DEMOTE_THRESHOLD (0.50) — pass through.
    const out = applyCalibration([fakeHyp('half', 'HIGH')]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('HIGH');
  });
});

describe('calibration: CSV export', () => {
  it('emits a header-only CSV when no records exist', () => {
    const csv = exportCsv();
    expect(csv).toBe('pid,tag,confidence,predictedAt,verdict,verdictAt,note');
  });

  it('emits one row per prediction with ISO timestamps and trailing newline', () => {
    const tagged = recordPrediction([fakeHyp('a'), fakeHyp('b')]);
    recordVerdict(tagged[0].pid, 'correct');

    const csv = exportCsv();
    const lines = csv.split('\n');
    // header + 2 data rows + trailing empty (because of final '\n')
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('pid,tag,confidence,predictedAt,verdict,verdictAt,note');
    expect(lines[1]).toMatch(
      new RegExp(`^${tagged[0].pid},a,HIGH,\\d{4}-\\d{2}-\\d{2}T.*Z,correct,\\d{4}-\\d{2}-\\d{2}T.*Z,$`),
    );
    expect(lines[2]).toMatch(new RegExp(`^${tagged[1].pid},b,HIGH,.*,,,$`));
    expect(lines[3]).toBe('');
  });

  it('quotes notes containing commas, quotes, and newlines per RFC-4180', () => {
    const tagged = recordPrediction([fakeHyp('q')]);
    recordVerdict(tagged[0].pid, 'wrong', 'has, "quote" and\nnewline');

    const csv = exportCsv();
    // The note must be wrapped in quotes and inner " doubled. We check
    // the raw csv (not split on \n — the embedded newline lives *inside*
    // the quoted field, which is exactly what RFC-4180 lets us do).
    expect(csv).toContain(',"has, ""quote"" and\nnewline"\n');
  });
});
