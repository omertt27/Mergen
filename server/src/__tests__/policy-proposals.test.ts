/**
 * policy-proposals.test.ts — invariants for the corpus→proposal bridge
 * (MERGEN_AUTO_CORPUS_PROPOSE, on by default; set to 'false' to disable).
 *
 * Guarantees:
 *   1. Proposals are ALWAYS HOLD ('warn') — never 'block' — even when the
 *      corpus rule would otherwise be a hard block.
 *   2. A proposed rule is inert: not in loadEnterprisePolicy() and not evaluated
 *      by the gate until it is explicitly approved.
 *   3. Approval installs the rule (as a HOLD) into live policy.
 *   4. With MERGEN_AUTO_CORPUS_PROPOSE=false, proposeRulesFromCorpus() is a no-op.
 *
 * Uses a scratch MERGEN_DATA_DIR so it drives the real file-backed corpus,
 * proposal store, and policy engine.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let tmpDir: string;
let recordOverride: typeof import('../intelligence/override-corpus.js').recordOverride;
let proposeRulesFromCorpus: typeof import('../intelligence/corpus-to-policy.js').proposeRulesFromCorpus;
let activateProposedRule: typeof import('../intelligence/corpus-to-policy.js').activateProposedRule;
let markProposalDecided: typeof import('../intelligence/policy-proposals.js').markProposalDecided;
let getProposals: typeof import('../intelligence/policy-proposals.js').getProposals;
let stageProposal: typeof import('../intelligence/policy-proposals.js').stageProposal;
let _resetProposalsForTesting: typeof import('../intelligence/policy-proposals.js')._resetProposalsForTesting;
let loadEnterprisePolicy: typeof import('../intelligence/enterprise-policy-engine.js').loadEnterprisePolicy;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-policy-proposals-test-'));
  process.env.MERGEN_DATA_DIR = tmpDir;

  ({ recordOverride } = await import('../intelligence/override-corpus.js'));
  ({ proposeRulesFromCorpus, activateProposedRule } = await import('../intelligence/corpus-to-policy.js'));
  ({ markProposalDecided, getProposals, stageProposal, _resetProposalsForTesting } =
    await import('../intelligence/policy-proposals.js'));
  ({ loadEnterprisePolicy } = await import('../intelligence/enterprise-policy-engine.js'));
});

afterAll(() => {
  delete process.env.MERGEN_DATA_DIR;
  delete process.env.MERGEN_AUTO_CORPUS_PROPOSE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetProposalsForTesting();
});

function seedThreeOverrides(tag: string, service: string): void {
  for (let i = 0; i < 3; i++) {
    recordOverride({
      incidentTag: tag,
      proposedCommand: 'terraform destroy -auto-approve staging',
      overrideReason: 'batch-window',
      service,
      environment: 'production',
      actor: 'tester',
    });
  }
}

describe('proposeRulesFromCorpus (MERGEN_AUTO_CORPUS_PROPOSE)', () => {
  it('is a no-op when explicitly disabled (MERGEN_AUTO_CORPUS_PROPOSE=false)', () => {
    process.env.MERGEN_AUTO_CORPUS_PROPOSE = 'false';
    seedThreeOverrides('infra_prop_off', 'svc-off');
    const proposals = proposeRulesFromCorpus({ incidentTag: 'infra_prop_off', service: 'svc-off' });
    expect(proposals).toEqual([]);
    expect(getProposals('proposed')).toHaveLength(0);
  });

  it('stages HOLD-only proposals (never block) by default (flag unset)', () => {
    delete process.env.MERGEN_AUTO_CORPUS_PROPOSE;
    seedThreeOverrides('infra_prop_hold', 'svc-hold');
    const proposals = proposeRulesFromCorpus({ incidentTag: 'infra_prop_hold', service: 'svc-hold' });

    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p.rule.action).toBe('warn'); // never 'block'
      expect(p.status).toBe('proposed');
    }
  });

  it('a proposed rule is inert — not in live policy until approved', () => {
    process.env.MERGEN_AUTO_CORPUS_PROPOSE = 'true';
    seedThreeOverrides('infra_prop_inert', 'svc-inert');
    const proposals = proposeRulesFromCorpus({ incidentTag: 'infra_prop_inert', service: 'svc-inert' });
    const proposedRuleId = proposals[0].rule.id;

    const before = loadEnterprisePolicy(true);
    expect(before.rules.some((r) => r.id === proposedRuleId)).toBe(false);

    // Approve → activate → now present in live policy, still as a HOLD.
    activateProposedRule(proposals[0].rule);
    markProposalDecided(proposals[0].id, 'approved');

    const after = loadEnterprisePolicy(true);
    const installed = after.rules.find((r) => r.id === proposedRuleId);
    expect(installed).toBeDefined();
    expect(installed!.action).toBe('warn');
  });

  it('is idempotent — re-proposing the same pattern does not duplicate', () => {
    process.env.MERGEN_AUTO_CORPUS_PROPOSE = 'true';
    seedThreeOverrides('infra_prop_idem', 'svc-idem');
    const first  = proposeRulesFromCorpus({ incidentTag: 'infra_prop_idem', service: 'svc-idem' });
    const second = proposeRulesFromCorpus({ incidentTag: 'infra_prop_idem', service: 'svc-idem' });
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0); // already staged
  });

  it('stageProposal refuses a non-HOLD rule', () => {
    expect(() =>
      stageProposal('x', { id: 'x', name: 'x', description: '', action: 'block', reason: '', conditions: {} }, 1),
    ).toThrow(/non-HOLD/);
  });
});
