import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Co-located tests (e.g. src/intelligence/calibration.test.ts) and the
    // legacy __tests__/ directory are both discovered.
    include: ['src/**/*.test.ts'],
    // Exclude placeholder / redirect stubs that contain no test suites.
    exclude: ['src/__tests__/calibration.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
    },
  },
});
