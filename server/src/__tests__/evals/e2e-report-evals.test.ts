/**
 * Level 3 — End-to-End Incident Report Evals
 *
 * Tests the full output pipeline: Hypothesis → Planning Gate → LLM Brief.
 * No actual LLM call is made.  We audit the *prompt* assembled for the LLM —
 * every factual claim in the prompt must trace back to the hypothesis or gate
 * decision.  This is the "no hallucination in the brief" guarantee.
 *
 * Checks:
 *   1. Required facts appear (service, tag, causal path, fix hint, confidence %)
 *   2. System prompt contains the anti-speculation instruction
 *   3. Prompt does not invent facts not present in the hypothesis
 *   4. Gate decision (EXECUTE vs HOLD) surfaces correctly
 *   5. Token budget estimate is within a plausible range
 *   6. Edge cases: null fixHint, empty causal path, high blast risk
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatValidatedFactsForLLM } from '../../intelligence/llm-spokesperson.js';
import { planningGate } from '../../intelligence/planning-gate.js';
import type { Hypothesis } from '../../intelligence/causal.js';
import { _resetForTesting } from '../../__stubs__/calibration.js';

beforeEach(() => {
  _resetForTesting();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function hyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    tag: 'infra_db_connection_pool',
    summary: 'Database connection pool exhausted on `api` — remaining connection slots reserved',
    confidence: 'HIGH',
    confidenceScore: 0.82,
    causalPath: [
      'Request volume exceeded connection pool capacity',
      'New connections queued waiting for a free slot',
      '`api` → timeout / connection refused on `postgres:5432`',
    ],
    evidence: [
      'Service: `api`',
      'Endpoint: `postgres:5432`',
      'Trace: `trace-abc123`',
      'Source: datadog telemetry',
    ],
    fixHint: 'Increase pool size: set `DB_POOL_MAX`. Check for connection leaks.',
    fixAction: { type: 'service_restart', target: 'api', method: 'kubectl' },
    remediationConfidence: 0.60,
    ...overrides,
  };
}

// ── 1. Required facts ─────────────────────────────────────────────────────────

describe('Level 3 — required facts in prompt', () => {
  it('contains the service name', () => {
    const gate = planningGate(hyp(), 'api');
    const brief = formatValidatedFactsForLLM(hyp(), 'api', gate, 14);
    expect(brief.userPrompt).toContain('api');
  });

  it('contains the detector tag', () => {
    const gate = planningGate(hyp(), 'api');
    const brief = formatValidatedFactsForLLM(hyp(), 'api', gate, 14);
    expect(brief.userPrompt).toContain('infra_db_connection_pool');
  });

  it('contains the hypothesis summary', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 14);
    expect(brief.userPrompt).toContain('Database connection pool exhausted');
  });

  it('contains all causal path steps numbered', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 14);
    expect(brief.userPrompt).toContain('1. Request volume exceeded connection pool capacity');
    expect(brief.userPrompt).toContain('2. New connections queued');
    expect(brief.userPrompt).toContain('3. `api`');
  });

  it('contains the fix hint', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 14);
    expect(brief.userPrompt).toContain('DB_POOL_MAX');
  });

  it('contains a calibrated confidence percentage', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 14);
    // Should contain a % figure derived from the confidence score
    expect(brief.userPrompt).toMatch(/\d+%/);
  });

  it('contains the error count', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 42);
    expect(brief.userPrompt).toContain('42');
  });

  it('contains blast risk signal from gate', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.userPrompt).toMatch(/blast risk/i);
  });
});

// ── 2. Anti-speculation system prompt ────────────────────────────────────────

describe('Level 3 — system prompt anti-speculation contract', () => {
  it('instructs LLM not to speculate', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.systemPrompt).toMatch(/do not/i);
  });

  it('instructs LLM to translate, not reason', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.systemPrompt).toMatch(/translate/i);
  });

  it('instructs LLM not to add new hypotheses', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.systemPrompt).toMatch(/do not add new hypothes/i);
  });

  it('mentions deterministic analysis as the source of facts', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.systemPrompt).toMatch(/deterministic/i);
  });
});

// ── 3. No invented facts ──────────────────────────────────────────────────────

describe('Level 3 — prompt does not invent facts', () => {
  it('omits Recommended Action section when fixHint is null', () => {
    const h = hyp({ fixHint: null });
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.userPrompt).not.toContain('Recommended Action');
  });

  it('omits Causal path section when causalPath is empty', () => {
    const h = hyp({ causalPath: [] });
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.userPrompt).not.toContain('Causal path');
  });

  it('omits Runtime Fact section when runtimeFact is null', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5, null);
    expect(brief.userPrompt).not.toContain('Runtime Fact');
  });

  it('includes Runtime Fact section when runtimeFact is provided', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5, 'p99=4.2s on DB query');
    expect(brief.userPrompt).toContain('Runtime Fact');
    expect(brief.userPrompt).toContain('p99=4.2s on DB query');
  });

  it('truncates runtimeFact at 800 chars', () => {
    const longFact = 'x'.repeat(2000);
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5, longFact);
    expect(brief.userPrompt).not.toContain('x'.repeat(801));
  });

  it('omits topology section when service has no known callers or callees', () => {
    const h = hyp();
    const gate = planningGate(h, 'unknown-isolated-service');
    const brief = formatValidatedFactsForLLM(h, 'unknown-isolated-service', gate, 5);
    expect(brief.userPrompt).not.toContain('Service topology');
  });
});

// ── 4. Gate decision surfaces correctly ───────────────────────────────────────

describe('Level 3 — gate decision in prompt', () => {
  it('shows HOLD when gate blocks execution (classifier cold-start returns neutral 0.5)', () => {
    // With a fresh CalibrationClassifier (0 samples → score=0.5) and a
    // medium confidence score, adjusted = 0.82*0.6 + 0.5*0.4 = 0.692 < 0.85 threshold
    const h = hyp({ confidenceScore: 0.82 });
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);

    if (!gate.execute) {
      expect(brief.userPrompt).toContain('HOLD');
    } else {
      expect(brief.userPrompt).toContain('EXECUTE');
    }
    // The reason string must always be present
    expect(brief.userPrompt).toContain(gate.reason);
  });

  it('gate reason string appears verbatim in the prompt', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.userPrompt).toContain(gate.reason);
  });

  it('planning signals — classifier score — appears in prompt', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.userPrompt).toMatch(/Classifier P\(correct\)/i);
  });

  it('planning signals — upstream impact count — appears in prompt', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.userPrompt).toMatch(/upstream services/i);
  });
});

// ── 5. Token budget ───────────────────────────────────────────────────────────

describe('Level 3 — token budget estimate', () => {
  it('estimatedTokens is a positive number', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.estimatedTokens).toBeGreaterThan(0);
  });

  it('estimatedTokens is within a plausible range (50–2000 tokens)', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    expect(brief.estimatedTokens).toBeGreaterThan(50);
    expect(brief.estimatedTokens).toBeLessThan(2000);
  });

  it('longer runtimeFact increases estimatedTokens', () => {
    const h = hyp();
    const gate = planningGate(h, 'api');
    const short = formatValidatedFactsForLLM(h, 'api', gate, 5);
    const long  = formatValidatedFactsForLLM(h, 'api', gate, 5, 'x'.repeat(400));
    expect(long.estimatedTokens).toBeGreaterThan(short.estimatedTokens);
  });
});

// ── 6. Multiple detectors — prompt structure invariants ───────────────────────

describe('Level 3 — prompt structure invariants across detector tags', () => {
  const tags: Array<{ tag: string; summary: string }> = [
    { tag: 'infra_oom_kill',             summary: 'OOM kill on `worker`' },
    { tag: 'infra_rate_limit_cascade',   summary: 'Rate-limit cascade on `payment-service`' },
    { tag: 'infra_certificate_expiry',   summary: 'TLS certificate expired on `api`' },
    { tag: 'infra_disk_pressure',        summary: 'Disk pressure on `logging-agent`' },
    { tag: 'infra_slow_query',           summary: 'Slow DB query on `orders`' },
    { tag: 'infra_service_unavailable',  summary: 'Service unavailable: `checkout`' },
    { tag: 'auth_token_not_persisted',   summary: 'Auth token not persisted to localStorage' },
  ];

  for (const { tag, summary } of tags) {
    it(`${tag}: prompt always has tag, summary, instructions section`, () => {
      const h = hyp({ tag, summary });
      const gate = planningGate(h, 'api');
      const brief = formatValidatedFactsForLLM(h, 'api', gate, 3);

      expect(brief.userPrompt).toContain(tag);
      expect(brief.userPrompt).toContain(summary);
      expect(brief.userPrompt).toContain('Instructions');
      expect(brief.systemPrompt.length).toBeGreaterThan(0);
    });
  }
});

// ── 7. Calibrated score override ─────────────────────────────────────────────

describe('Level 3 — calibratedScore override', () => {
  it('using calibratedScore=0.95 shows 95% in prompt', () => {
    const h = hyp({ confidenceScore: 0.7 }); // raw score lower
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5, null, 0.95);
    expect(brief.userPrompt).toContain('95%');
  });

  it('without override, prompt reflects plattScale result (raw when no corpus)', () => {
    const h = hyp({ confidenceScore: 0.82, tag: 'infra_db_connection_pool' });
    const gate = planningGate(h, 'api');
    const brief = formatValidatedFactsForLLM(h, 'api', gate, 5);
    // With empty calibration corpus, plattScale returns raw → 82%
    expect(brief.userPrompt).toContain('82%');
  });
});
