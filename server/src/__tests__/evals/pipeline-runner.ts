/**
 * Shared infra detector pipeline runner.
 *
 * Single source of truth used by:
 *   - detector-evals.test.ts    (Level 1 individual + regression suite)
 *   - calibration-replay.test.ts (Level 2 corpus replay)
 *
 * Previously duplicated in both files; any change to ranking logic now only
 * needs to happen here. update-eval-baseline.mjs has its own copy because it
 * loads from dist/ rather than src/ and cannot share test-file imports.
 */

import { ALL_INFRA_DETECTORS } from '../../intelligence/infra-detectors.js';
import type { InfraEvent } from '../../sensor/infra-normalizer.js';
import type { Hypothesis } from '../../intelligence/causal.js';

/**
 * Run all infra detectors over events and return the top hypothesis
 * (highest confidenceScore), or null if nothing fires.
 */
export function runInfraPipeline(events: InfraEvent[]): Hypothesis | null {
  const results = ALL_INFRA_DETECTORS
    .map((detect) => detect(events))
    .filter((h): h is Hypothesis => h !== null);

  if (results.length === 0) return null;
  return results.reduce((best, h) => h.confidenceScore > best.confidenceScore ? h : best);
}
