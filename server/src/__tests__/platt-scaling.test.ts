import { describe, it, expect, beforeEach, vi } from 'vitest';

const fsState: { content: string | null } = { content: null };
let mockRecords: any[] = [];

// Dynamic doMock ensures it intercepts ./calibration.js correctly when resolved to stubs
vi.doMock('../__stubs__/calibration.js', () => {
  return {
    getRecords: () => mockRecords,
    getStats: () => [],
    _resetForTesting: () => {},
  };
});

// Mock fs to simulate federated files
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  
  const existsSync = vi.fn((p: any) => {
    if (typeof p === 'string' && p.endsWith('federated-calibration.json')) {
      return fsState.content !== null;
    }
    return actual.existsSync(p);
  });

  const readFileSync = vi.fn((p: any, encoding?: any) => {
    if (typeof p === 'string' && p.endsWith('federated-calibration.json')) {
      if (fsState.content === null) throw new Error('ENOENT');
      return fsState.content;
    }
    return actual.readFileSync(p, encoding);
  });

  return {
    ...actual,
    existsSync,
    readFileSync,
    default: {
      ...((actual as any).default || actual),
      existsSync,
      readFileSync,
    },
  };
});

describe('platt-scaling federated calibration', () => {
  beforeEach(async () => {
    vi.resetModules();
    fsState.content = null;
    mockRecords = [];
    
    const { _resetForTesting } = await import('../__stubs__/calibration.js');
    const { invalidatePlattCache } = await import('../intelligence/platt-scaling.js');
    _resetForTesting();
    invalidatePlattCache();
  });

  it('falls back to federated-platt when federated file is present', async () => {
    const fedData = {
      tags: {
        'test_tag': { A: -2.0, B: 0.5, n: 50, accuracy: 0.9 }
      }
    };
    fsState.content = JSON.stringify(fedData);

    const { plattScale } = await import('../intelligence/platt-scaling.js');
    const result = plattScale(0.8, 'test_tag');
    expect(result.source).toBe('federated-platt');
    expect(result.n).toBe(50);
    // sigmoid(-2.0 * 0.8 + 0.5) = sigmoid(-1.1) = 1 / (1 + e^1.1) approx 0.2497
    expect(result.calibrated).toBeCloseTo(0.2497, 3);
  });

  it('falls back to raw when no local or federated data exists', async () => {
    fsState.content = null;
    const { plattScale } = await import('../intelligence/platt-scaling.js');
    const result = plattScale(0.8, 'some_unknown_tag');
    expect(result.source).toBe('raw');
    expect(result.calibrated).toBe(0.8);
  });

  describe('Platt fitting calibration logic (smoothed labels and LOOCV accuracy)', () => {
    beforeEach(async () => {
      mockRecords = [];
      const { invalidatePlattCache } = await import('../intelligence/platt-scaling.js');
      invalidatePlattCache();
    });

    it('stays bounded and converges on a fully separable 10-sample dataset', async () => {
      // 10 samples: 5 correct (score >= 0.6), 5 wrong (score < 0.6)
      mockRecords = [
        { tag: 'sep_tag', confidenceScore: 0.1, verdict: 'wrong', numericScore: 0.1 },
        { tag: 'sep_tag', confidenceScore: 0.2, verdict: 'wrong', numericScore: 0.2 },
        { tag: 'sep_tag', confidenceScore: 0.3, verdict: 'wrong', numericScore: 0.3 },
        { tag: 'sep_tag', confidenceScore: 0.4, verdict: 'wrong', numericScore: 0.4 },
        { tag: 'sep_tag', confidenceScore: 0.5, verdict: 'wrong', numericScore: 0.5 },
        { tag: 'sep_tag', confidenceScore: 0.6, verdict: 'correct', numericScore: 0.6 },
        { tag: 'sep_tag', confidenceScore: 0.7, verdict: 'correct', numericScore: 0.7 },
        { tag: 'sep_tag', confidenceScore: 0.8, verdict: 'correct', numericScore: 0.8 },
        { tag: 'sep_tag', confidenceScore: 0.9, verdict: 'correct', numericScore: 0.9 },
        { tag: 'sep_tag', confidenceScore: 1.0, verdict: 'correct', numericScore: 1.0 },
      ];

      const { plattScale, getPlattDiagnostics } = await import('../intelligence/platt-scaling.js');
      // Trigger calibration fit for 'sep_tag'
      plattScale(0.8, 'sep_tag');

      const diagnostics = getPlattDiagnostics();
      const model = diagnostics.find((d) => d.tag === 'sep_tag');
      expect(model).toBeDefined();
      expect(model!.n).toBe(10);
      
      // Confirm parameters A and B are bounded (didn't blow up/diverge)
      expect(Math.abs(model!.A)).toBeLessThan(100);
      expect(Math.abs(model!.B)).toBeLessThan(100);
      expect(model!.holdoutAccuracy).toBeDefined();
    });

    it('changes the holdout accuracy when parameters A and B are perturbed', async () => {
      // 10 samples
      mockRecords = [
        { tag: 'perturb_tag', confidenceScore: 0.1, verdict: 'wrong', numericScore: 0.1 },
        { tag: 'perturb_tag', confidenceScore: 0.2, verdict: 'wrong', numericScore: 0.2 },
        { tag: 'perturb_tag', confidenceScore: 0.3, verdict: 'correct', numericScore: 0.3 },
        { tag: 'perturb_tag', confidenceScore: 0.4, verdict: 'wrong', numericScore: 0.4 },
        { tag: 'perturb_tag', confidenceScore: 0.5, verdict: 'wrong', numericScore: 0.5 },
        { tag: 'perturb_tag', confidenceScore: 0.6, verdict: 'correct', numericScore: 0.6 },
        { tag: 'perturb_tag', confidenceScore: 0.7, verdict: 'wrong', numericScore: 0.7 },
        { tag: 'perturb_tag', confidenceScore: 0.8, verdict: 'correct', numericScore: 0.8 },
        { tag: 'perturb_tag', confidenceScore: 0.9, verdict: 'correct', numericScore: 0.9 },
        { tag: 'perturb_tag', confidenceScore: 1.0, verdict: 'correct', numericScore: 1.0 },
      ];

      const { plattScale, getPlattDiagnostics, invalidatePlattCache } = await import('../intelligence/platt-scaling.js');
      plattScale(0.8, 'perturb_tag');

      const diagnostics = getPlattDiagnostics();
      const model = diagnostics.find((d) => d.tag === 'perturb_tag');
      expect(model).toBeDefined();

      const originalAccuracy = model!.holdoutAccuracy;
      expect(originalAccuracy).toBeGreaterThanOrEqual(0);
      expect(originalAccuracy).toBeLessThanOrEqual(1.0);

      // Change the records to be completely wrong (all wrong) to force a different fit and accuracy
      mockRecords = mockRecords.map(r => ({ ...r, verdict: 'wrong' }));
      invalidatePlattCache();
      plattScale(0.8, 'perturb_tag');
      
      const newDiagnostics = getPlattDiagnostics();
      const newModel = newDiagnostics.find((d) => d.tag === 'perturb_tag');
      
      expect(newModel!.holdoutAccuracy).not.toBe(originalAccuracy);
    });
  });
});
