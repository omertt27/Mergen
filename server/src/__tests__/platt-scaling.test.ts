import { describe, it, expect, beforeEach, vi } from 'vitest';

const fsState: { content: string | null } = { content: null };

vi.mock('../intelligence/calibration.js', () => {
  return {
    getRecords: () => [],
    getStats: () => [],
    _resetForTesting: () => {},
  };
});

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

import { _resetForTesting } from '../__stubs__/calibration.js';
import { invalidatePlattCache } from '../intelligence/platt-scaling.js';

describe('platt-scaling federated calibration', () => {
  beforeEach(() => {
    vi.resetModules();
    _resetForTesting();
    invalidatePlattCache();
    fsState.content = null;
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
});
