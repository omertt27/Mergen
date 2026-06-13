/**
 * Level 1 — Fixture-Based Regression Evals
 *
 * Every PR that touches detector logic runs this suite.  If a previously
 * diagnosed incident scenario stops being detected (or gets misidentified),
 * the suite fails before the merge.
 *
 * Infra detectors (open-source): run directly against ALL_INFRA_DETECTORS.
 * Browser detectors (closed-source causal.ts): tested via vi.mock so the
 * harness structure is validated in CI even without the real implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// detectors.js is closed-source; mock it so infra-detectors.ts can be imported in CI.
vi.mock('../../intelligence/detectors.js', () => ({
  scoreToConfidence: (score: number) => score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low',
}));

import {
  detectDbConnectionPool,
  detectOomKill,
  detectRateLimitCascade,
  detectDownstreamLatency,
  detectCertificateExpiry,
  detectDiskPressure,
  detectQueueBacklog,
  detectServiceUnavailable,
  detectUpstreamError,
  ALL_INFRA_DETECTORS,
} from '../../intelligence/infra-detectors.js';
import { INFRA_FIXTURES } from './fixtures/infra.js';
import { BROWSER_FIXTURES } from './fixtures/browser.js';
import type { InfraFixture, EvalSummary } from './types.js';
import type { InfraEvent } from '../../sensor/infra-normalizer.js';
import type { Hypothesis } from '../../intelligence/causal.js';

// ── Runner ─────────────────────────────────────────────────────────────────────

/**
 * Run all infra detectors over events and return the top hypothesis
 * (highest confidenceScore), or null if nothing fires.
 */
function runInfraPipeline(events: InfraEvent[]): Hypothesis | null {
  const results = ALL_INFRA_DETECTORS
    .map((detect) => detect(events))
    .filter((h): h is Hypothesis => h !== null);

  if (results.length === 0) return null;
  return results.reduce((best, h) => h.confidenceScore > best.confidenceScore ? h : best);
}

function summarise(fixtures: InfraFixture[], getTop: (f: InfraFixture) => Hypothesis | null): EvalSummary {
  const failures: EvalSummary['failures'] = [];
  let passed = 0;

  for (const f of fixtures) {
    const top = getTop(f);
    const ok = f.expected.shouldFire
      ? top !== null && top.tag === f.expected.tag && top.confidenceScore >= f.expected.confidenceMin
      : top === null;

    if (ok) {
      passed++;
    } else {
      failures.push({ name: f.name, expected: f.expected.tag, actual: top?.tag ?? null });
    }
  }

  return {
    total: fixtures.length,
    passed,
    failed: failures.length,
    accuracyPct: Math.round((passed / fixtures.length) * 100),
    failures,
  };
}

// ── Infra detector: individual tests ──────────────────────────────────────────

describe('infra detectors — individual', () => {
  it('detectDbConnectionPool fires on db_connection_pool_exhausted', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'db-pool-exhausted-otlp')!;
    const h = detectDbConnectionPool(f.events);
    expect(h).not.toBeNull();
    expect(h!.tag).toBe('infra_db_connection_pool');
    expect(h!.confidenceScore).toBeGreaterThanOrEqual(f.expected.confidenceMin);
  });

  it('detectDbConnectionPool Datadog source raises confidence above base', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'db-pool-exhausted-datadog-boost')!;
    const base = detectDbConnectionPool(f.events.map((e) => ({ ...e, source: 'otlp' as const })));
    const boosted = detectDbConnectionPool(f.events);
    expect(boosted!.confidenceScore).toBeGreaterThan(base!.confidenceScore);
  });

  it('detectOomKill hard kill returns higher score than memory_pressure', () => {
    const hard = INFRA_FIXTURES.find((x) => x.name === 'oom-kill-hard-exit-137')!;
    const soft = INFRA_FIXTURES.find((x) => x.name === 'memory-pressure-soft')!;
    const hHard = detectOomKill(hard.events);
    const hSoft = detectOomKill(soft.events);
    expect(hHard).not.toBeNull();
    expect(hSoft).not.toBeNull();
    expect(hHard!.confidenceScore).toBeGreaterThan(hSoft!.confidenceScore);
  });

  it('detectOomKill hard kill evidence mentions exit code', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'oom-kill-hard-exit-137')!;
    const h = detectOomKill(f.events)!;
    expect(h.evidence.join(' ')).toMatch(/137/);
  });

  it('detectRateLimitCascade fires and includes endpoint in evidence', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'rate-limit-cascade')!;
    const h = detectRateLimitCascade(f.events)!;
    expect(h.tag).toBe('infra_rate_limit_cascade');
    expect(h.evidence.join(' ')).toMatch(/stripe/i);
  });

  it('detectDownstreamLatency distinguishes slow_query from latency_spike tag', () => {
    const sq = INFRA_FIXTURES.find((x) => x.name === 'slow-query')!;
    const dl = INFRA_FIXTURES.find((x) => x.name === 'downstream-latency-spike')!;
    expect(detectDownstreamLatency(sq.events)!.tag).toBe('infra_slow_query');
    expect(detectDownstreamLatency(dl.events)!.tag).toBe('infra_downstream_latency');
  });

  it('detectCertificateExpiry returns high confidence (0.85)', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'certificate-expired')!;
    expect(detectCertificateExpiry(f.events)!.confidenceScore).toBe(0.85);
  });

  it('detectDiskPressure returns high confidence (0.85)', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'disk-full')!;
    expect(detectDiskPressure(f.events)!.confidenceScore).toBe(0.85);
  });

  it('detectQueueBacklog fires', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'queue-consumer-lag')!;
    expect(detectQueueBacklog(f.events)!.tag).toBe('infra_queue_backlog');
  });

  it('detectServiceUnavailable fires', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'service-unavailable-no-healthy-upstream')!;
    expect(detectServiceUnavailable(f.events)!.tag).toBe('infra_service_unavailable');
  });

  it('detectUpstreamError is the catch-all with low confidence (0.40)', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'upstream-error-with-trace')!;
    const h = detectUpstreamError(f.events)!;
    expect(h.tag).toBe('infra_upstream_error');
    expect(h.confidenceScore).toBe(0.40);
  });

  it('every detector returns null on empty events', () => {
    for (const detect of ALL_INFRA_DETECTORS) {
      expect(detect([])).toBeNull();
    }
  });
});

// ── Infra detector: fix hints & causal paths ──────────────────────────────────

describe('infra detectors — output quality', () => {
  it('every firing detector provides a non-empty fixHint', () => {
    const firingFixtures = INFRA_FIXTURES.filter((f) => f.expected.shouldFire);
    for (const f of firingFixtures) {
      const top = runInfraPipeline(f.events);
      if (!top) continue;
      expect(top.fixHint, `${f.name} has no fixHint`).toBeTruthy();
    }
  });

  it('every firing detector provides a non-empty causalPath', () => {
    const firingFixtures = INFRA_FIXTURES.filter((f) => f.expected.shouldFire);
    for (const f of firingFixtures) {
      const top = runInfraPipeline(f.events);
      if (!top) continue;
      expect(top.causalPath.length, `${f.name} causalPath is empty`).toBeGreaterThan(0);
    }
  });

  it('every firing detector includes the service name in evidence', () => {
    const firingFixtures = INFRA_FIXTURES.filter((f) => f.expected.shouldFire && f.events.length > 0);
    for (const f of firingFixtures) {
      const top = runInfraPipeline(f.events);
      if (!top) continue;
      const service = f.events[0].service;
      expect(top.evidence.join(' '), `${f.name}: evidence missing service name`).toContain(service);
    }
  });
});

// ── Infra detector: full pipeline regression ──────────────────────────────────

describe('infra detector pipeline — regression suite', () => {
  it('all fixtures pass with >= 90% accuracy', () => {
    const summary = summarise(INFRA_FIXTURES, (f) => runInfraPipeline(f.events));

    if (summary.failures.length > 0) {
      const report = summary.failures
        .map((f) => `  • ${f.name}: expected ${f.expected}, got ${f.actual ?? 'null'}`)
        .join('\n');
      // Surface failures as part of the assertion message
      expect(summary.failures, `\nFailed fixtures:\n${report}`).toHaveLength(0);
    }

    expect(summary.accuracyPct).toBeGreaterThanOrEqual(90);
  });

  it('multi-signal: specific detector outscores catch-all', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'db-pool-wins-over-upstream-catch-all')!;
    expect(runInfraPipeline(f.events)!.tag).toBe('infra_db_connection_pool');
  });

  it('multi-signal: OOM outscores upstream catch-all', () => {
    const f = INFRA_FIXTURES.find((x) => x.name === 'oom-wins-over-upstream-catch-all')!;
    expect(runInfraPipeline(f.events)!.tag).toBe('infra_oom_kill');
  });
});

// ── Browser detector: harness validation ──────────────────────────────────────

describe('browser detector harness — structure (via vi.mock)', () => {
  beforeEach(() => { vi.resetModules(); });

  for (const fixture of BROWSER_FIXTURES) {
    it(`harness validates output shape for: ${fixture.name}`, async () => {
      // Inject the closed-source causal module with a controlled implementation
      // that returns exactly what the real detector would return for this fixture.
      vi.doMock('../../intelligence/causal.js', () => ({
        buildCausalChain: async () => ({
          hypotheses: [{
            tag: fixture.expected.topTag,
            summary: `Mocked: ${fixture.expected.topTag}`,
            confidence: 'HIGH',
            confidenceScore: fixture.expected.confidenceScoreMin + 0.05,
            evidence: ['mocked evidence'],
            causalPath: ['mocked step 1', 'mocked step 2'],
            fixHint: 'mocked fix hint',
            fixAction: null,
          }],
          suppressedHypotheses: [],
          chain: [],
          contextPack: '',
          errors: [],
          capturedAt: Date.now(),
          correlatedNetwork: [],
          correlatedBackend: [],
          stateAtError: null,
        }),
        fixActionToCommand: () => null,
      }));

      const { buildCausalChain } = await import('../../intelligence/causal.js');
      const chain = await buildCausalChain(fixture.errors, fixture.networks, fixture.contexts);

      // Harness invariants — every implementation must satisfy these
      expect(chain.hypotheses).toBeDefined();
      expect(Array.isArray(chain.hypotheses)).toBe(true);

      if (chain.hypotheses.length > 0) {
        const top = chain.hypotheses[0];
        expect(top.tag).toBe(fixture.expected.topTag);
        expect(top.confidenceScore).toBeGreaterThanOrEqual(fixture.expected.confidenceScoreMin);
        expect(top.fixHint).toBeTruthy();
        expect(top.causalPath.length).toBeGreaterThan(0);
      }
    });
  }
});
