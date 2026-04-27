/**
 * last-pack-enrichment.test.ts — Contract test for the panel's data path.
 *
 * The VS Code panel consumes /last-pack and /calibration. Both endpoints
 * promise that every hypothesis carries a `pid` and a `calibration` block.
 * If a future refactor silently drops either field, the panel's badges and
 * feedback buttons quietly stop working — and we'd find out from a 1-star
 * review, not from CI.
 *
 * This test pins the contract: drive the same data sources the route
 * handlers read from, and assert the enriched shapes that
 * panel.ts:renderCalibrationHtml() and the Detector Health card depend on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { hypothesisHistory } from '../hypothesis-history.js';
import { store } from '../buffer.js';
import { buildCausalChain } from '../causal.js';
import {
  recordPrediction,
  recordVerdict,
  getStats,
  _resetForTesting as resetCalibration,
} from '../calibration.js';
import type { Hypothesis } from '../causal.js';

const NOW = Date.now();

// Minimal seed that reliably fires `auth_token_not_persisted`. Mirrors the
// scenario in causal.test.ts so the detector behaviour is well-anchored.
function seedAuthScenario(): void {
  store.push({
    type: 'console',
    level: 'error',
    args: ['TypeError: Cannot read properties of null (reading "token")'],
    url: 'http://localhost:3000/login',
    timestamp: NOW,
  });
  store.push({
    type: 'network',
    method: 'POST',
    url: 'http://localhost:3000/api/login',
    status: 200,
    statusText: 'OK',
    duration: 120,
    responseBody: { token: 'abc123' },
    timestamp: NOW - 4000,
  });
  store.push({
    type: 'context',
    trigger: 'error',
    timestamp: NOW - 200,
    url: 'http://localhost:3000/login',
    title: 'Login',
    activeElement: 'input#email',
    localStorage: { token: 'null' },
    sessionStorage: {},
  });
}

describe('last-pack + calibration enrichment (panel contract)', () => {
  beforeEach(() => {
    store.clear();
    hypothesisHistory.clear();
    resetCalibration();
  });

  it('every surfaced hypothesis carries a stable pid the panel can post back', async () => {
    seedAuthScenario();
    await hypothesisHistory._rebuildNowForTesting('error');

    const latest = hypothesisHistory.latest();
    expect(latest, 'history should contain the freshly built pack').not.toBeNull();
    expect(latest!.chain.hypotheses.length).toBeGreaterThan(0);

    for (const h of latest!.chain.hypotheses) {
      expect(h.pid, `hypothesis ${h.tag} missing pid`).toBeTruthy();
      expect(typeof h.pid).toBe('string');
    }
  });

  it('getStats() exposes the shape /calibration enriches each hypothesis with', () => {
    const fake: Hypothesis = {
      tag: 'fake_for_test',
      summary: 'fake hypothesis',
      confidence: 'HIGH',
      confidenceScore: 0.9,
      evidence: [],
      causalPath: [],
      fixHint: null,
    };
    const [tagged] = recordPrediction([fake]);
    expect(tagged.pid).toBeTruthy();
    expect(recordVerdict(tagged.pid, 'correct')).toBe(true);

    const tagStats = getStats().find((s) => s.tag === 'fake_for_test');
    expect(tagStats).toBeDefined();

    // Contract the panel renders against. If any field name changes,
    // panel.ts:renderCalibrationHtml() and the Detector Health card
    // both have to change with it.
    expect(tagStats).toMatchObject({
      tag: 'fake_for_test',
      predictions: expect.any(Number),
      verdicts: expect.any(Number),
      accuracy: expect.any(Number),
      trusted: expect.any(Boolean),
      shouldInterrupt: expect.any(Boolean),
      commonFailureModes: expect.any(Array),
    });
    expect('accuracy7d' in tagStats!).toBe(true);
    expect('trendDelta' in tagStats!).toBe(true);
  });

  it('"wrong" verdicts with notes surface as commonFailureModes', () => {
    // Each verdict needs its own pid (recordVerdict updates a single
    // record). Issue 3 fresh predictions, fail each with a note.
    const preds = recordPrediction([
      { tag: 't', summary: '', confidence: 'HIGH', confidenceScore: 0.9, evidence: [], causalPath: [], fixHint: null },
      { tag: 't', summary: '', confidence: 'HIGH', confidenceScore: 0.9, evidence: [], causalPath: [], fixHint: null },
      { tag: 't', summary: '', confidence: 'HIGH', confidenceScore: 0.9, evidence: [], causalPath: [], fixHint: null },
    ]);
    recordVerdict(preds[0].pid, 'wrong', 'API returned 200 but body was empty');
    recordVerdict(preds[1].pid, 'wrong', 'API returned 200 but body was empty');
    recordVerdict(preds[2].pid, 'wrong', 'auth header present but expired');

    const tagStats = getStats().find((s) => s.tag === 't')!;
    const noteCounts = Object.fromEntries(tagStats.commonFailureModes.map((m) => [m.note, m.count]));
    expect(noteCounts['API returned 200 but body was empty']).toBe(2);
    expect(noteCounts['auth header present but expired']).toBe(1);
  });

  it('history rows expose topHypothesis with the same shape /history sends to the panel', async () => {
    seedAuthScenario();
    await hypothesisHistory._rebuildNowForTesting('error');

    const list = hypothesisHistory.list(5);
    expect(list.length).toBeGreaterThan(0);
    const row = list[0];
    expect(row).toMatchObject({
      builtAt: expect.any(Number),
      builtAtIso: expect.any(String),
      triggerMessage: expect.any(String),
      reason: expect.any(String),
    });
    if (row.topHypothesis) {
      expect(row.topHypothesis.tag).toBeTruthy();
      expect(row.topHypothesis.pid).toBeTruthy();
    }
  });

  it('a poor track record demotes a HIGH-confidence detector at re-rank time', async () => {
    // Seed: auth_token_not_persisted is now 20% accurate (1 correct, 4 wrong),
    // well below DEMOTE_THRESHOLD (50%). buildCausalChain should either
    // suppress it or demote its score below the original 0.9.
    const seed = recordPrediction(
      Array.from({ length: 5 }, () => ({
        tag: 'auth_token_not_persisted',
        summary: '',
        confidence: 'HIGH' as const,
        confidenceScore: 0.9,
        evidence: [],
        causalPath: [],
        fixHint: null,
      })),
    );
    recordVerdict(seed[0].pid, 'correct');
    for (let i = 1; i < 5; i++) recordVerdict(seed[i].pid, 'wrong');

    seedAuthScenario();
    const c = await buildCausalChain(
      store.getLogs(50),
      store.getNetwork(50),
      store.getContext(10),
    );
    const surviving = c.hypotheses.find((h) => h.tag === 'auth_token_not_persisted');
    if (surviving) {
      // Survived suppression but must have been demoted.
      expect(surviving.confidenceScore).toBeLessThan(0.9);
    }
    // Either way: its accuracy-weighted rank can't have it #1 with full score.
    if (c.hypotheses[0]?.tag === 'auth_token_not_persisted') {
      expect(c.hypotheses[0].confidenceScore).toBeLessThan(0.9);
    }
  });
});
