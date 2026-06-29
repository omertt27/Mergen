/**
 * adversarial-eval.test.ts — Dataset-driven adversarial gate benchmark.
 *
 * Loads adversarial-dataset.json and runs every case through
 * evaluateEnterprisePolicy against the DEFAULT_ENTERPRISE_POLICY so results
 * are independent of on-disk user config.
 *
 * Three classes of case:
 *
 *   Normal cases       — expected verdict must match; failure is a regression.
 *   knownGap: true     — gate is expected to miss the attack; test passes when
 *                        the case evades (expectedVerdict: 'pass'). If the gate
 *                        DOES catch it, we mark it as a "closed gap" in the
 *                        report (nice to know, not a failure).
 *   isFalsePositive    — gate incorrectly blocks a legitimate command. Test
 *                        passes when the case blocks (expectedVerdict: 'block').
 *                        These are reported separately as the gate FP count.
 *
 * Summary output (always printed):
 *   PASS/FAIL counts by category, gate FP rate, documented gap count,
 *   and a publishable one-line credential string.
 *
 * Use `npm test -- adversarial-eval` to run in isolation.
 * Use `GET /safety-test?verbose=1` for the inline server endpoint that runs
 * the original hand-authored cases against a live deployment.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  evaluateEnterprisePolicy,
  DEFAULT_ENTERPRISE_POLICY,
  _resetPolicyCacheForTesting,
  type EvaluationInput,
} from '../../intelligence/enterprise-policy-engine.js';

// ── Dataset types ─────────────────────────────────────────────────────────────

interface AdversarialCase {
  id: string;
  category: string;
  description: string;
  input: EvaluationInput;
  expectedVerdict: 'block' | 'warn' | 'pass';
  knownGap?: boolean;
  isFalsePositive?: boolean;
  note?: string;
}

interface Dataset {
  version: string;
  description: string;
  cases: AdversarialCase[];
}

// ── Load dataset ──────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const datasetPath = join(__dir, 'adversarial-dataset.json');
// Strip // line comments before parsing (dataset uses them for section headers).
const rawJson = readFileSync(datasetPath, 'utf8').replace(/^\s*\/\/.*$/gm, '');
const dataset: Dataset = JSON.parse(rawJson);

// ── Metrics accumulator ───────────────────────────────────────────────────────

interface CaseSummary {
  id: string;
  category: string;
  description: string;
  expected: string;
  got: string;
  passed: boolean;
  knownGap: boolean;
  isFalsePositive: boolean;
  gapClosed: boolean;  // knownGap case where gate now catches it (improvement)
}

const summaries: CaseSummary[] = [];

// Use the default policy throughout so results are reproducible.
_resetPolicyCacheForTesting(DEFAULT_ENTERPRISE_POLICY);

// ── Test runner ───────────────────────────────────────────────────────────────

describe('Adversarial Gate Eval', () => {
  for (const tc of dataset.cases) {
    const isGap = tc.knownGap === true;
    const isFP  = tc.isFalsePositive === true;

    it(`[${tc.category}] ${tc.id}: ${tc.description}`, () => {
      let verdict: string;
      try {
        const result = evaluateEnterprisePolicy(tc.input);
        verdict = result.verdict;
      } catch (err) {
        verdict = `error: ${err instanceof Error ? err.message : String(err)}`;
      }

      const verdictMatches = verdict === tc.expectedVerdict;

      // A known gap that now gets caught = improvement, not failure.
      // We flip the check: if expectedVerdict='pass' and gate returns 'block',
      // that is a closed gap — we still log it but don't fail the test.
      const gapClosed = isGap && !verdictMatches && verdict === 'block';

      summaries.push({
        id: tc.id,
        category: tc.category,
        description: tc.description,
        expected: tc.expectedVerdict,
        got: verdict,
        passed: verdictMatches || gapClosed,
        knownGap: isGap,
        isFalsePositive: isFP,
        gapClosed,
      });

      if (isGap) {
        // Known gap: pass when gate misses (expected), note when gate catches (improvement).
        if (gapClosed) {
          // Gate now catches this — log but don't fail. Update dataset to remove knownGap.
          console.info(`  ✓ closed gap: ${tc.id} — gate now blocks "${tc.description}"`);
        } else {
          expect(verdict).toBe(tc.expectedVerdict);
        }
      } else {
        // Normal case and known FP: verdict must match expected exactly.
        expect(verdict).toBe(tc.expectedVerdict);
      }
    });
  }

  afterAll(() => {
    _resetPolicyCacheForTesting(DEFAULT_ENTERPRISE_POLICY);
    printSummary(summaries);
  });
});

// ── Summary printer ───────────────────────────────────────────────────────────

function printSummary(sums: CaseSummary[]): void {
  const total        = sums.length;
  const normalCases  = sums.filter((s) => !s.knownGap && !s.isFalsePositive);
  const gapCases     = sums.filter((s) => s.knownGap);
  const fpCases      = sums.filter((s) => s.isFalsePositive);
  const closedGaps   = gapCases.filter((s) => s.gapClosed);
  const openGaps     = gapCases.length - closedGaps.length;

  const normalPassed  = normalCases.filter((s) => s.passed).length;
  const normalFailed  = normalCases.length - normalPassed;
  const fpCount       = fpCases.length;   // cases where gate incorrectly blocks legitimate commands

  // Category breakdown for normal + FP guard cases.
  const byCategory: Record<string, { pass: number; fail: number }> = {};
  for (const s of sums.filter((s) => !s.knownGap)) {
    const cat = s.category;
    if (!byCategory[cat]) byCategory[cat] = { pass: 0, fail: 0 };
    if (s.passed) byCategory[cat].pass++;
    else byCategory[cat].fail++;
  }

  const lines: string[] = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '  MERGEN ADVERSARIAL GATE EVAL — SUMMARY',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `  Total cases        : ${total}`,
    `  Normal cases       : ${normalCases.length}  (${normalPassed} passed, ${normalFailed} failed)`,
    `  Known gate gaps    : ${gapCases.length}  (${openGaps} open, ${closedGaps.length} closed by gate)`,
    `  Known false pos.   : ${fpCount}  (legitimate commands the gate currently blocks)`,
    '',
    '  Category breakdown (normal + FP guard cases):',
  ];

  const catWidth = Math.max(...Object.keys(byCategory).map((c) => c.length), 20);
  for (const [cat, counts] of Object.entries(byCategory).sort()) {
    const total = counts.pass + counts.fail;
    const pct   = total > 0 ? Math.round((counts.pass / total) * 100) : 0;
    const bar   = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    lines.push(`    ${cat.padEnd(catWidth)}  ${bar}  ${pct}% (${counts.pass}/${total})`);
  }

  lines.push('');

  if (closedGaps.length > 0) {
    lines.push('  Gaps closed since last eval (update knownGap: remove from dataset):');
    for (const g of closedGaps) lines.push(`    + ${g.id}: ${g.description}`);
    lines.push('');
  }

  if (normalFailed > 0) {
    lines.push('  FAILURES (unexpected — these are regressions):');
    for (const s of normalCases.filter((s) => !s.passed)) {
      lines.push(`    ✗ ${s.id}: expected '${s.expected}', got '${s.got}'`);
      lines.push(`      ${s.description}`);
    }
    lines.push('');
  }

  // Publishable credential line.
  const pct = normalCases.length > 0
    ? Math.round((normalPassed / normalCases.length) * 100)
    : 0;
  lines.push(
    `  PUBLISHABLE: ${normalPassed}/${normalCases.length} adversarial cases blocked ` +
    `(${pct}%), ${fpCount} known false positives, ${openGaps} documented evasion gaps`,
  );
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  console.info(lines.join('\n'));
}