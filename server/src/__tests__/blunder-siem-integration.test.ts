/**
 * blunder-siem-integration.test.ts — confirms recordBlunder() actually
 * triggers siem-forward.ts's forwardToSiem() (P0.5), not just that the
 * forwarder works in isolation (covered by siem-forward.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockForwardToSiem = vi.fn();
vi.mock('../intelligence/siem-forward.js', () => ({
  forwardToSiem: (...a: unknown[]) => mockForwardToSiem(...a),
}));

process.env.MERGEN_ZERO_RETENTION = 'true'; // no real disk writes for this test

import { recordBlunder, _resetForTesting } from '../sensor/agent-blunder-store.js';

beforeEach(() => {
  _resetForTesting();
  mockForwardToSiem.mockReset();
});

describe('recordBlunder → siem-forward integration', () => {
  it('calls forwardToSiem with the recorded entry', async () => {
    recordBlunder({
      blunderType: 'pipeline_block',
      command: 'terraform destroy',
      blockReason: 'destructive command',
      service: 'infra',
      tag: null,
      actor: 'agent',
      pid: null,
      confidenceScore: null,
    });

    // The call is a dynamic import().then(...) — flush microtasks before asserting.
    await new Promise((r) => setTimeout(r, 10));

    expect(mockForwardToSiem).toHaveBeenCalledTimes(1);
    const [entry] = mockForwardToSiem.mock.calls[0];
    expect(entry.command).toBe('terraform destroy');
    expect(entry.blunderType).toBe('pipeline_block');
  });
});
