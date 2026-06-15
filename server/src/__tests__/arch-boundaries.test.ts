/**
 * arch-boundaries.test.ts — Tests for the architectural boundary checker.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { checkBoundaries, DEFAULT_BOUNDARY_RULES, formatBoundaryReport } from '../intelligence/arch-boundaries.js';

const SRC_DIR = path.resolve(__dirname, '..');

describe('DEFAULT_BOUNDARY_RULES', () => {
  it('has rules for sensor, intelligence, and datadog zones', () => {
    const zones = DEFAULT_BOUNDARY_RULES.map((r) => r.fromZone);
    expect(zones).toContain('sensor');
    expect(zones).toContain('intelligence');
    expect(zones).toContain('datadog');
  });

  it('sensor cannot import routes', () => {
    const sensorRule = DEFAULT_BOUNDARY_RULES.find((r) => r.fromZone === 'sensor');
    expect(sensorRule?.cannotImport).toContain('routes');
  });

  it('intelligence cannot import routes', () => {
    const rule = DEFAULT_BOUNDARY_RULES.find((r) => r.fromZone === 'intelligence');
    expect(rule?.cannotImport).toContain('routes');
  });

  it('all rules have non-empty rationale', () => {
    for (const rule of DEFAULT_BOUNDARY_RULES) {
      expect(rule.rationale.length).toBeGreaterThan(10);
    }
  });
});

describe('checkBoundaries', () => {
  it('returns a BoundaryCheckResult with correct shape', () => {
    const result = checkBoundaries({ srcDir: SRC_DIR });
    expect(typeof result.filesChecked).toBe('number');
    expect(typeof result.rulesApplied).toBe('number');
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('filesChecked is greater than 0', () => {
    const result = checkBoundaries({ srcDir: SRC_DIR });
    expect(result.filesChecked).toBeGreaterThan(0);
  });

  it('rulesApplied equals DEFAULT_BOUNDARY_RULES length', () => {
    const result = checkBoundaries({ srcDir: SRC_DIR });
    expect(result.rulesApplied).toBe(DEFAULT_BOUNDARY_RULES.length);
  });

  it('each violation has file, fromZone, importedFile, importedZone', () => {
    const result = checkBoundaries({ srcDir: SRC_DIR });
    for (const v of result.violations) {
      expect(v.file).toBeTruthy();
      expect(v.fromZone).toBeTruthy();
      expect(v.importedFile).toBeTruthy();
      expect(v.importedZone).toBeTruthy();
      expect(v.relativeFile).toBeTruthy();
      expect(v.relativeImport).toBeTruthy();
    }
  });
});

describe('formatBoundaryReport', () => {
  it('returns a PASS report when there are no violations', () => {
    const result = { violations: [], filesChecked: 42, rulesApplied: 3, cleanFiles: 42 };
    const text = formatBoundaryReport(result, SRC_DIR);
    expect(text).toContain('PASS');
    expect(text).toContain('42 files');
  });

  it('returns a FAIL report listing violations', () => {
    const violation = {
      file: '/src/sensor/foo.ts',
      fromZone: 'sensor' as const,
      importedFile: '/src/routes/bar.ts',
      importedZone: 'routes' as const,
      rule: DEFAULT_BOUNDARY_RULES[0],
      relativeFile: 'sensor/foo.ts',
      relativeImport: 'routes/bar.ts',
    };
    const result = { violations: [violation], filesChecked: 10, rulesApplied: 3, cleanFiles: 9 };
    const text = formatBoundaryReport(result, SRC_DIR);
    expect(text).toContain('FAIL');
    expect(text).toContain('sensor/foo.ts');
    expect(text).toContain('routes/bar.ts');
  });
});
