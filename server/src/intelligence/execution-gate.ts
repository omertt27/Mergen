/**
 * execution-gate.ts — Approval gate for deploy/full-tier autonomous fixes.
 *
 * When autopilot wants to execute a command above the 'restart' risk tier, it
 * calls requestApproval() instead of executing immediately. This module stores
 * the pending execution and posts a Slack block with Approve/Deny buttons.
 *
 * Button clicks arrive at POST /slack/actions → handleSlackActions() in slack.ts,
 * which calls approveExecution() or denyExecution() here.
 *
 * Approval window: 15 minutes. After that, pruneExpired() fires and the request
 * is discarded with a thread reply.
 *
 * Persistence: pending approvals are written to ~/.mergen/approval-pending.json
 * using the same atomic-tmp-rename pattern as override-corpus.ts. On restart,
 * non-expired approvals are restored so an engineer's Approve click still works
 * even if the server was restarted mid-window.
 */

import fs from 'fs';
import type { CommandRiskTier } from './action-risk.js';
import type { BlastRadius } from './blast-radius.js';
import { approvalEvents } from './approval-events.js';
import { APPROVALS_FILE, DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

export interface PendingExecution {
  pid: string;
  command: string;
  tier: CommandRiskTier;
  service: string;
  remediationConfidence: number;
  requestedAt: number;
  expiresAt: number;
  cwd?: string;
  blastRadius?: BlastRadius;
}

const APPROVAL_WINDOW_MS = 15 * 60 * 1_000;
const _pending = new Map<string, PendingExecution>();
let _loaded = false;

// ── Persistence ───────────────────────────────────────────────────────────────

interface ApprovalFile {
  version: 1;
  pending: Array<[string, PendingExecution]>;
}

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (zeroRetentionMode()) return;
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => { _persistTimer = null; _persist(); }, 500);
}

function _persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload: ApprovalFile = { version: 1, pending: [..._pending.entries()] };
    const tmp = `${APPROVALS_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, APPROVALS_FILE);
  } catch (err) {
    logger.warn({ err }, 'execution-gate: persist failed');
  }
}

/** Synchronously flush pending approvals to disk — call in SIGTERM handler. */
export function flushApprovals(): void { _persist(); }

function load(): void {
  if (_loaded) return;
  _loaded = true;
  if (zeroRetentionMode() || !fs.existsSync(APPROVALS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8')) as ApprovalFile;
    if (raw?.version !== 1 || !Array.isArray(raw.pending)) return;
    const now = Date.now();
    let restored = 0;
    for (const [pid, record] of raw.pending) {
      if (record.expiresAt <= now) continue; // expired — discard silently
      _pending.set(pid, record);
      restored++;
    }
    if (restored > 0) {
      logger.info({ restored }, 'execution-gate: restored pending approvals from disk');
    }
  } catch (err) {
    logger.warn({ err }, 'execution-gate: failed to load persisted approvals — starting fresh');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a pending execution. The caller is responsible for posting the
 * Slack approval block before calling this (see incident-autopilot.ts).
 */
export function requestApproval(
  opts: Omit<PendingExecution, 'requestedAt' | 'expiresAt'>,
): void {
  load();
  const now = Date.now();
  _pending.set(opts.pid, { ...opts, requestedAt: now, expiresAt: now + APPROVAL_WINDOW_MS });
  schedulePersist();
  logger.info({ pid: opts.pid, tier: opts.tier, command: opts.command }, 'execution-gate: awaiting Slack approval');
}

/** Called when an engineer clicks ✅ Execute in Slack. Returns the record or null if gone. */
export function approveExecution(pid: string): PendingExecution | null {
  load();
  const record = _pending.get(pid);
  if (!record) return null;
  _pending.delete(pid);
  schedulePersist();
  return record;
}

/** Called when an engineer clicks ❌ Deny in Slack. Returns true if found. */
export function denyExecution(pid: string): boolean {
  load();
  if (!_pending.has(pid)) return false;
  _pending.delete(pid);
  schedulePersist();
  return true;
}

/** Discard expired requests and notify the thread. Called every 60 s. */
export function pruneExpired(): void {
  // No load() call here — by the time this fires, requestApproval() has already
  // triggered load(). No schedulePersist() either — expired entries are silently
  // discarded on next load() via the expiresAt filter, so the file stays correct
  // without a write here. Calling schedulePersist() would create a fake timer in
  // tests that use vi.useFakeTimers(), causing spurious handler invocations.
  const now = Date.now();
  for (const [pid, record] of _pending) {
    if (now <= record.expiresAt) continue;
    _pending.delete(pid);
    approvalEvents.emit('approval:expired', pid, '⏰ _Approval window expired (15 min). Re-trigger autopilot or apply fix manually._');
    logger.info({ pid, command: record.command }, 'execution-gate: approval window expired');
  }
}

const _expiryHandle = setInterval(pruneExpired, 60_000);
_expiryHandle.unref();

/** Test-only: reset in-memory state without touching the filesystem. */
export function _resetForTesting(): void {
  _pending.clear();
  _loaded = true; // prevent disk reads — tests manage their own state
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
}
