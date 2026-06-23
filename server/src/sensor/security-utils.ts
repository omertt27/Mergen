/**
 * security-utils.ts — Shared security primitives.
 *
 * Centralises timing-safe secret comparison so the logic lives in exactly one
 * place and both callers (app.ts localSecret guard, ingest.ts SHARED_SECRET
 * guard) stay in sync. Deduplication also prevents the subtle divergence bug
 * where one caller checks length before timingSafeEqual (leaking secret length
 * via response-time oracle) while the other does not.
 */

import crypto from 'crypto';

// Fixed-width buffer size for timing-safe comparison. Must be ≥ any real secret
// length. 128 bytes (1024 bits) is far more than any UUID or hex secret.
const COMPARISON_WIDTH = 128;

/**
 * Compare two secret strings in constant time, independent of their lengths.
 *
 * Both strings are zero-padded to COMPARISON_WIDTH before calling
 * crypto.timingSafeEqual, so the comparison takes the same time regardless of
 * whether the lengths match — eliminating the response-time oracle that leaks
 * the secret length when a length check short-circuits first.
 *
 * Returns false immediately if either value is not a string (avoids type errors
 * in timingSafeEqual while still being constant-time for the string case).
 */
export function timingSafeSecretEqual(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const p = Buffer.allocUnsafe(COMPARISON_WIDTH).fill(0);
  const e = Buffer.allocUnsafe(COMPARISON_WIDTH).fill(0);
  Buffer.from(presented, 'utf8').copy(p, 0, 0, Math.min(presented.length, COMPARISON_WIDTH));
  Buffer.from(expected,  'utf8').copy(e, 0, 0, Math.min(expected.length,  COMPARISON_WIDTH));
  return crypto.timingSafeEqual(p, e) && presented.length === expected.length;
}
