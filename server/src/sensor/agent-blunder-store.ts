/**
 * agent-blunder-store.ts — Persistent, hash-chained log of every action Mergen blocked.
 *
 * Each entry is a "near-miss" — an autonomous action that the safety layer
 * intercepted. These are the raw events behind the Agent Blunder Log metric:
 * "Mergen prevented X potentially harmful actions this quarter."
 *
 * Hash chain: every entry carries a SHA-256 hash of its own content plus the
 * previous entry's hash. This makes the log tamper-evident: any deletion or
 * modification of a historical entry will break the chain and be detected by
 * verifyChain(). The chain can be verified by an external auditor without
 * trusting the server — a requirement for enterprise governance reviews.
 *
 * Persisted as a JSON ring buffer (cap: 5,000, configurable via MERGEN_MAX_BLUNDERS)
 * under ~/.mergen/agent-blunders.json.
 */

import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { DATA_DIR, zeroRetentionMode } from './paths.js';
import logger from './logger.js';
import { lockAndExecute } from './file-lock.js';

const BLUNDER_FILE = path.join(DATA_DIR, 'agent-blunders.json');
// Configurable cap — default 5,000. At 10 blocks/day this covers ~1.4 years;
// at 1 block/minute it covers ~3.5 days. The 100,000 ceiling prevents misconfiguration.
// Exported so tests can derive the correct threshold for wraparound assertions.
export const MAX_BLUNDERS = (() => {
  const v = parseInt(process.env.MERGEN_MAX_BLUNDERS ?? '5000', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 100_000) : 5_000;
})();
const GENESIS_HASH = '0'.repeat(64); // predecessor hash for the first entry

export type BlunderType =
  | 'allowlist_block'       // command not on the allowlist
  | 'injection_attempt'     // injection pattern detected in command
  | 'rbac_block'            // actor missing required role
  | 'override_corpus_block' // execution blocked by override corpus history
  | 'pipeline_block'        // governance pipeline blocked (non-corpus reason)
  | 'planning_gate_block';  // planning gate confidence/blast-radius check failed

export interface BlunderEvent {
  id:              string;
  recordedAt:      number;
  blunderType:     BlunderType;
  command:         string | null;
  blockReason:     string;
  service:         string | null;
  tag:             string | null;
  actor:           string | null;
  pid:             string | null;
  confidenceScore: number | null;
  /** SHA-256 over all fields except `hash` itself, prepended with previousHash. */
  previousHash:    string;
  hash:            string;
}

interface BlunderFile { version: 2; blunders: BlunderEvent[] }

let _blunders: BlunderEvent[] = [];
let _loaded = false;

// ── Hash chain ────────────────────────────────────────────────────────────────

function _hashableContent(
  event: Omit<BlunderEvent, 'hash' | 'previousHash'>,
  previousHash: string,
): string {
  return previousHash + JSON.stringify({
    id:              event.id,
    recordedAt:      event.recordedAt,
    blunderType:     event.blunderType,
    command:         event.command,
    blockReason:     event.blockReason,
    service:         event.service,
    tag:             event.tag,
    actor:           event.actor,
    pid:             event.pid,
    confidenceScore: event.confidenceScore,
  });
}

function _computeHash(
  event: Omit<BlunderEvent, 'hash' | 'previousHash'>,
  previousHash: string,
): string {
  return createHash('sha256').update(_hashableContent(event, previousHash)).digest('hex');
}

// ── Storage ───────────────────────────────────────────────────────────────────

function load(force = false): void {
  if (_loaded && !force) return;
  _loaded = true;
  if (!fs.existsSync(BLUNDER_FILE)) { _blunders = []; return; }
  try {
    const raw = JSON.parse(fs.readFileSync(BLUNDER_FILE, 'utf8'));
    // Support reading v1 files (no hash fields) — migrate forward on next write
    if ((raw?.version === 2 || raw?.version === 1) && Array.isArray(raw.blunders)) {
      _blunders = raw.blunders;
    } else {
      _blunders = [];
    }
  } catch { _blunders = []; }
}

function persist(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${BLUNDER_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, blunders: _blunders } satisfies BlunderFile), 'utf8');
    fs.renameSync(tmp, BLUNDER_FILE);
  } catch (err) {
    logger.warn({ err }, 'agent-blunder-store: persist failed');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Test-only: reset internal state without touching the filesystem. */
export function _resetForTesting(): void {
  _blunders = [];
  _loaded   = true; // prevent load() from reading real disk files in tests
}

/** Test-only: push a raw entry (bypasses hash computation) for injection tests. */
export function _injectRawForTesting(entry: Partial<BlunderEvent> & Pick<BlunderEvent, 'id' | 'recordedAt' | 'blunderType' | 'blockReason'>): void {
  _blunders.push({
    command: null, service: null, tag: null, actor: null, pid: null,
    confidenceScore: null, previousHash: '', hash: '',
    ...entry,
  });
}

export function recordBlunder(event: Omit<BlunderEvent, 'id' | 'recordedAt' | 'hash' | 'previousHash'>): void {
  return lockAndExecute(`${BLUNDER_FILE}.lock`, () => {
    load(true);
    const base = { id: randomUUID(), recordedAt: Date.now(), ...event };
    // Use || not ?? — v1 legacy entries have hash='' (empty string), which is
    // falsy but not nullish. ?? would leave previousHash as '' and corrupt the
    // chain when a v2 entry immediately follows a v1 preamble entry.
    const previousHash = _blunders.length > 0
      ? (_blunders[_blunders.length - 1].hash || GENESIS_HASH)
      : GENESIS_HASH;
    const hash = _computeHash(base, previousHash);

    _blunders.push({ ...base, previousHash, hash });
    if (_blunders.length > MAX_BLUNDERS) _blunders = _blunders.slice(-MAX_BLUNDERS);
    persist();
    logger.info(
      { blunderType: event.blunderType, cmd: event.command?.slice(0, 80), service: event.service },
      'agent-blunder: intercepted',
    );
  });
}

export function getBlunders(): BlunderEvent[] {
  load(true);
  return [..._blunders];
}

export function getBlunderStats(): {
  total:     number;
  byType:    Record<string, number>;
  last7Days: number;
  last30Days: number;
} {
  load(true);
  const now  = Date.now();
  const ms7  =  7 * 24 * 60 * 60 * 1_000;
  const ms30 = 30 * 24 * 60 * 60 * 1_000;
  const byType: Record<string, number> = {};
  let last7Days = 0, last30Days = 0;
  for (const b of _blunders) {
    byType[b.blunderType] = (byType[b.blunderType] ?? 0) + 1;
    if (b.recordedAt >= now - ms7)  last7Days++;
    if (b.recordedAt >= now - ms30) last30Days++;
  }
  return { total: _blunders.length, byType, last7Days, last30Days };
}

/**
 * Verify the hash chain from oldest to newest.
 *
 * Two modes depending on ring-buffer state:
 *
 *   full   — chain starts at genesis (fewer than MAX_BLUNDERS total entries
 *             ever written). Every entry is verifiable back to the first.
 *
 *   partial — ring buffer has wrapped; the earliest surviving entry is the
 *             anchor. We can verify that entries [anchor … newest] have not
 *             been modified or reordered, but we cannot verify what was
 *             evicted. truncated: true is set so auditors know the pre-eviction
 *             history is gone.
 *
 * An external auditor can call GET /agent-blunders/verify to confirm that the
 * surviving portion of the log has not been tampered with.
 *
 * Legacy-entry rule: once a v2 entry (with a hash) has been seen, any
 * subsequent entry that lacks a hash field is treated as a chain break.
 * This closes an exploit where an attacker could inject a v1-format entry
 * between two v2 entries to silently reset the chain anchor.
 */
export function verifyChain(): {
  valid: boolean;
  truncated?: boolean;
  verifiedFrom?: string;
  verified?: number;
  firstInvalidIdx?: number;
  reason?: string;
} {
  load();
  if (_blunders.length === 0) return { valid: true, verified: 0 };

  // Find the first v2 entry — v1 entries before it are a legacy preamble.
  const firstV2Idx = _blunders.findIndex((b) => !!b.hash);
  if (firstV2Idx === -1) {
    // All entries are v1 (pre-migration). Nothing to verify cryptographically.
    return { valid: true, verified: 0, truncated: false };
  }

  // If the first v2 entry's previousHash is GENESIS_HASH the chain is full
  // (no eviction has erased any v2 entries). Otherwise it's partial.
  const anchor     = _blunders[firstV2Idx];
  const truncated  = anchor.previousHash !== GENESIS_HASH;
  // Start verification from the anchor's claimed previousHash. This means:
  //   - Full chain: expectedPrev = GENESIS_HASH → verifies back to genesis
  //   - Partial chain: expectedPrev = hash(evicted entry) → verifies from anchor forward
  let expectedPrev = anchor.previousHash;
  let seenFirstV2  = false;

  for (let i = firstV2Idx; i < _blunders.length; i++) {
    const b = _blunders[i];

    // Once we've entered the v2 section, any missing hash is a chain break —
    // not a legacy entry. This closes the anchor-reset exploit.
    if (!b.hash) {
      return {
        valid: false,
        firstInvalidIdx: i,
        reason: `entry at index ${i} (id=${b.id}) is missing hash field after v2 section began — possible injection`,
      };
    }

    if (!seenFirstV2) {
      // The anchor entry itself: we cannot verify its previousHash (its
      // predecessor may have been evicted). Accept it as the chain root.
      seenFirstV2 = true;
    } else {
      if (b.previousHash !== expectedPrev) {
        return {
          valid: false,
          firstInvalidIdx: i,
          reason: `previousHash mismatch at index ${i}: expected ${expectedPrev.slice(0, 8)}… got ${b.previousHash.slice(0, 8)}…`,
        };
      }
    }

    const { hash: _h, previousHash: _p, ...rest } = b;
    const recomputed = _computeHash(rest, b.previousHash);
    if (recomputed !== b.hash) {
      return {
        valid: false,
        firstInvalidIdx: i,
        reason: `hash mismatch at index ${i} (id=${b.id}): content was modified after recording`,
      };
    }

    expectedPrev = b.hash;
  }

  const verifiedCount = _blunders.length - firstV2Idx;
  return {
    valid:         true,
    truncated,
    verifiedFrom:  anchor.id,
    verified:      verifiedCount,
  };
}
