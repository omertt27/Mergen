/**
 * execution-gate.test.ts — Unit tests for the execution approval gate.
 *
 * This is the gatekeeper for autonomous fix execution. These tests verify
 * that the approval/deny/expiry lifecycle works correctly and that expired
 * approvals emit on approvalEvents rather than calling a mutable global.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestApproval, approveExecution, denyExecution, pruneExpired, _resetForTesting } from '../intelligence/execution-gate.js';
import { approvalEvents } from '../intelligence/approval-events.js';

beforeEach(() => {
  // Reset in-memory Map and prevent disk reads — without this, load() may
  // restore a real ~/.mergen/approval-pending.json entry from a prior run,
  // contaminating fake-timer expiry assertions.
  _resetForTesting();
  approvalEvents.removeAllListeners();
});

describe('requestApproval / approveExecution', () => {
  it('stores a pending execution and returns it on approve', () => {
    requestApproval({
      pid: 'test-pid-1',
      command: 'systemctl restart api',
      tier: 'restart',
      service: 'api',
      remediationConfidence: 0.91,
    });

    const result = approveExecution('test-pid-1');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe('test-pid-1');
    expect(result!.command).toBe('systemctl restart api');
    expect(result!.tier).toBe('restart');
    expect(result!.remediationConfidence).toBe(0.91);
  });

  it('returns null when pid is unknown', () => {
    expect(approveExecution('no-such-pid')).toBeNull();
  });

  it('removes the record after approval (idempotent — second call returns null)', () => {
    requestApproval({
      pid: 'test-pid-2',
      command: 'kubectl rollout restart deployment/api',
      tier: 'deploy',
      service: 'api',
      remediationConfidence: 0.88,
    });

    approveExecution('test-pid-2');
    expect(approveExecution('test-pid-2')).toBeNull();
  });
});

describe('denyExecution', () => {
  it('returns true and removes the record', () => {
    requestApproval({
      pid: 'test-pid-3',
      command: 'npm run migrate',
      tier: 'deploy',
      service: 'api',
      remediationConfidence: 0.86,
    });

    expect(denyExecution('test-pid-3')).toBe(true);
    expect(approveExecution('test-pid-3')).toBeNull();
  });

  it('returns false when pid is unknown', () => {
    expect(denyExecution('ghost-pid')).toBe(false);
  });
});

describe('pruneExpired → approvalEvents', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits approval:expired with pid and message when window lapses', () => {
    const handler = vi.fn();
    approvalEvents.on('approval:expired', handler);

    requestApproval({
      pid: 'expire-pid',
      command: 'docker restart web',
      tier: 'restart',
      service: 'web',
      remediationConfidence: 0.87,
    });

    // Advance past the 15-minute approval window
    vi.advanceTimersByTime(16 * 60 * 1_000);
    pruneExpired();

    expect(handler).toHaveBeenCalledOnce();
    const [pid, text] = handler.mock.calls[0];
    expect(pid).toBe('expire-pid');
    expect(text).toContain('expired');
  });

  it('does not emit for records still within the window', () => {
    const handler = vi.fn();
    approvalEvents.on('approval:expired', handler);

    requestApproval({
      pid: 'live-pid',
      command: 'docker restart web',
      tier: 'restart',
      service: 'web',
      remediationConfidence: 0.87,
    });

    // Only 5 minutes — still within window
    vi.advanceTimersByTime(5 * 60 * 1_000);
    pruneExpired();

    expect(handler).not.toHaveBeenCalled();

    // Clean up
    denyExecution('live-pid');
  });

  it('removes the record after expiry (approve returns null)', () => {
    requestApproval({
      pid: 'cleanup-pid',
      command: 'service nginx reload',
      tier: 'restart',
      service: 'nginx',
      remediationConfidence: 0.90,
    });

    vi.advanceTimersByTime(16 * 60 * 1_000);
    pruneExpired();

    expect(approveExecution('cleanup-pid')).toBeNull();
  });
});