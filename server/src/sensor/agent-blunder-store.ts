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
import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from 'crypto';
import { DATA_DIR, zeroRetentionMode } from './paths.js';
import logger from './logger.js';
import { lockAndExecute } from './file-lock.js';

const BLUNDER_FILE = path.join(DATA_DIR, 'agent-blunders.json');
const BLUNDER_HMAC_FILE = BLUNDER_FILE + '.hmac';
const CHECKPOINT_FILE = path.join(DATA_DIR, 'agent-blunders.checkpoints.jsonl');
/** How often (in entries) to emit an external-anchor checkpoint. See emitCheckpoint(). */
const CHECKPOINT_INTERVAL = 50;

// Previously fell back to a hardcoded, publicly-known string
// ('mergen-blunder-integrity') when no secret was configured — meaning HMAC
// "protection" was actually a no-op against the exact adversary this file's
// own doc comment names (anything with the filesystem access an AI coding
// agent has: it could read this source, recompute a valid HMAC after
// deleting entries, and defeat tamper-evidence entirely). Wired the same way
// as setPolicySigningSecret/setAgentTokenSecret: index.ts calls this with the
// per-install localSecret (or a dedicated MERGEN_AUDIT_SECRET) at startup —
// no hardcoded fallback. When nothing is configured (e.g. this module used
// outside the normal server startup path), HMAC protection is honestly
// reported as off via hmacKeyConfigured() rather than silently applied with
// a key an attacker already knows.
let _blunderHmacSecret = '';
let _blunderHmacSecretConfigured = false;

export function setBlunderHmacSecret(secret: string): void {
  _blunderHmacSecret = secret;
  _blunderHmacSecretConfigured = true;
}

/** Test-only: undo setBlunderHmacSecret so tests can exercise the unconfigured path. */
export function _resetBlunderHmacSecretForTesting(): void {
  _blunderHmacSecret = '';
  _blunderHmacSecretConfigured = false;
}

function _blunderHmacKey(): string {
  return process.env.MERGEN_AUDIT_SECRET || _blunderHmacSecret;
}

export function hmacKeyConfigured(): boolean {
  return !!(process.env.MERGEN_AUDIT_SECRET || _blunderHmacSecretConfigured);
}

function _writeHmac(contents: string): void {
  if (!hmacKeyConfigured()) return; // nothing to sign with — don't write a sidecar that implies protection that isn't real
  try {
    const hmac = createHmac('sha256', _blunderHmacKey()).update(contents).digest('hex');
    fs.writeFileSync(BLUNDER_HMAC_FILE, hmac, 'utf8');
  } catch { /* non-fatal — HMAC sidecar is best-effort */ }
}

function _verifyHmac(contents: string): boolean {
  if (!hmacKeyConfigured()) return true; // unverifiable, not tampered — reported separately via hmacKeyConfigured()
  try {
    const stored = fs.readFileSync(BLUNDER_HMAC_FILE, 'utf8').trim();
    const expected = createHmac('sha256', _blunderHmacKey()).update(contents).digest('hex');
    const storedBuf = Buffer.from(stored, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (storedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(storedBuf, expectedBuf);
  } catch { return true; /* no sidecar yet — treat as unverified, not tampered */ }
}

/**
 * Emits a signed checkpoint — {sequenceNumber, hash, timestamp} for the
 * latest entry — as a structured log line (flows to whatever the operator's
 * own log aggregation captures, e.g. Datadog/CloudWatch, outside this
 * process's own file-write reach) and to a local append-only-opened sidecar
 * file. The local sidecar alone does NOT protect against an attacker with the
 * same filesystem access this process has (they could edit it too) — its
 * value is raising the bar against casual/inconsistent tampering. Real
 * protection requires the log-line anchor landing somewhere the attacker
 * can't also rewrite; see tamperEvidenceLevel() for how this is reported.
 */
function emitCheckpoint(latest: BlunderEvent): void {
  const checkpoint = {
    sequenceNumber: latest.sequenceNumber,
    hash:           latest.hash,
    timestamp:      Date.now(),
  };
  // The log line is the actual external-anchor mechanism (flows to whatever
  // log aggregation the operator has outside this process's own file writes)
  // — kept even in zero-retention mode, consistent with the existing
  // 'agent-blunder: intercepted' log line elsewhere in this file, which is
  // also not suppressed by MERGEN_ZERO_RETENTION. The local sidecar file
  // below is Mergen-controlled persistence, so it IS suppressed, matching
  // persist()'s own zeroRetentionMode() check.
  logger.info({ checkpoint }, 'agent-blunder-store: audit checkpoint');
  // process.env.VITEST is set by vitest for every test run — an extra,
  // maintenance-free guard against writing this sidecar from any test
  // context, on top of the zeroRetentionMode/_testingMode checks below
  // (belt and suspenders: found via a real leak into a developer's actual
  // ~/.mergen during a full-suite run that neither check alone caught).
  if (zeroRetentionMode() || _testingMode || process.env.VITEST) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    // Append-only open flag — does not survive an attacker with the same
    // filesystem access truncating/rewriting the file, only guards against
    // this process's own code accidentally overwriting history.
    fs.appendFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint) + '\n', { encoding: 'utf8', flag: 'a' });
  } catch (err) {
    logger.warn({ err }, 'agent-blunder-store: checkpoint sidecar write failed (non-fatal)');
  }
}

export type TamperEvidenceLevel = 'none' | 'hash-chain' | 'hmac-sealed';

/**
 * What tamper-evidence guarantee actually applies right now, given this
 * deployment's configuration — not a blanket claim regardless of setup.
 *   'none'        — no cryptographic hash chain has been established yet
 *                    (all entries predate the v2 migration).
 *   'hash-chain'  — SHA-256 hash chain present; detects any entry modified
 *                    or reordered after recording, but an attacker who can
 *                    also rewrite the file can re-link the chain around a
 *                    deletion (the hash algorithm itself is unkeyed).
 *   'hmac-sealed' — the above, plus a keyed HMAC sidecar signed with a secret
 *                    not derivable from the blunder file itself. Detects
 *                    tampering unless the attacker also has that secret.
 */
export function tamperEvidenceLevel(chainHasVerifiedEntries: boolean): TamperEvidenceLevel {
  if (!chainHasVerifiedEntries) return 'none';
  return hmacKeyConfigured() ? 'hmac-sealed' : 'hash-chain';
}
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
  /**
   * IDs of the policy/gate rules that fired for this block — enterprise policy
   * rule ids plus built-in gate ids ('injection_attempt', 'blast_radius_gate',
   * 'safety_keyword:…'). This is the join key between the audit log and the
   * policy corpus: it answers "which rule prevented this" without parsing
   * blockReason. null when the blocking gate has no rule identity.
   * Absent (undefined) on v2 entries recorded before this field existed —
   * hashing is presence-aware so old chains still verify.
   */
  triggeredRules?: string[] | null;
  /**
   * Agent identity fields — wired from the MCP client context.
   * agentId: registered agent identifier (e.g. 'claude-alice', 'cursor-ci-bot').
   * humanOwner: the human developer who owns / authorized this agent session.
   * sessionId: MCP session that produced this call (links to gate event ring).
   * Absent (undefined) on entries recorded before this field existed — hashing
   * is presence-aware so old chains still verify.
   */
  agentId?:        string | null;
  humanOwner?:     string | null;
  sessionId?:      string | null;
  /**
   * Monotonic counter, never reset, assigned in record order. Included in the
   * hash so renumbering after a deletion changes the entry's own hash (an
   * attacker must recompute it, same as any other field) — its main value is
   * making external checkpoints (emitCheckpoint) meaningful: a checkpoint
   * recorded "sequence N had hash H" that no longer matches is evidence of
   * tampering, independent of whether the surviving chain still verifies
   * internally. Absent on entries recorded before this field existed.
   */
  sequenceNumber?: number;
  /** SHA-256 over all fields except `hash` itself, prepended with previousHash. */
  previousHash:    string;
  hash:            string;
}

interface BlunderFile { version: 3; blunders: BlunderEvent[]; nextSequenceNumber?: number }

let _blunders: BlunderEvent[] = [];
let _loaded = false;
let _nextSequenceNumber = 0;
// Set by _resetForTesting() — prevents even forced load() calls from hitting disk.
// Without this, recordBlunder() calling load(true) would read real on-disk data
// mid-test, contaminating the test state with production blunders.
let _testingMode = false;

// ── Hash chain ────────────────────────────────────────────────────────────────

function _hashableContent(
  event: Omit<BlunderEvent, 'hash' | 'previousHash'>,
  previousHash: string,
): string {
  const content: Record<string, unknown> = {
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
  };
  // Presence-aware: v2 entries were hashed without triggeredRules, so include
  // it only when the field exists. v3 entries always carry it (null when no
  // rule fired), so stripping the field from a v3 entry breaks its hash.
  if (event.triggeredRules !== undefined) content.triggeredRules = event.triggeredRules;
  // Presence-aware: agent identity fields were added after v3 — include only
  // when present so pre-identity chains still verify.
  if (event.agentId !== undefined)    content.agentId    = event.agentId;
  if (event.humanOwner !== undefined) content.humanOwner = event.humanOwner;
  if (event.sessionId !== undefined)  content.sessionId  = event.sessionId;
  // Presence-aware: entries recorded before sequenceNumber existed have no
  // value to include — including it only when present keeps their hashes valid.
  if (event.sequenceNumber !== undefined) content.sequenceNumber = event.sequenceNumber;
  return previousHash + JSON.stringify(content);
}

function _computeHash(
  event: Omit<BlunderEvent, 'hash' | 'previousHash'>,
  previousHash: string,
): string {
  return createHash('sha256').update(_hashableContent(event, previousHash)).digest('hex');
}

// ── Storage ───────────────────────────────────────────────────────────────────

let _integrityViolated = false;
export function isBlunderIntegrityViolated(): boolean { return _integrityViolated; }

function load(force = false): void {
  if (_testingMode) return; // test isolation: never read disk when reset for testing
  if (_loaded && !force) return;
  _loaded = true;
  if (!fs.existsSync(BLUNDER_FILE)) { _blunders = []; return; }
  try {
    const contents = fs.readFileSync(BLUNDER_FILE, 'utf8');
    if (!_verifyHmac(contents)) {
      _integrityViolated = true;
      logger.error({ path: BLUNDER_FILE }, 'agent-blunder-store: HMAC mismatch — file may have been tampered with');
    }
    const raw = JSON.parse(contents);
    // Support reading v1 (no hash fields) and v2 (no triggeredRules) files —
    // migrate forward on next write. Old entries are kept verbatim so their
    // hashes stay verifiable.
    if ((raw?.version === 3 || raw?.version === 2 || raw?.version === 1) && Array.isArray(raw.blunders)) {
      _blunders = raw.blunders;
      // Existing installs upgrading to this field: derive the counter from the
      // highest sequenceNumber already on disk if the file predates it.
      const maxSeen = _blunders.reduce((max, b) => typeof b.sequenceNumber === 'number' ? Math.max(max, b.sequenceNumber) : max, -1);
      _nextSequenceNumber = typeof raw.nextSequenceNumber === 'number' ? raw.nextSequenceNumber : maxSeen + 1;
    } else {
      _blunders = [];
      _nextSequenceNumber = 0;
    }
  } catch { _blunders = []; _nextSequenceNumber = 0; }
}

function persist(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${BLUNDER_FILE}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    const contents = JSON.stringify({ version: 3, blunders: _blunders, nextSequenceNumber: _nextSequenceNumber } satisfies BlunderFile);
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, BLUNDER_FILE);
    _writeHmac(contents);
  } catch (err) {
    logger.warn({ err }, 'agent-blunder-store: persist failed');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Test-only: reset internal state without touching the filesystem. */
export function _resetForTesting(): void {
  _blunders            = [];
  _loaded              = true;
  _testingMode         = true; // block even forced load() calls from reading disk
  _nextSequenceNumber  = 0;
}

/** Test-only: push a raw entry (bypasses hash computation) for injection tests. */
export function _injectRawForTesting(entry: Partial<BlunderEvent> & Pick<BlunderEvent, 'id' | 'recordedAt' | 'blunderType' | 'blockReason'>): void {
  _blunders.push({
    command: null, service: null, tag: null, actor: null, pid: null,
    confidenceScore: null, previousHash: '', hash: '',
    ...entry,
  });
}

export function recordBlunder(event: Omit<BlunderEvent, 'hash' | 'previousHash' | 'id' | 'recordedAt'> & { id?: string; recordedAt?: number }): void {
  return lockAndExecute(`${BLUNDER_FILE}.lock`, () => {
    load(true);
    const id = event.id ?? randomUUID();
    if (_blunders.some((b) => b.id === id)) {
      return; // replay deduplication
    }
    const base = {
      ...event,
      id,
      recordedAt: event.recordedAt ?? Date.now(),
      // Normalize to null so every new entry carries the field explicitly —
      // presence distinguishes v3 entries from pre-migration v2 ones.
      triggeredRules: event.triggeredRules ?? null,
      // Agent identity — normalize undefined → null so presence-aware hashing
      // works correctly: new entries always carry these fields explicitly.
      agentId:    event.agentId    ?? null,
      humanOwner: event.humanOwner ?? null,
      sessionId:  event.sessionId  ?? null,
      sequenceNumber: _nextSequenceNumber,
    };
    // Use || not ?? — v1 legacy entries have hash='' (empty string), which is
    // falsy but not nullish. ?? would leave previousHash as '' and corrupt the
    // chain when a v2 entry immediately follows a v1 preamble entry.
    const previousHash = _blunders.length > 0
      ? (_blunders[_blunders.length - 1].hash || GENESIS_HASH)
      : GENESIS_HASH;
    const hash = _computeHash(base, previousHash);

    const entry = { ...base, previousHash, hash };
    _blunders.push(entry);
    _nextSequenceNumber++;
    if (_blunders.length > MAX_BLUNDERS) _blunders = _blunders.slice(-MAX_BLUNDERS);
    persist();
    if (entry.sequenceNumber % CHECKPOINT_INTERVAL === 0) emitCheckpoint(entry);
    // Fire-and-forget — a slow/down SIEM endpoint must never add latency to
    // the gate path that produced this entry. siem-forward.ts no-ops
    // immediately if nothing is configured.
    void import('../intelligence/siem-forward.js').then(({ forwardToSiem }) => forwardToSiem(entry)).catch(() => { /* never break the gate path */ });
    logger.info(
      { blunderType: event.blunderType, cmd: event.command?.slice(0, 80), service: event.service, agentId: event.agentId },
      'agent-blunder: intercepted',
    );
  });
}

export function getBlunders(filter?: { agentId?: string }): BlunderEvent[] {
  load(true);
  if (filter?.agentId) {
    return _blunders.filter((b) => b.agentId === filter.agentId);
  }
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
  /** Present when verified=0 to distinguish "verified clean" from "nothing to verify". */
  note?: string;
  /** What guarantee actually applies given this deployment's configuration — see tamperEvidenceLevel(). */
  tamperEvidenceLevel: TamperEvidenceLevel;
  hmacProtected: boolean;
} {
  // Forced reload, not the memoized load() — this function's entire purpose
  // is letting an external caller verify the log without trusting the live
  // process. A cached in-memory read would miss tampering that happened to
  // the file while this process kept running (exactly the scenario being
  // guarded against), and would only happen to look correct because the
  // common caller (a fresh CLI process) starts with nothing cached anyway.
  load(true);
  const hmacProtected = hmacKeyConfigured();
  if (_blunders.length === 0) {
    return { valid: true, verified: 0, note: 'Log is empty — nothing to verify', tamperEvidenceLevel: 'none', hmacProtected };
  }

  // Find the first v2 entry — v1 entries before it are a legacy preamble.
  const firstV2Idx = _blunders.findIndex((b) => !!b.hash);
  if (firstV2Idx === -1) {
    // All entries are v1 (pre-migration). The log has not been tamper-evidenced yet.
    return {
      valid: true,
      verified: 0,
      truncated: false,
      note: 'No cryptographically-verified entries — all entries predate hash-chain migration. Chain integrity cannot be confirmed.',
      tamperEvidenceLevel: 'none',
      hmacProtected,
    };
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
  // Sequence numbers should be exactly consecutive across the surviving
  // portion — a gap here means an entry is missing without the rest being
  // consistently renumbered (a lazy/inconsistent tamper, or accidental
  // corruption). A sophisticated attacker who also renumbers and rehashes
  // defeats this check the same way they'd defeat the hash chain itself —
  // see tamperEvidenceLevel's doc comment and verifyCheckpoints() for the
  // complementary external-anchor check.
  let expectedSeq: number | null = null;

  for (let i = firstV2Idx; i < _blunders.length; i++) {
    const b = _blunders[i];

    // Once we've entered the v2 section, any missing hash is a chain break —
    // not a legacy entry. This closes the anchor-reset exploit.
    if (!b.hash) {
      return {
        valid: false,
        firstInvalidIdx: i,
        reason: `entry at index ${i} (id=${b.id}) is missing hash field after v2 section began — possible injection`,
        tamperEvidenceLevel: tamperEvidenceLevel(true),
        hmacProtected,
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
          tamperEvidenceLevel: tamperEvidenceLevel(true),
          hmacProtected,
        };
      }
    }

    if (typeof b.sequenceNumber === 'number') {
      if (expectedSeq !== null && b.sequenceNumber !== expectedSeq) {
        return {
          valid: false,
          firstInvalidIdx: i,
          reason: `sequenceNumber gap at index ${i} (id=${b.id}): expected ${expectedSeq}, got ${b.sequenceNumber} — an entry may have been removed`,
          tamperEvidenceLevel: tamperEvidenceLevel(true),
          hmacProtected,
        };
      }
      expectedSeq = b.sequenceNumber + 1;
    } else {
      expectedSeq = null; // entry predates sequenceNumber — can't check the next gap either
    }

    const { hash: _h, previousHash: _p, ...rest } = b;
    const recomputed = _computeHash(rest, b.previousHash);
    if (recomputed !== b.hash) {
      return {
        valid: false,
        firstInvalidIdx: i,
        reason: `hash mismatch at index ${i} (id=${b.id}): content was modified after recording`,
        tamperEvidenceLevel: tamperEvidenceLevel(true),
        hmacProtected,
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
    tamperEvidenceLevel: tamperEvidenceLevel(true),
    hmacProtected,
  };
}

/**
 * Cross-checks the local checkpoint sidecar (emitCheckpoint's output) against
 * the live chain: for each checkpoint claiming "sequence N had hash H", the
 * entry currently at that sequence number must still exist and still have
 * that exact hash. A mismatch here is stronger evidence of tampering than
 * verifyChain() alone — it means history was altered even in a way that kept
 * the surviving chain internally self-consistent (renumbered + rehashed).
 *
 * Caveat: this is only as strong as the checkpoint file's own integrity. An
 * attacker with the same local filesystem access this process has could also
 * rewrite the local checkpoint sidecar — this check is real protection against
 * casual/inconsistent tampering and accidental corruption, not a guarantee
 * against a fully sophisticated local attacker unless checkpoints are also
 * anchored externally (see emitCheckpoint's doc comment).
 */
export function verifyCheckpoints(): {
  checked: number;
  mismatches: Array<{ sequenceNumber: number; expectedHash: string; reason: string }>;
} {
  load(true); // same forced-reload reasoning as verifyChain() above
  const mismatches: Array<{ sequenceNumber: number; expectedHash: string; reason: string }> = [];
  let raw: string;
  try {
    raw = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
  } catch {
    return { checked: 0, mismatches: [] }; // no checkpoints yet — nothing to cross-check
  }

  const bySeq = new Map<number, BlunderEvent>();
  for (const b of _blunders) {
    if (typeof b.sequenceNumber === 'number') bySeq.set(b.sequenceNumber, b);
  }

  let checked = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let checkpoint: { sequenceNumber: number; hash: string; timestamp: number };
    try {
      checkpoint = JSON.parse(line);
    } catch {
      continue;
    }
    checked++;
    const current = bySeq.get(checkpoint.sequenceNumber);
    if (!current) {
      mismatches.push({
        sequenceNumber: checkpoint.sequenceNumber,
        expectedHash: checkpoint.hash,
        reason: 'entry no longer exists in the live chain (evicted by normal ring-buffer rollover, or deleted)',
      });
    } else if (current.hash !== checkpoint.hash) {
      mismatches.push({
        sequenceNumber: checkpoint.sequenceNumber,
        expectedHash: checkpoint.hash,
        reason: `live entry's hash (${current.hash.slice(0, 8)}…) does not match the checkpointed hash — content was altered after the checkpoint was recorded`,
      });
    }
  }
  return { checked, mismatches };
}
