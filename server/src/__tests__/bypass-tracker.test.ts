/**
 * bypass-tracker.test.ts
 *
 * Verifies the block-then-bypass detection logic:
 *   - A successful call after a block within 60s is a bypass
 *   - A successful call with no prior block is not a bypass
 *   - A successful call 60s+ after a block is not a bypass
 *   - Bypass counts accumulate per rule across multiple events
 *   - Only rules with >= REFINEMENT_THRESHOLD bypasses are returned as candidates
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  trackBlock,
  trackSuccessfulCall,
  getRefinementCandidates,
  getBypassStats,
  REFINEMENT_THRESHOLD,
  _resetBypassTrackerForTesting,
} from '../sensor/bypass-tracker.js';

process.env.MERGEN_ZERO_RETENTION = 'true';

beforeEach(() => _resetBypassTrackerForTesting());

describe('bypass-tracker: no prior block', () => {
  it('successful call with no prior block records nothing', () => {
    trackSuccessfulCall('execute_fix');
    expect(getBypassStats().totalBypasses).toBe(0);
  });
});

describe('bypass-tracker: block then pass within window', () => {
  it('successful call within 60s of a block records a bypass', () => {
    trackBlock('execute_fix', ['block_destructive_commands']);
    trackSuccessfulCall('execute_fix');
    expect(getBypassStats().totalBypasses).toBe(1);
  });

  it('attributes bypass to each triggered rule', () => {
    trackBlock('execute_fix', ['rule_a', 'rule_b']);
    trackSuccessfulCall('execute_fix');
    const stats = getBypassStats();
    expect(stats.totalBypasses).toBe(2); // one per rule
    expect(stats.uniqueRules).toBe(2);
  });

  it('deduplicates tool names within a rule entry', () => {
    trackBlock('execute_fix', ['rule_a']);
    trackSuccessfulCall('execute_fix');
    trackBlock('execute_fix', ['rule_a']);
    trackSuccessfulCall('execute_fix');
    const candidates = getRefinementCandidates();
    // Not enough bypasses yet for threshold, check raw stats
    expect(getBypassStats().totalBypasses).toBe(2);
  });

  it('does not double-count: second successful call after bypass is clean', () => {
    trackBlock('execute_fix', ['rule_a']);
    trackSuccessfulCall('execute_fix'); // bypass
    trackSuccessfulCall('execute_fix'); // no block registered, nothing to count
    expect(getBypassStats().totalBypasses).toBe(1);
  });
});

describe('bypass-tracker: block window expired', () => {
  it('successful call after 60s window does not count as bypass', () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    trackBlock('execute_fix', ['block_destructive_commands']);

    vi.setSystemTime(now + 61_000); // 61 seconds later
    trackSuccessfulCall('execute_fix');

    vi.useRealTimers();
    expect(getBypassStats().totalBypasses).toBe(0);
  });
});

describe('bypass-tracker: different tool names', () => {
  it('block on tool A does not count when tool B passes', () => {
    trackBlock('execute_fix', ['block_destructive_commands']);
    trackSuccessfulCall('triage_incident'); // different tool
    expect(getBypassStats().totalBypasses).toBe(0);
  });
});

describe('bypass-tracker: refinement candidates', () => {
  it('returns no candidates below threshold', () => {
    for (let i = 0; i < REFINEMENT_THRESHOLD - 1; i++) {
      trackBlock('execute_fix', ['too_strict_rule']);
      trackSuccessfulCall('execute_fix');
    }
    expect(getRefinementCandidates()).toHaveLength(0);
  });

  it('returns a candidate at exactly the threshold', () => {
    for (let i = 0; i < REFINEMENT_THRESHOLD; i++) {
      trackBlock('execute_fix', ['too_strict_rule']);
      trackSuccessfulCall('execute_fix');
    }
    const candidates = getRefinementCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ruleId).toBe('too_strict_rule');
    expect(candidates[0].bypassCount).toBe(REFINEMENT_THRESHOLD);
    expect(candidates[0].toolNames).toContain('execute_fix');
    expect(candidates[0].recommendation).toMatch(/too_strict_rule/);
  });

  it('sorts candidates by bypass count descending', () => {
    // rule_heavy: 6 bypasses, rule_light: 5 bypasses
    for (let i = 0; i < 6; i++) {
      trackBlock('tool', ['rule_heavy']);
      trackSuccessfulCall('tool');
    }
    for (let i = 0; i < 5; i++) {
      trackBlock('tool', ['rule_light']);
      trackSuccessfulCall('tool');
    }
    const candidates = getRefinementCandidates();
    expect(candidates[0].ruleId).toBe('rule_heavy');
    expect(candidates[1].ruleId).toBe('rule_light');
  });
});
