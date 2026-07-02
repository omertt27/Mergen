/**
 * policy-corpus-condition.test.ts — P0.4 explicit requireCorpusMatch rule
 * condition (enterprise-policy-engine.ts's 12th condition category).
 *
 * Verifies:
 *   1. A rule with requireCorpusMatch does NOT fire when the corpus has fewer
 *      than minOccurrences overrides for the configured (incidentTag, service).
 *   2. It DOES fire once occurrences clear the threshold.
 *   3. It's ANDed with the rule's other conditions (e.g. commands) — both
 *      must match, not just the corpus check.
 *   4. It's schema-accepted by POST /policies/rules (regression for the
 *      route-schema-drift bug found while wiring this — new rule conditions
 *      must not silently be dropped by some but not all routes).
 *
 * Uses a scratch MERGEN_DATA_DIR so it drives the real file-backed corpus
 * (same pattern as policy-proposals.test.ts / override-pack.test.ts).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let tmpDir: string;
let evaluateEnterprisePolicy: typeof import('../intelligence/enterprise-policy-engine.js').evaluateEnterprisePolicy;
let recordOverride: typeof import('../intelligence/override-corpus.js').recordOverride;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-corpus-condition-test-'));
  process.env.MERGEN_DATA_DIR = tmpDir;
  ({ evaluateEnterprisePolicy } = await import('../intelligence/enterprise-policy-engine.js'));
  ({ recordOverride } = await import('../intelligence/override-corpus.js'));
});

afterAll(() => {
  delete process.env.MERGEN_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedOverrides(tag: string, service: string, count: number) {
  for (let i = 0; i < count; i++) {
    recordOverride({
      incidentTag: tag,
      proposedCommand: 'kubectl rollout restart deploy/api',
      overrideReason: 'batch-window',
      service,
      environment: 'production',
      actor: 'tester',
    });
  }
}

function ruleWithCorpusCheck(overrides: Partial<{ commands: string[]; requireCorpusMatch: { incidentTag: string; minOccurrences: number } }> = {}) {
  return {
    id: 'test_corpus_gate',
    name: 'Test corpus gate',
    description: '',
    action: 'block' as const,
    reason: 'corpus match',
    conditions: {
      requireCorpusMatch: { incidentTag: 'db_pool_exhaustion', minOccurrences: 2 },
      ...overrides,
    },
  };
}

describe('requireCorpusMatch condition', () => {
  it('does not fire when the corpus has fewer than minOccurrences', () => {
    seedOverrides('db_pool_exhaustion_sparse', 'svc-sparse', 1); // below threshold of 2
    const policy = { enabled: true, rules: [ruleWithCorpusCheck({ requireCorpusMatch: { incidentTag: 'db_pool_exhaustion_sparse', minOccurrences: 2 } })] };
    const result = evaluateEnterprisePolicy(
      { files: [], commands: ['echo hi'], actor: 'agent', service: 'svc-sparse' },
      policy,
    );
    expect(result.verdict).toBe('pass');
    expect(result.triggeredRules).not.toContain('test_corpus_gate');
  });

  it('fires once occurrences clear the threshold', () => {
    seedOverrides('db_pool_exhaustion_dense', 'svc-dense', 3); // clears threshold of 2
    const policy = { enabled: true, rules: [ruleWithCorpusCheck({ requireCorpusMatch: { incidentTag: 'db_pool_exhaustion_dense', minOccurrences: 2 } })] };
    const result = evaluateEnterprisePolicy(
      { files: [], commands: ['echo hi'], actor: 'agent', service: 'svc-dense' },
      policy,
    );
    expect(result.verdict).toBe('block');
    expect(result.triggeredRules).toContain('test_corpus_gate');
  });

  it('is ANDed with other conditions — a matching corpus alone is not enough if commands do not match', () => {
    seedOverrides('db_pool_exhaustion_anded', 'svc-anded', 3);
    const policy = {
      enabled: true,
      rules: [ruleWithCorpusCheck({
        commands: ['restart_database'],
        requireCorpusMatch: { incidentTag: 'db_pool_exhaustion_anded', minOccurrences: 2 },
      })],
    };
    const result = evaluateEnterprisePolicy(
      { files: [], commands: ['some_unrelated_tool'], actor: 'agent', service: 'svc-anded' },
      policy,
    );
    expect(result.verdict).toBe('pass');
  });

  it('does not fire for a different service even if the tag has enough occurrences', () => {
    seedOverrides('db_pool_exhaustion_scoped', 'svc-a', 5);
    const policy = { enabled: true, rules: [ruleWithCorpusCheck({ requireCorpusMatch: { incidentTag: 'db_pool_exhaustion_scoped', minOccurrences: 2 } })] };
    const result = evaluateEnterprisePolicy(
      { files: [], commands: ['echo hi'], actor: 'agent', service: 'svc-b' }, // different service
      policy,
    );
    expect(result.verdict).toBe('pass');
  });
});

describe('route schema accepts requireCorpusMatch (regression for schema drift)', () => {
  it('EnterprisePolicyConditionsSchema (the shared schema every route now imports) accepts requireCorpusMatch', async () => {
    const { EnterprisePolicyConditionsSchema } = await import('../intelligence/enterprise-policy-engine.js');
    const parsed = EnterprisePolicyConditionsSchema.safeParse({
      requireCorpusMatch: { incidentTag: 'db_pool_exhaustion', minOccurrences: 3 },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts requireCorpusMatch with minOccurrences omitted — evaluation defaults it to 1, not the schema', async () => {
    // minOccurrences is optional at the schema level (not Zod .default(1)) so
    // EnterprisePolicyConditions' hand-written recursive interface has an
    // identical input/output shape — see the interface's doc comment.
    // evaluateEnterprisePolicy applies the `?? 1`/destructuring default at
    // evaluation time instead; that behavior is covered by 'fires once
    // occurrences clear the threshold' above using an explicit minOccurrences.
    const { EnterprisePolicyConditionsSchema } = await import('../intelligence/enterprise-policy-engine.js');
    const parsed = EnterprisePolicyConditionsSchema.parse({
      requireCorpusMatch: { incidentTag: 'db_pool_exhaustion' },
    });
    expect(parsed.requireCorpusMatch?.minOccurrences).toBeUndefined();
  });

  it('evaluation treats an omitted minOccurrences as 1', () => {
    seedOverrides('db_pool_exhaustion_default', 'svc-default', 1); // exactly 1 — should satisfy an implicit threshold of 1
    const policy = {
      enabled: true,
      rules: [ruleWithCorpusCheck({ requireCorpusMatch: { incidentTag: 'db_pool_exhaustion_default', minOccurrences: undefined as unknown as number } })],
    };
    const result = evaluateEnterprisePolicy(
      { files: [], commands: ['echo hi'], actor: 'agent', service: 'svc-default' },
      policy,
    );
    expect(result.verdict).toBe('block');
  });
});
