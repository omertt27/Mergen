/**
 * vitest.config.ci.ts — CI-safe test configuration.
 *
 * Extends the base config and excludes test files that require closed-source
 * intelligence modules (gitignored .ts files absent in CI).  Those tests pass
 * locally when the full codebase is present but produce confusing stub-driven
 * failures in CI where every import of a closed-source module resolves to a
 * noop stub.
 *
 * Excluded files and the closed-source module they depend on:
 *   causal.test.ts            → intelligence/causal.js        (buildCausalChain)
 *   calibration.test.ts       → intelligence/calibration.js   (recordPrediction, applyCalibration)
 *   silent-detectors.test.ts  → intelligence/causal.js        (buildCausalChain)
 *   usage.test.ts             → intelligence/usage.js, license.js, plans.js
 *   license.test.ts           → intelligence/license.js, plans.js
 *   telemetry.test.ts         → intelligence/telemetry.js
 *   last-pack-enrichment.test.ts → intelligence/causal.js, calibration.js
 *   hypothesis-history.test.ts   → intelligence/hypothesis-history.js
 *
 * To run the full suite locally (requires closed-source modules):
 *   npm test
 *
 * Used by CI:
 *   npm run test:ci:coverage
 */

import { mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(baseConfig, {
  test: {
    exclude: [
      'src/__tests__/causal.test.ts',
      'src/__tests__/calibration.test.ts',
      'src/__tests__/silent-detectors.test.ts',
      'src/__tests__/usage.test.ts',
      'src/__tests__/license.test.ts',
      'src/__tests__/telemetry.test.ts',
      'src/__tests__/last-pack-enrichment.test.ts',
      'src/__tests__/hypothesis-history.test.ts',
    ],
  },
});