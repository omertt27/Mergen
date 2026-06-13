/**
 * Level 2 — Production Replay Evals
 *
 * Runs the current detector pipeline over the replay corpus — incidents that
 * have already received human-verified verdicts — and measures aggregate
 * accuracy.  A PR that changes a detector and drops corpus accuracy below
 * the threshold is blocked before it merges.
 *
 * Two sub-suites:
 *   A. Corpus replay — accuracy gate against ALL_INFRA_DETECTORS
 *   B. CalibrationClassifier — verifies the online learner improves P(correct)
 *      as it sees more verdicts, and that it stays neutral without enough data.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// detectors.js is closed-source; mock it so infra-detectors.ts can be imported in CI.
vi.mock('../../intelligence/detectors.js', () => ({
  scoreToConfidence: (score: number) => score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low',
}));

import { ALL_INFRA_DETECTORS } from '../../intelligence/infra-detectors.js';
import { CalibrationClassifier } from '../../intelligence/calibration-classifier.js';
import { REPLAY_CORPUS } from './fixtures/corpus.js';
import type { InfraEvent } from '../../sensor/infra-normalizer.js';
import type { Hypothesis } from '../../intelligence/causal.js';
import type { CorpusEntry, EvalSummary } from './types.js';

/** Minimum corpus accuracy (%) that must not regress across PRs. */
const ACCURACY_GATE = 85;

// ── Runner ─────────────────────────────────────────────────────────────────────

function runInfraPipeline(events: InfraEvent[]): Hypothesis | null {
  const results = ALL_INFRA_DETECTORS
    .map((detect) => detect(events))
    .filter((h): h is Hypothesis => h !== null);
  if (results.length === 0) return null;
  return results.reduce((best, h) => h.confidenceScore > best.confidenceScore ? h : best);
}

function replayCorpus(corpus: CorpusEntry[]): EvalSummary & { byTag: Record<string, { total: number; passed: number }> } {
  const failures: EvalSummary['failures'] = [];
  const byTag: Record<string, { total: number; passed: number }> = {};
  let passed = 0;

  for (const entry of corpus) {
    const top = runInfraPipeline(entry.events);
    const ok = top !== null && top.tag === entry.expectedTag;

    const tag = entry.expectedTag;
    byTag[tag] = byTag[tag] ?? { total: 0, passed: 0 };
    byTag[tag].total++;
    if (ok) {
      passed++;
      byTag[tag].passed++;
    } else {
      failures.push({ name: entry.expectedTag, expected: entry.expectedTag, actual: top?.tag ?? null });
    }
  }

  return {
    total: corpus.length,
    passed,
    failed: failures.length,
    accuracyPct: Math.round((passed / corpus.length) * 100),
    failures,
    byTag,
  };
}

// ── A. Corpus replay ──────────────────────────────────────────────────────────

describe('Level 2 — corpus replay accuracy', () => {
  it(`overall accuracy >= ${ACCURACY_GATE}%`, () => {
    const result = replayCorpus(REPLAY_CORPUS);

    if (result.failures.length > 0) {
      const report = result.failures
        .map((f) => `  • expected ${f.expected}, got ${f.actual ?? 'null'}`)
        .join('\n');
      console.log(`\nCorpus replay — ${result.passed}/${result.total} passed (${result.accuracyPct}%)\nFailures:\n${report}`);
    }

    expect(result.accuracyPct).toBeGreaterThanOrEqual(ACCURACY_GATE);
  });

  it('per-tag: db_connection_pool at 100% (high-signal detector)', () => {
    const dbEntries = REPLAY_CORPUS.filter((e) => e.expectedTag === 'infra_db_connection_pool');
    const result = replayCorpus(dbEntries);
    expect(result.accuracyPct).toBe(100);
  });

  it('per-tag: certificate_expiry at 100% (deterministic signal)', () => {
    const entries = REPLAY_CORPUS.filter((e) => e.expectedTag === 'infra_certificate_expiry');
    const result = replayCorpus(entries);
    expect(result.accuracyPct).toBe(100);
  });

  it('per-tag: disk_pressure at 100%', () => {
    const entries = REPLAY_CORPUS.filter((e) => e.expectedTag === 'infra_disk_pressure');
    const result = replayCorpus(entries);
    expect(result.accuracyPct).toBe(100);
  });

  it('per-tag: oom_kill at 100% for hard kills (not memory_pressure)', () => {
    const hardOnly = REPLAY_CORPUS.filter((e) => e.expectedTag === 'infra_oom_kill' && e.events[0].kind === 'oom_kill');
    const result = replayCorpus(hardOnly);
    expect(result.accuracyPct).toBe(100);
  });

  it('no correct verdict entry is misidentified as a different detector', () => {
    const correctOnly = REPLAY_CORPUS.filter((e) => e.verdict === 'correct');
    const result = replayCorpus(correctOnly);
    if (result.failures.length > 0) {
      const report = result.failures.map((f) => `  • expected ${f.expected}, got ${f.actual ?? 'null'}`).join('\n');
      expect(result.failures, `Misfired on verified-correct verdicts:\n${report}`).toHaveLength(0);
    }
    expect(result.accuracyPct).toBeGreaterThanOrEqual(ACCURACY_GATE);
  });

  it('detector outputs include service name from the incident event', () => {
    for (const entry of REPLAY_CORPUS) {
      const top = runInfraPipeline(entry.events);
      if (top && entry.verdict !== 'wrong') {
        const service = entry.events[0].service;
        expect(top.summary).toContain(service);
      }
    }
  });

  it('all corpus detectors provide fix hints', () => {
    for (const entry of REPLAY_CORPUS) {
      const top = runInfraPipeline(entry.events);
      if (top && entry.verdict !== 'wrong') {
        expect(top.fixHint, `${entry.expectedTag}: missing fixHint`).toBeTruthy();
      }
    }
  });
});

// ── B. CalibrationClassifier — online learning ────────────────────────────────

describe('Level 2 — CalibrationClassifier learning', () => {
  let clf: CalibrationClassifier;

  beforeEach(() => {
    clf = new CalibrationClassifier();
  });

  it('returns neutral 0.5 before 10 training samples', () => {
    for (let i = 0; i < 9; i++) {
      clf.update(0.9, 0.8, 5, true, true);
    }
    expect(clf.trainedOn).toBe(9);
    expect(clf.predict(0.9, 0.8, 5, true)).toBe(0.5);
  });

  it('predict is callable after 10+ samples', () => {
    for (let i = 0; i < 15; i++) {
      clf.update(0.9, 0.85, 10, true, true);
    }
    const p = clf.predict(0.9, 0.85, 10, true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it('learns: P(correct) for high-confidence correct samples > wrong samples', () => {
    // Train with 20 clearly correct high-confidence samples and 20 wrong low-confidence
    for (let i = 0; i < 20; i++) {
      clf.update(0.9, 0.9, 20, true, true);   // high confidence + correct
      clf.update(0.3, 0.2, 20, true, false);  // low confidence + wrong
    }

    const highConfP  = clf.predict(0.9, 0.9, 20, true);
    const lowConfP   = clf.predict(0.3, 0.2, 20, true);
    expect(highConfP).toBeGreaterThan(lowConfP);
  });

  it('trainBulk produces the same directional result as incremental updates', () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      confidence: i % 2 === 0 ? 0.85 : 0.35,
      tagAccuracy: i % 2 === 0 ? 0.8 : 0.3,
      sampleCount: 15,
      trusted: true,
      isCorrect: i % 2 === 0,
    }));

    const incremental = new CalibrationClassifier();
    for (const s of samples) incremental.update(s.confidence, s.tagAccuracy, s.sampleCount, s.trusted, s.isCorrect);

    clf.trainBulk(samples);

    const incP  = incremental.predict(0.85, 0.8, 15, true);
    const bulkP = clf.predict(0.85, 0.8, 15, true);
    // Both should agree directionally: high-confidence correct > 0.5
    expect(incP).toBeGreaterThan(0.5);
    expect(bulkP).toBeGreaterThan(0.5);
  });

  it('weights() reflects accumulated training', () => {
    const before = clf.weights();
    for (let i = 0; i < 20; i++) clf.update(0.8, 0.7, 10, true, true);
    const after = clf.weights();
    expect(after.trainedOn).toBe(20);
    // At least one weight should have shifted from the zero prior
    const shifted = after.w.some((w, i) => Math.abs(w - before.w[i]) > 1e-6);
    expect(shifted).toBe(true);
  });

  it('P(correct) stays bounded between 0 and 1 after extreme inputs', () => {
    for (let i = 0; i < 50; i++) {
      clf.update(1.0, 1.0, 500, true, true);
      clf.update(0.0, 0.0, 500, true, false);
    }
    const high = clf.predict(1.0, 1.0, 500, true);
    const low  = clf.predict(0.0, 0.0, 500, true);
    expect(high).toBeLessThanOrEqual(1.0);
    expect(high).toBeGreaterThanOrEqual(0.0);
    expect(low).toBeLessThanOrEqual(1.0);
    expect(low).toBeGreaterThanOrEqual(0.0);
  });

  it('untrusted tag (trusted=false) has lower P(correct) than trusted tag', () => {
    for (let i = 0; i < 30; i++) {
      clf.update(0.8, 0.8, 20, true,  true);
      clf.update(0.8, 0.8, 20, false, true);
    }
    const trustedP   = clf.predict(0.8, 0.8, 20, true);
    const untrustedP = clf.predict(0.8, 0.8, 20, false);
    expect(trustedP).toBeGreaterThanOrEqual(untrustedP);
  });

  it('more samples (higher log count) increases P(correct) when other features are equal', () => {
    for (let i = 0; i < 30; i++) {
      clf.update(0.8, 0.8, 500, true, true);
      clf.update(0.8, 0.8, 1,   true, true);
    }
    const manyP = clf.predict(0.8, 0.8, 500, true);
    const fewP  = clf.predict(0.8, 0.8, 1,   true);
    expect(manyP).toBeGreaterThanOrEqual(fewP);
  });
});

// ── C. Corpus regression snapshot + baseline comparison ───────────────────────

interface BaselineEntry { total: number; passed: number; pct: number }
interface Baseline {
  updatedAt: string;
  corpusSize: number;
  overall: number;
  byTag: Record<string, BaselineEntry>;
}

/** Max allowed drop in overall accuracy vs baseline before blocking. */
const OVERALL_REGRESSION_THRESHOLD = 5;   // percentage points
/** Max allowed drop for any individual tag vs baseline. */
const PER_TAG_REGRESSION_THRESHOLD  = 15;  // percentage points

function loadBaseline(): Baseline | null {
  const baselinePath = resolve(__dirname, '../../../../eval-baseline.json');
  if (!existsSync(baselinePath)) return null;
  try { return JSON.parse(readFileSync(baselinePath, 'utf8')); }
  catch { return null; }
}

describe('Level 2 — corpus regression snapshot', () => {
  it('produces a summary report for CI artefacts', () => {
    const result = replayCorpus(REPLAY_CORPUS);

    const tagRows = Object.entries(result.byTag)
      .map(([tag, s]) => `  ${tag}: ${s.passed}/${s.total}`)
      .join('\n');

    console.log(`\n=== Corpus Replay Summary ===\nTotal: ${result.passed}/${result.total} (${result.accuracyPct}%)\nBy tag:\n${tagRows}`);

    expect(result).toMatchObject({
      total: REPLAY_CORPUS.length,
      accuracyPct: expect.any(Number),
      byTag: expect.any(Object),
    });
  });
});

describe('Level 2 — accuracy regression vs baseline', () => {
  it('overall accuracy has not regressed from baseline', () => {
    const baseline = loadBaseline();
    if (!baseline) {
      console.log('No eval-baseline.json found — run: npm run eval:update-baseline');
      return; // skip gracefully if no baseline exists yet
    }

    const result = replayCorpus(REPLAY_CORPUS);
    const drop = baseline.overall - result.accuracyPct;

    if (drop > OVERALL_REGRESSION_THRESHOLD) {
      expect.fail(
        `Overall accuracy regressed: ${baseline.overall}% → ${result.accuracyPct}% ` +
        `(drop: ${drop}pp, threshold: ${OVERALL_REGRESSION_THRESHOLD}pp)\n` +
        `Fix the detector or run \`npm run eval:update-baseline\` to accept the new floor.`,
      );
    }

    expect(result.accuracyPct).toBeGreaterThanOrEqual(baseline.overall - OVERALL_REGRESSION_THRESHOLD);
  });

  it('no individual tag has regressed from baseline', () => {
    const baseline = loadBaseline();
    if (!baseline) return; // skip if no baseline

    const result = replayCorpus(REPLAY_CORPUS);
    const regressions: string[] = [];

    for (const [tag, current] of Object.entries(result.byTag)) {
      const base = baseline.byTag[tag];
      if (!base) continue; // new tag added to corpus — not a regression
      const drop = base.pct - current.pct;
      if (drop > PER_TAG_REGRESSION_THRESHOLD) {
        regressions.push(`  • ${tag}: ${base.pct}% → ${current.pct}% (−${drop}pp)`);
      }
    }

    if (regressions.length > 0) {
      expect.fail(
        `Per-tag accuracy regressions (threshold: −${PER_TAG_REGRESSION_THRESHOLD}pp):\n` +
        regressions.join('\n') +
        `\nFix the detector or run \`npm run eval:update-baseline\` to accept new floors.`,
      );
    }

    expect(regressions).toHaveLength(0);
  });
});
