import { defineConfig, type Plugin } from 'vitest/config';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';

const CAUSAL_STUB        = resolve(__dirname, 'src/__stubs__/causal.ts');
const CALIBRATION_STUB   = resolve(__dirname, 'src/__stubs__/calibration.ts');
const CLOSED_SOURCE_STUB = resolve(__dirname, 'src/__stubs__/closed-source.ts');

/**
 * Redirects closed-source intelligence modules to open-source stubs so Vite
 * can resolve the module graph in CI (where gitignored files don't exist).
 *
 * causal + calibration each get a dedicated stub so individual tests can
 * vi.doMock() them independently without the other being affected.
 *
 * Every other closed-source intelligence/*.js whose .ts file doesn't exist on
 * disk falls back to the generic noop stub.  Open-source intelligence files
 * resolve normally (resolveId returns null → Vite handles them).
 */
function closedSourceStubs(): Plugin {
  return {
    name: 'closed-source-stubs',
    resolveId(source: string, importer?: string) {
      if (/\/causal\.js$/.test(source))      return CAUSAL_STUB;
      if (/\/calibration\.js$/.test(source)) return CALIBRATION_STUB;
      const m = source.match(/\/intelligence\/([^/]+)\.js$/);
      if (m) {
        const tsFile = resolve(__dirname, `src/intelligence/${m[1]}.ts`);
        if (!existsSync(tsFile)) return CLOSED_SOURCE_STUB;
      }
      // Catch relative imports (e.g. './detectors.js') from within intelligence/
      if (source.startsWith('./') && source.endsWith('.js') && importer) {
        const importerDir = dirname(importer);
        if (importerDir.endsWith('/intelligence')) {
          const moduleName = source.slice(2, -3); // strip ./ and .js
          const tsFile = resolve(importerDir, `${moduleName}.ts`);
          if (!existsSync(tsFile)) return CLOSED_SOURCE_STUB;
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [closedSourceStubs()],
  test: {
    // Co-located tests (e.g. src/intelligence/calibration.test.ts) and the
    // legacy __tests__/ directory are both discovered.
    include: ['src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
    },
  },
});