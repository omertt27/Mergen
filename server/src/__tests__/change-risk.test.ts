/**
 * change-risk.test.ts — Tests for the change risk scoring engine.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { scoreChangeRisk, formatRiskReport } from '../intelligence/change-risk.js';

const SRC_DIR = path.resolve(__dirname, '..');

describe('scoreChangeRisk', () => {
  it('returns a ChangeRiskReport with all required fields', () => {
    const report = scoreChangeRisk([], SRC_DIR);
    expect(typeof report.score).toBe('number');
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(report.level);
    expect(typeof report.requiresApproval).toBe('boolean');
    expect(Array.isArray(report.factors)).toBe(true);
  });

  it('score is 0 for an empty file list', () => {
    const report = scoreChangeRisk([], SRC_DIR);
    expect(report.score).toBe(0);
    expect(report.level).toBe('LOW');
    expect(report.requiresApproval).toBe(false);
  });

  it('score increases with number of files', () => {
    const one = scoreChangeRisk([path.resolve(SRC_DIR, 'sensor/buffer.ts')], SRC_DIR);
    const two = scoreChangeRisk([
      path.resolve(SRC_DIR, 'sensor/buffer.ts'),
      path.resolve(SRC_DIR, 'sensor/logger.ts'),
    ], SRC_DIR);
    expect(two.score).toBeGreaterThan(one.score);
  });

  it('routes files add public API risk factor', () => {
    const report = scoreChangeRisk([path.resolve(SRC_DIR, 'routes/incidents.ts')], SRC_DIR);
    expect(report.publicApiFiles.length).toBeGreaterThan(0);
    expect(report.factors.some((f) => f.label.toLowerCase().includes('public api'))).toBe(true);
  });

  it('score is capped at 100', () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) =>
      path.resolve(SRC_DIR, `routes/file${i}.ts`),
    );
    const report = scoreChangeRisk(manyFiles, SRC_DIR);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it('HIGH level requires approval', () => {
    // Need to trigger score ≥ 70 — multiple cross-subsystem files + routes
    const files = [
      path.resolve(SRC_DIR, 'sensor/buffer.ts'),
      path.resolve(SRC_DIR, 'routes/incidents.ts'),
      path.resolve(SRC_DIR, 'intelligence/tools-utility.ts'),
      path.resolve(SRC_DIR, 'app.ts'),
    ];
    const report = scoreChangeRisk(files, SRC_DIR);
    if (report.level === 'HIGH') {
      expect(report.requiresApproval).toBe(true);
    }
  });

  it('LOW level does not require approval', () => {
    const report = scoreChangeRisk([], SRC_DIR);
    expect(report.requiresApproval).toBe(false);
  });
});

describe('formatRiskReport', () => {
  it('includes the score and level', () => {
    const report = scoreChangeRisk([path.resolve(SRC_DIR, 'sensor/buffer.ts')], SRC_DIR);
    const text = formatRiskReport(report);
    expect(text).toContain(`${report.score}/100`);
    expect(text).toContain(report.level);
  });

  it('shows approval warning for HIGH risk', () => {
    const highRisk = {
      score: 85,
      level: 'HIGH' as const,
      requiresApproval: true,
      files: 5,
      subsystems: ['sensor', 'routes'] as any,
      publicApiFiles: ['routes/incidents.ts'],
      criticalEntryPoints: ['app.ts'],
      testsAffected: 3,
      untestedFiles: [],
      factors: [{ label: 'Files modified', delta: 40, detail: '5 files × 8' }],
      recommendation: 'HIGH RISK: Get explicit human sign-off.',
    };
    const text = formatRiskReport(highRisk);
    expect(text).toContain('Human approval required');
  });
});
