/**
 * blunder-chain.test.ts
 *
 * Regression tests for the hash-chained blunder log.
 *
 * Critical invariants:
 *   1. verifyChain() returns { valid: true, truncated: false } for any chain
 *      with ≤ MAX_BLUNDERS entries (ring buffer has not wrapped).
 *   2. After the 501st entry evicts the 1st, verifyChain() returns
 *      { valid: true, truncated: true } — the surviving entries are verified,
 *      the eviction is honestly reported.
 *   3. Tampering with any entry content causes verifyChain() to return
 *      { valid: false }.
 *   4. Injecting a legacy v1 entry (no hash field) AFTER at least one v2 entry
 *      causes verifyChain() to return { valid: false } — the anchor-reset
 *      exploit described in the audit is closed.
 *
 * These tests do NOT write to disk (MERGEN_ZERO_RETENTION prevents persist()
 * from running, and _resetForTesting() prevents load() from reading files).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordBlunder,
  verifyChain,
  getBlunders,
  MAX_BLUNDERS,
  _resetForTesting,
  _injectRawForTesting,
  type BlunderType,
} from '../sensor/agent-blunder-store.js';

// Prevent any disk I/O in these tests.
process.env.MERGEN_ZERO_RETENTION = 'true';

const BASE_EVENT = {
  blunderType: 'allowlist_block' as BlunderType,
  blockReason: 'test block',
  command:     'rm -rf /',
  service:     'api',
  tag:         'disk_full',
  actor:       'autopilot',
  pid:         'test-pid',
  confidenceScore: 0.9,
} as const;

function recordN(n: number): void {
  for (let i = 0; i < n; i++) {
    recordBlunder({ ...BASE_EVENT, blockReason: `block ${i}` });
  }
}

beforeEach(() => _resetForTesting());

// ── Pre-wraparound ─────────────────────────────────────────────────────────────

describe('hash chain: before ring buffer wraps (≤ 500 entries)', () => {
  it('verifyChain() is valid and not truncated for a single entry', () => {
    recordBlunder(BASE_EVENT);
    const result = verifyChain();
    expect(result.valid).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.verified).toBe(1);
  });

  it('verifyChain() is valid and not truncated for 100 entries', () => {
    recordN(100);
    const result = verifyChain();
    expect(result.valid).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.verified).toBe(100);
  });

  it('verifyChain() is valid and not truncated for exactly MAX_BLUNDERS entries', () => {
    recordN(MAX_BLUNDERS);
    expect(getBlunders()).toHaveLength(MAX_BLUNDERS);
    const result = verifyChain();
    expect(result.valid).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.verified).toBe(MAX_BLUNDERS);
  });
});

// ── Post-wraparound ────────────────────────────────────────────────────────────

describe('hash chain: after ring buffer wraps (> 500 entries)', () => {
  it('verifyChain() is valid AND truncated after MAX_BLUNDERS+1 entries evicts the 1st', () => {
    // Record exactly MAX_BLUNDERS+1 blunders. The last entry triggers eviction of entry 0.
    recordN(MAX_BLUNDERS + 1);
    expect(getBlunders()).toHaveLength(MAX_BLUNDERS);

    const result = verifyChain();
    expect(result.valid).toBe(true);
    expect(result.truncated).toBe(true);       // eviction occurred
    expect(result.verified).toBe(MAX_BLUNDERS); // all surviving entries verified
    expect(result.verifiedFrom).toBeTruthy();
  });

  it('verifyChain() is valid AND truncated after two full rotations', () => {
    recordN(MAX_BLUNDERS * 2);
    expect(getBlunders()).toHaveLength(MAX_BLUNDERS);
    const result = verifyChain();
    expect(result.valid).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.verified).toBe(MAX_BLUNDERS);
  });

  it('verifyChain() reports the correct verifiedFrom entry id', () => {
    recordN(MAX_BLUNDERS + 1);
    const blunders = getBlunders();
    const oldestEntry = blunders[0]; // formerly entry 1

    const result = verifyChain();
    expect(result.verifiedFrom).toBe(oldestEntry.id);
  });
});

// ── Tamper detection ───────────────────────────────────────────────────────────

describe('hash chain: tamper detection', () => {
  it('detects modification to blockReason of the first entry', () => {
    recordN(3);
    const blunders = getBlunders();
    // Tamper: modify the first entry's content
    (blunders[0] as { blockReason: string }).blockReason = 'tampered!';

    const result = verifyChain();
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIdx).toBe(0);
  });

  it('detects modification to the hash of a middle entry', () => {
    recordN(5);
    const blunders = getBlunders();
    // Tamper: corrupt the hash of entry 2
    (blunders[2] as { hash: string }).hash = '0'.repeat(64);

    const result = verifyChain();
    expect(result.valid).toBe(false);
    // Entry 2's hash is wrong, OR entry 3's previousHash won't match entry 2's hash
    expect(result.firstInvalidIdx).toBeGreaterThanOrEqual(2);
    expect(result.firstInvalidIdx).toBeLessThanOrEqual(3);
  });

  it('detects deletion of a middle entry (previousHash chain break)', () => {
    recordN(5);
    const blunders = getBlunders();
    // Remove entry 2 — entry 3's previousHash now points to entry 2 (gone)
    blunders.splice(2, 1);

    // We need to access the internal array to test this. Since getBlunders()
    // returns a copy, we test via the verifyChain() behavior when we manually
    // reconstruct: inject the 4 remaining entries as raw entries.
    _resetForTesting();
    for (const b of blunders) {
      _injectRawForTesting(b);
    }

    const result = verifyChain();
    // Entry at new index 2 (formerly entry 3) has a previousHash that no
    // longer matches its predecessor (now entry 1). Chain is broken.
    expect(result.valid).toBe(false);
  });
});

// ── Legacy-entry injection exploit ────────────────────────────────────────────

describe('hash chain: legacy-entry anchor-reset exploit (closed)', () => {
  it('a v1 entry (no hash) injected after v2 entries causes valid: false', () => {
    // Record 3 real v2 blunders.
    recordN(3);

    // Inject a v1-format entry (no hash/previousHash) after the v2 entries.
    // Under the OLD code, this would reset expectedPrev to GENESIS_HASH,
    // allowing a subsequent modified entry to pass verification.
    _injectRawForTesting({
      id:           'legacy-injected',
      recordedAt:   Date.now(),
      blunderType:  'allowlist_block',
      blockReason:  'legacy format entry',
      command:      null,
      service:      null,
      tag:          null,
      actor:        null,
      pid:          null,
      confidenceScore: null,
      // No hash or previousHash — simulates a pre-v2 entry injected mid-chain
      previousHash: '',
      hash:         '',
    });

    const result = verifyChain();
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing hash field after v2 section/);
  });

  it('v1 entries that form an ALL-v1 log do not trigger a false negative', () => {
    // All entries are v1 (no hash). This is the legitimate "before migration"
    // scenario. verifyChain() should not report valid: false — there's nothing
    // to verify, but the chain was never cryptographically protected.
    _injectRawForTesting({
      id: 'pre-v2-entry', recordedAt: Date.now(),
      blunderType: 'allowlist_block', blockReason: 'old format',
      previousHash: '', hash: '', // no hash — v1 format
    });

    const result = verifyChain();
    // All-v1 log: valid=true, verified=0 (no v2 entries to verify)
    expect(result.valid).toBe(true);
    expect(result.verified).toBe(0);
  });

  it('a v1 entry before ANY v2 entries does not count as an injection', () => {
    // Inject a v1 entry FIRST, then real v2 entries.
    // The v1 entry is in the legacy preamble — valid behavior.
    _injectRawForTesting({
      id: 'v1-preamble', recordedAt: Date.now() - 10_000,
      blunderType: 'allowlist_block', blockReason: 'legacy',
      previousHash: '', hash: '',
    });

    // Now add v2 entries via the real recordBlunder()
    recordN(2);

    // The first v2 entry's previousHash will be GENESIS_HASH (new chain after
    // v1 preamble). The chain should be valid.
    const result = verifyChain();
    expect(result.valid).toBe(true);
    expect(result.verified).toBe(2); // only the v2 entries count
    expect(result.truncated).toBe(false);
  });
});

// ── Empty log ──────────────────────────────────────────────────────────────────

describe('hash chain: edge cases', () => {
  it('verifyChain() on an empty log returns valid: true, verified: 0', () => {
    const result = verifyChain();
    expect(result.valid).toBe(true);
    expect(result.verified).toBe(0);
  });
});
