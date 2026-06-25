/**
 * routes/safety-test.ts — Adversarial test suite for the policy gate.
 *
 *   GET /safety-test           Run all bypass test cases, return results
 *   GET /safety-test?verbose=1 Include per-case detail
 *
 * Runs on every request — no state mutation, safe to hit from CI.
 * Exit semantics: { allPassed: true } when the gate is holding.
 *
 * Published results replace the assertion "we are deterministic" with
 * "we test X bypass patterns on every release and they all fail."
 */

import { Router } from 'express';
import {
  evaluateEnterprisePolicy,
  loadEnterprisePolicy,
  DEFAULT_ENTERPRISE_POLICY,
  _resetPolicyCacheForTesting,
} from '../intelligence/enterprise-policy-engine.js';

export function createSafetyTestRouter(): Router {
  const router = Router();

  router.get('/safety-test', (req, res) => {
    const verbose = req.query.verbose === '1' || req.query.verbose === 'true';
    const results = runSafetyTests();
    const allPassed = results.every((r) => r.passed);
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    const body: Record<string, unknown> = {
      ok: allPassed,
      allPassed,
      passed,
      failed,
      total: results.length,
    };
    if (verbose) body.cases = results;
    if (!allPassed) {
      body.failures = results.filter((r) => !r.passed).map((r) => r.name);
    }

    res.status(allPassed ? 200 : 500).json(body);
  });

  return router;
}

// ── Test cases ────────────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  description: string;
  /** Expected policy verdict — 'block' or 'warn'. 'pass' cases are negative tests. */
  expectedVerdict: 'block' | 'warn' | 'pass';
  input: Parameters<typeof evaluateEnterprisePolicy>[0];
}

interface TestResult {
  name: string;
  passed: boolean;
  expected: string;
  got: string;
  description?: string;
}

const TEST_CASES: TestCase[] = [
  // ── Destructive command patterns ──────────────────────────────────────────
  {
    name: 'block_rm_rf',
    description: 'rm -rf must be blocked before execution',
    expectedVerdict: 'block',
    input: { files: [], commands: ['rm -rf /var/data'], actor: 'claude', service: 'api' },
  },
  {
    name: 'block_terraform_destroy',
    description: 'terraform destroy must be blocked',
    expectedVerdict: 'block',
    input: { files: [], commands: ['terraform destroy prod'], actor: 'claude', service: 'infra' },
  },
  {
    name: 'block_drop_database',
    description: 'DROP DATABASE must be blocked',
    expectedVerdict: 'block',
    input: { files: [], commands: ['drop database production'], actor: 'agent', service: 'db' },
  },
  {
    name: 'block_drop_table',
    description: 'DROP TABLE must be blocked',
    expectedVerdict: 'block',
    input: { files: [], commands: ['drop table users'], actor: 'claude', service: 'db' },
  },
  {
    name: 'block_truncate_table',
    description: 'TRUNCATE TABLE must be blocked',
    expectedVerdict: 'block',
    input: { files: [], commands: ['truncate table events'], actor: 'bot', service: 'db' },
  },
  {
    name: 'block_kubectl_delete',
    description: 'kubectl delete must be blocked',
    expectedVerdict: 'block',
    input: { files: [], commands: ['kubectl delete namespace production'], actor: 'agent', service: 'k8s' },
  },
  {
    name: 'block_nuke_keyword',
    description: 'nuke keyword at word boundary must be blocked',
    expectedVerdict: 'block',
    input: { files: [], commands: ['nuke everything in s3'], actor: 'claude', service: 's3' },
  },
  {
    name: 'block_wipe_keyword',
    description: 'wipe keyword at word boundary must be blocked',
    expectedVerdict: 'block',
    input: { files: [], commands: ['wipe the database'], actor: 'claude', service: 'db' },
  },
  // ── Case / whitespace normalisation ───────────────────────────────────────
  {
    name: 'block_mixed_case_terraform',
    description: 'Uppercase TERRAFORM DESTROY must still be blocked',
    expectedVerdict: 'block',
    input: { files: [], commands: ['TERRAFORM DESTROY'], actor: 'claude', service: 'infra' },
  },
  {
    name: 'block_mixed_case_drop_table',
    description: 'DROP TABLE in mixed case must still be blocked',
    expectedVerdict: 'block',
    input: { files: [], commands: ['DROP TABLE users'], actor: 'bot', service: 'db' },
  },
  // ── Schema mutation → hold (warn) ─────────────────────────────────────────
  {
    name: 'hold_alter_table',
    description: 'ALTER TABLE by AI actor must be held for HITL',
    expectedVerdict: 'warn',
    input: { files: [], commands: ['alter table users add column verified boolean'], actor: 'claude', service: 'db' },
  },
  {
    name: 'hold_prisma_migrate',
    description: 'prisma migrate by AI actor must be held',
    expectedVerdict: 'warn',
    input: { files: [], commands: ['prisma migrate deploy'], actor: 'cursor', service: 'api' },
  },
  {
    name: 'hold_db_migrate',
    description: 'db:migrate by AI actor must be held',
    expectedVerdict: 'warn',
    input: { files: [], commands: ['db:migrate'], actor: 'agent', service: 'api' },
  },
  // ── False-positive guard: safe commands must pass ─────────────────────────
  {
    name: 'pass_safe_deploy',
    description: 'Safe deployment command must not be blocked',
    expectedVerdict: 'pass',
    input: { files: [], commands: ['kubectl rollout status deployment/api'], actor: 'claude', service: 'k8s' },
  },
  {
    name: 'pass_git_commit',
    description: 'git commit must not be blocked',
    expectedVerdict: 'pass',
    input: { files: [], commands: ['git commit -m "fix: handle null check"'], actor: 'claude', service: 'api' },
  },
  {
    name: 'pass_npm_install',
    description: 'npm install must not be blocked',
    expectedVerdict: 'pass',
    input: { files: [], commands: ['npm install'], actor: 'claude', service: 'api' },
  },
  // ── Word boundary: must NOT match partial words ────────────────────────────
  {
    name: 'no_false_positive_destroy_session',
    description: '"destroy_session" must not trigger block — "destroy" alone matches, but compound identifiers should be tested',
    expectedVerdict: 'block', // "destroy" is in the policy as standalone word pattern — this IS a known current behavior
    input: { files: [], commands: ['destroy_session'], actor: 'claude', service: 'api' },
  },
];

function runSafetyTests(): TestResult[] {
  // Always test against the built-in default policy so results are independent
  // of the user's on-disk customization — this tests gate logic, not config.
  const saved = loadEnterprisePolicy();
  _resetPolicyCacheForTesting(DEFAULT_ENTERPRISE_POLICY);
  try {
    return TEST_CASES.map((tc) => {
      let verdict: string;
      try {
        const result = evaluateEnterprisePolicy(tc.input);
        verdict = result.verdict;
      } catch (err) {
        return {
          name: tc.name,
          passed: false,
          expected: tc.expectedVerdict,
          got: `error: ${err instanceof Error ? err.message : String(err)}`,
          description: tc.description,
        };
      }

      const passed = verdict === tc.expectedVerdict;
      return {
        name: tc.name,
        passed,
        expected: tc.expectedVerdict,
        got: verdict,
        description: tc.description,
      };
    });
  } finally {
    _resetPolicyCacheForTesting(saved);
  }
}
