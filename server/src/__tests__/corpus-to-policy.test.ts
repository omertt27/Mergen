/**
 * corpus-to-policy.test.ts — Real (unmocked) integration test for the
 * corpus → Gate A activation path added to close the "detector feeds the
 * firewall" loop: POST /overrides/:id/review → autoActivateReviewedRules().
 *
 * Uses a scratch MERGEN_DATA_DIR so it exercises the real file-backed
 * override-corpus and enterprise-policy modules, not mocks.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let tmpDir: string;
let recordOverride: typeof import('../intelligence/override-corpus.js').recordOverride;
let markOverrideReviewed: typeof import('../intelligence/override-corpus.js').markOverrideReviewed;
let autoActivateReviewedRules: typeof import('../intelligence/corpus-to-policy.js').autoActivateReviewedRules;
let loadEnterprisePolicy: typeof import('../intelligence/enterprise-policy-engine.js').loadEnterprisePolicy;
let evaluateEnterprisePolicy: typeof import('../intelligence/enterprise-policy-engine.js').evaluateEnterprisePolicy;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-corpus-to-policy-test-'));
  process.env.MERGEN_DATA_DIR = tmpDir;

  ({ recordOverride, markOverrideReviewed } = await import('../intelligence/override-corpus.js'));
  ({ autoActivateReviewedRules } = await import('../intelligence/corpus-to-policy.js'));
  ({ loadEnterprisePolicy, evaluateEnterprisePolicy } = await import('../intelligence/enterprise-policy-engine.js'));
});

afterAll(() => {
  delete process.env.MERGEN_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('autoActivateReviewedRules', () => {
  // Each test uses its own (tag, service) pair — the corpus and policy files
  // persist across tests in this file, and the synthesized rule id is a
  // content hash of (tag, service, reason, day, hour), so reusing a pair
  // across tests would make the second test's "first activation" a no-op
  // against state left behind by an earlier test.
  function seedThreeOverrides(tag: string, service: string): string {
    let lastId = '';
    for (let i = 0; i < 3; i++) {
      const ev = recordOverride({
        incidentTag: tag,
        proposedCommand: 'kubectl set env deployment/test-svc DB_POOL_MAX=50',
        overrideReason: 'batch-window',
        service,
        environment: 'production',
        actor: 'tester',
      });
      lastId = ev.id;
    }
    return lastId;
  }

  it('activates a rule into the live policy once the pattern clears the occurrence threshold', () => {
    const tag = 'infra_test_pool_exhaustion_a';
    const service = 'test-svc-a';
    const lastId = seedThreeOverrides(tag, service);
    markOverrideReviewed(lastId);

    const activated = autoActivateReviewedRules(tag, service);
    expect(activated.length).toBe(1);

    const policy = loadEnterprisePolicy(true);
    const matches = policy.rules.filter((r) => r.id === activated[0].rule.id);
    expect(matches.length).toBe(1);
  });

  it('is idempotent — reviewing an already-activated override again does not duplicate the rule or throw', () => {
    const tag = 'infra_test_pool_exhaustion_b';
    const service = 'test-svc-b';
    const lastId = seedThreeOverrides(tag, service);
    markOverrideReviewed(lastId);

    const first = autoActivateReviewedRules(tag, service);
    expect(first.length).toBe(1);
    const ruleId = first[0].rule.id;

    // Simulate a duplicate/retry POST /overrides/:id/review for the same event.
    markOverrideReviewed(lastId);
    expect(() => autoActivateReviewedRules(tag, service)).not.toThrow();
    const second = autoActivateReviewedRules(tag, service);

    // Already covered — nothing new staged, nothing new to activate.
    expect(second.length).toBe(0);

    const policy = loadEnterprisePolicy(true);
    const matches = policy.rules.filter((r) => r.id === ruleId);
    expect(matches.length).toBe(1); // still exactly one copy, not duplicated
  });

  // Regression: a promoted rule must be scoped to the overridden command, not
  // to every AI action against the service — see corpus-to-policy.ts's
  // commandSignatures wiring.
  it('activated rule blocks the overridden command but passes an unrelated command on the same service', () => {
    const tag = 'infra_test_pool_exhaustion_c';
    const service = 'test-svc-c';
    const lastId = seedThreeOverrides(tag, service);
    markOverrideReviewed(lastId);

    const activated = autoActivateReviewedRules(tag, service);
    expect(activated.length).toBe(1);
    expect(activated[0].rule.conditions.commands).toEqual(['kubectl set env']);

    const overriddenCall = evaluateEnterprisePolicy({
      files:    ['bash'],
      commands: ['bash', 'kubectl set env deployment/test-svc DB_POOL_MAX=75'],
      actor:    'agent',
      service:  'mcp',
    });
    expect(overriddenCall.triggeredRules).toContain(activated[0].rule.id);
    expect(overriddenCall.verdict).toBe('block');

    const unrelatedCall = evaluateEnterprisePolicy({
      files:    ['bash'],
      commands: ['bash', 'kubectl get pods -n test-svc-c'],
      actor:    'agent',
      service:  'mcp',
    });
    expect(unrelatedCall.triggeredRules).not.toContain(activated[0].rule.id);
    expect(unrelatedCall.verdict).toBe('pass');
  });

  it('skips synthesis when no command signature can be extracted (never promotes an unscoped rule)', () => {
    const tag = 'infra_test_pool_exhaustion_d';
    const service = 'test-svc-d';
    let lastId = '';
    for (let i = 0; i < 3; i++) {
      const ev = recordOverride({
        incidentTag:     tag,
        proposedCommand: '   ', // whitespace-only — normalizes to an empty signature
        overrideReason:  'batch-window',
        service,
        environment:     'production',
        actor:           'tester',
      });
      lastId = ev.id;
    }
    markOverrideReviewed(lastId);

    const activated = autoActivateReviewedRules(tag, service);
    expect(activated.length).toBe(0);
  });
});