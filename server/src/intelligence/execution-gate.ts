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
 */

import type { CommandRiskTier } from './action-risk.js';
import type { BlastRadius } from './blast-radius.js';
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

// Injected by incident-autopilot.ts at startup — breaks the circular
// slack.ts ↔ execution-gate.ts import cycle.
type ThreadReplyFn = (pid: string, text: string) => void;
let _replyFn: ThreadReplyFn | null = null;

export function setApprovalReplyFn(fn: ThreadReplyFn): void {
  _replyFn = fn;
}

/**
 * Register a pending execution. The caller is responsible for posting the
 * Slack approval block before calling this (see incident-autopilot.ts).
 */
export function requestApproval(
  opts: Omit<PendingExecution, 'requestedAt' | 'expiresAt'>,
): void {
  const now = Date.now();
  _pending.set(opts.pid, { ...opts, requestedAt: now, expiresAt: now + APPROVAL_WINDOW_MS });
  logger.info({ pid: opts.pid, tier: opts.tier, command: opts.command }, 'execution-gate: awaiting Slack approval');
}

/** Called when an engineer clicks ✅ Execute in Slack. Returns the record or null if gone. */
export function approveExecution(pid: string): PendingExecution | null {
  const record = _pending.get(pid);
  if (!record) return null;
  _pending.delete(pid);
  return record;
}

/** Called when an engineer clicks ❌ Deny in Slack. Returns true if found. */
export function denyExecution(pid: string): boolean {
  if (!_pending.has(pid)) return false;
  _pending.delete(pid);
  return true;
}

/** Discard expired requests and notify the thread. Called every 60 s. */
export function pruneExpired(): void {
  const now = Date.now();
  for (const [pid, record] of _pending) {
    if (now <= record.expiresAt) continue;
    _pending.delete(pid);
    if (_replyFn) {
      _replyFn(pid, '⏰ _Approval window expired (15 min). Re-trigger autopilot or apply fix manually._');
    }
    logger.info({ pid, command: record.command }, 'execution-gate: approval window expired');
  }
}

const _expiryHandle = setInterval(pruneExpired, 60_000);
_expiryHandle.unref();
