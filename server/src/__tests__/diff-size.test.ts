/**
 * diff-size.test.ts — P1.4 diff explosion / diff-size detector.
 */
import { describe, it, expect } from 'vitest';
import { evaluateDiffSize } from '../intelligence/diff-size.js';

describe('evaluateDiffSize', () => {
  it('is LOW for a small, typical PR', () => {
    const report = evaluateDiffSize({ filesChanged: 3, additions: 40, deletions: 10 }, { actorIsAi: false });
    expect(report.level).toBe('LOW');
    expect(report.requiresApproval).toBe(false);
    expect(report.factors).toHaveLength(0);
  });

  it('flags a diff over the line threshold', () => {
    const report = evaluateDiffSize({ filesChanged: 5, additions: 400, deletions: 200 }, { actorIsAi: false });
    expect(report.totalLines).toBe(600);
    expect(report.factors.some((f) => f.label === 'Large diff')).toBe(true);
    expect(report.score).toBeGreaterThan(0);
  });

  it('flags a diff over the file-count threshold', () => {
    const report = evaluateDiffSize({ filesChanged: 30, additions: 50, deletions: 10 }, { actorIsAi: false });
    expect(report.factors.some((f) => f.label === 'Many files touched')).toBe(true);
  });

  it('adds an extra factor for an AI-authored large diff, not for a human one', () => {
    const stats = { filesChanged: 5, additions: 400, deletions: 200 };
    const aiReport = evaluateDiffSize(stats, { actorIsAi: true });
    const humanReport = evaluateDiffSize(stats, { actorIsAi: false });
    expect(aiReport.factors.some((f) => f.label === 'AI-authored large diff')).toBe(true);
    expect(humanReport.factors.some((f) => f.label === 'AI-authored large diff')).toBe(false);
    expect(aiReport.score).toBeGreaterThan(humanReport.score);
  });

  it('does not add the AI upgrade factor when the diff is small, even for an AI actor', () => {
    const report = evaluateDiffSize({ filesChanged: 2, additions: 30, deletions: 5 }, { actorIsAi: true });
    expect(report.factors.some((f) => f.label === 'AI-authored large diff')).toBe(false);
  });

  it('reaches HIGH / requiresApproval for a genuinely large AI-authored diff', () => {
    const report = evaluateDiffSize({ filesChanged: 50, additions: 3000, deletions: 1000 }, { actorIsAi: true });
    expect(report.level).toBe('HIGH');
    expect(report.requiresApproval).toBe(true);
    expect(report.score).toBe(100); // clamped
  });

  it('clamps negative stats to zero rather than producing a negative score', () => {
    const report = evaluateDiffSize({ filesChanged: -1, additions: -100, deletions: -50 }, { actorIsAi: false });
    expect(report.filesChanged).toBe(0);
    expect(report.additions).toBe(0);
    expect(report.deletions).toBe(0);
    expect(report.score).toBe(0);
  });
});
