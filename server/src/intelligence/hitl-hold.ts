/**
 * hitl-hold.ts — held-Promise lifecycle for the tool-call gate's HOLD verdict.
 *
 * Extracted from tool-guard.ts. When the gate holds a call for human review it
 * suspends the JSON-RPC response by returning a Promise that only resolves when
 * an operator approves/denies (routes/hitl.ts → approveToolCall/denyToolCall),
 * the 15-minute window expires, or the process restarts (denyStaleHoldsOnStartup).
 *
 * Owns the pending-holds map, its dead-letter persistence, the outbound Slack/
 * PagerDuty webhook + reminder + escalation, and the mrkdwn sanitiser. tool-guard's
 * applyGateInner delegates the whole HOLD path to holdToolCall().
 *
 * New features:
 *   Multi-approver quorum    — MERGEN_HITL_QUORUM_RULES="terraform:2,DROP TABLE:2"
 *                              Hold resolves only when N distinct approvers sign off.
 *   Approve-with-constraints — POST /hitl/approve-constrained passes a constraints
 *                              object that is validated before execution resumes.
 *   Delegation chain         — MERGEN_HITL_SECONDARY_WEBHOOK fires at 5-min mark
 *                              if the primary webhook has not received a response.
 */
import fs from 'fs';
import { recordHitlDecision } from './gate-analytics.js';
import { loadEnterprisePolicy } from './enterprise-policy-engine.js';
import { computeBlastRadius } from './blast-radius.js';
import { HITL_HOLDS_FILE, DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export const HOLD_TIMEOUT_MS = 15 * 60 * 1_000; // 15 minutes — matches execution-gate.ts

// ── Multi-approver quorum ─────────────────────────────────────────────────────
// MERGEN_HITL_QUORUM_RULES is a comma-separated list of pattern:count pairs.
// e.g. "terraform:2,DROP TABLE:2,kubectl delete namespace:3"
// A hold that matches one of these patterns requires N distinct approvers before
// the Promise resolves. The hold remains HELD (Slack shows "N/M approved") until
// quorum is reached or the window expires.

interface QuorumRule { pattern: string; required: number }

function _loadQuorumRules(): QuorumRule[] {
  const raw = process.env.MERGEN_HITL_QUORUM_RULES ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const lastColon = s.lastIndexOf(':');
      if (lastColon === -1) return null;
      const pattern  = s.slice(0, lastColon).trim();
      const required = parseInt(s.slice(lastColon + 1).trim(), 10);
      if (!pattern || !Number.isFinite(required) || required < 2) return null;
      return { pattern, required };
    })
    .filter((r): r is QuorumRule => r !== null);
}

const _quorumRules: QuorumRule[] = _loadQuorumRules();

function _quorumRequired(commandArg: string, toolName: string): number {
  const haystack = `${toolName} ${commandArg}`.toLowerCase();
  for (const rule of _quorumRules) {
    if (haystack.includes(rule.pattern.toLowerCase())) return rule.required;
  }
  return 1; // default: single approver
}

interface PendingHold {
  toolName:       string;
  argsSnapshot:   string;
  policyReason:   string;
  triggeredRules: string[];
  heldAt:         number;
  commandArg:     string;
  resolve:        (result: McpResult) => void;
  timeoutHandle:  ReturnType<typeof setTimeout>;
  reminderHandle?: ReturnType<typeof setTimeout>;
  escalationHandle?: ReturnType<typeof setTimeout>;
  // Quorum tracking
  quorumRequired: number;
  approvedBy:     Set<string>;
  // Constrained approval
  approvedConstraints?: Record<string, unknown>;
}

const _pendingHolds = new Map<string, PendingHold>();

// ── Hold metadata persistence (dead-letter on restart) ───────────────────────
// Promise resolve/reject functions can't be serialized, so we persist only
// the metadata needed to identify stale holds after a restart and deny them.

interface HoldRecord {
  token:          string;
  toolName:       string;
  policyReason:   string;
  triggeredRules: string[];
  heldAt:         number;
  expiresAt:      number;
  quorumRequired?: number;
  approvedBy?:    string[];
}

interface HoldsFile { version: 1; holds: HoldRecord[] }

function _persistHolds(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const now    = Date.now();
    const active = [..._pendingHolds.entries()]
      .filter(([, h]) => now < h.heldAt + HOLD_TIMEOUT_MS)
      .map(([token, h]): HoldRecord => ({
        token,
        toolName:       h.toolName,
        policyReason:   h.policyReason,
        triggeredRules: h.triggeredRules,
        heldAt:         h.heldAt,
        expiresAt:      h.heldAt + HOLD_TIMEOUT_MS,
        quorumRequired: h.quorumRequired,
        approvedBy:     [...h.approvedBy],
      }));
    const tmp = `${HITL_HOLDS_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, holds: active } satisfies HoldsFile), 'utf8');
    fs.renameSync(tmp, HITL_HOLDS_FILE);
  } catch (err) {
    logger.warn({ err }, 'tool-guard: hold persist failed');
  }
}

/**
 * On startup, load stale hold records from the previous run and immediately
 * deny them. The MCP client that initiated those tool calls is gone — the
 * Promise resolver no longer exists — but we log the tokens so an operator
 * can understand why a HITL approval window expired during a restart.
 */
export function denyStaleHoldsOnStartup(): void {
  if (zeroRetentionMode() || !fs.existsSync(HITL_HOLDS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(HITL_HOLDS_FILE, 'utf8')) as HoldsFile;
    if (raw?.version !== 1 || !Array.isArray(raw.holds)) return;
    const now   = Date.now();
    const stale = raw.holds.filter((h) => h.expiresAt > now);
    if (stale.length === 0) return;
    logger.warn(
      { count: stale.length, tokens: stale.map((h) => h.token) },
      'tool-guard: denying stale HITL holds from previous server run — ' +
      'the MCP client must resubmit these tool calls.',
    );
    // Clear the file so the tokens aren't re-processed on the next restart.
    try { fs.unlinkSync(HITL_HOLDS_FILE); } catch { /* ignore */ }
  } catch (err) {
    logger.warn({ err }, 'tool-guard: failed to load stale holds file');
  }
}

// ── Public resolution API (called by routes/hitl.ts) ─────────────────────────

export function approveToolCall(token: string, approverId = 'operator'): boolean {
  const hold = _pendingHolds.get(token);
  if (!hold) return false;

  // Quorum: register this approver. If quorum not yet met, send a partial-approval
  // Slack update and keep the hold alive.
  hold.approvedBy.add(approverId);
  const approvedCount = hold.approvedBy.size;
  const required      = hold.quorumRequired;

  if (approvedCount < required) {
    // Fire a Slack progress update without resolving
    void _fireQuorumProgress(token, hold, approvedCount, required);
    _persistHolds();
    logger.info({ token, approverId, approvedCount, required }, 'tool-guard: quorum partial approval');
    return true; // accepted but not yet resolved
  }

  // Quorum met — resolve
  clearTimeout(hold.timeoutHandle);
  if (hold.reminderHandle)    clearTimeout(hold.reminderHandle);
  if (hold.escalationHandle)  clearTimeout(hold.escalationHandle);
  _pendingHolds.delete(token);
  _persistHolds();
  recordHitlDecision(hold.triggeredRules, 'approve', hold.heldAt);
  logger.info({ token, toolName: hold.toolName, approvedBy: [...hold.approvedBy] }, 'tool-guard: HITL approved (quorum met)');

  const constraintNote = hold.approvedConstraints
    ? `\nApproved with constraints: ${JSON.stringify(hold.approvedConstraints)}`
    : '';
  hold.resolve({
    content: [{ type: 'text', text: `✅ Tool call \`${hold.toolName}\` approved by operator (${approvedCount}/${required}).${constraintNote}` }],
  });
  return true;
}

/**
 * Approve with constraints — the approver narrows the scope of execution.
 * Constraints are passed back to the agent in the resolution message so it
 * can honour them (e.g., "restart only the auth pod, not the whole deployment").
 * The hold is resolved after constraint validation succeeds.
 */
export function approveToolCallConstrained(token: string, constraints: Record<string, unknown>, approverId = 'operator'): { ok: boolean; error?: string } {
  const hold = _pendingHolds.get(token);
  if (!hold) return { ok: false, error: 'token not found or already expired' };

  // Basic validation: constraints must be a non-empty object
  if (typeof constraints !== 'object' || Array.isArray(constraints) || Object.keys(constraints).length === 0) {
    return { ok: false, error: 'constraints must be a non-empty object' };
  }

  hold.approvedConstraints = constraints;
  hold.approvedBy.add(approverId);

  // Constrained approval counts as a full quorum regardless of MERGEN_HITL_QUORUM_RULES
  // — a constrained approval is a stronger signal than a plain approval.
  clearTimeout(hold.timeoutHandle);
  if (hold.reminderHandle)   clearTimeout(hold.reminderHandle);
  if (hold.escalationHandle) clearTimeout(hold.escalationHandle);
  _pendingHolds.delete(token);
  _persistHolds();
  recordHitlDecision(hold.triggeredRules, 'approve', hold.heldAt);
  logger.info({ token, toolName: hold.toolName, constraints }, 'tool-guard: HITL approved with constraints');
  hold.resolve({
    content: [{
      type: 'text',
      text: `✅ Tool call \`${hold.toolName}\` approved with constraints by ${approverId}.\nConstraints: ${JSON.stringify(constraints)}\nThe action must be scoped to these constraints before execution.`,
    }],
  });
  return { ok: true };
}

export function denyToolCall(token: string): boolean {
  const hold = _pendingHolds.get(token);
  if (!hold) return false;
  clearTimeout(hold.timeoutHandle);
  if (hold.reminderHandle) clearTimeout(hold.reminderHandle);
  if (hold.escalationHandle) clearTimeout(hold.escalationHandle);
  _pendingHolds.delete(token);
  _persistHolds();
  recordHitlDecision(hold.triggeredRules, 'deny', hold.heldAt);
  logger.info({ token, toolName: hold.toolName }, 'tool-guard: HITL denied');
  hold.resolve({
    content: [{ type: 'text', text: `❌ Tool call \`${hold.toolName}\` denied by operator.` }],
    isError: true,
  });
  return true;
}

export function getPendingHolds(): Array<{ token: string; toolName: string; policyReason: string; quorumRequired: number; approvedCount: number }> {
  return [..._pendingHolds.entries()].map(([token, h]) => ({
    token,
    toolName:       h.toolName,
    policyReason:   h.policyReason,
    quorumRequired: h.quorumRequired,
    approvedCount:  h.approvedBy.size,
  }));
}

// ── Slack mrkdwn sanitiser ────────────────────────────────────────────────────
// Strip characters that Slack Block Kit interprets as mrkdwn formatting so that
// agent-controlled strings cannot inject fake mentions, bold headers, or links
// into HITL approval messages and mislead human operators.
function escapeMrkdwn(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*/g, '＊')   // bold — replaced with full-width asterisk
    .replace(/_/g, '＿')    // italic — full-width underscore
    .replace(/~/g, '～')    // strikethrough — full-width tilde
    .replace(/`/g, '｀')    // code span — full-width backtick
    .replace(/@/g, '＠');   // mentions (@here, @channel, @user)
}

// ── Outbound HITL webhook ─────────────────────────────────────────────────────

async function fireHitlWebhook(
  token:        string,
  toolName:     string,
  argsSnapshot: string,
  reason:       string,
  port:         number,
  opts: {
    triggeredRules: string[];
    commandArg:     string;
    suggestedAlt:   string;
    quorumRequired: number;
  },
): Promise<void> {
  const webhookUrl = process.env.MERGEN_HITL_WEBHOOK_URL;
  if (!webhookUrl) {
    const baseUrl = (process.env.MERGEN_PUBLIC_URL ?? '').replace(/\/$/, '') || `http://127.0.0.1:${port}`;
    logger.warn(
      { token, toolName },
      'tool-guard: HITL triggered but MERGEN_HITL_WEBHOOK_URL is not set — ' +
      `resolve manually: POST ${baseUrl}/hitl/approve?token=${token}`,
    );
    return;
  }

  const baseUrl    = (process.env.MERGEN_PUBLIC_URL ?? '').replace(/\/$/, '') || `http://127.0.0.1:${port}`;
  const approveUrl = `${baseUrl}/hitl/approve?token=${token}`;
  const denyUrl    = `${baseUrl}/hitl/deny?token=${token}`;
  const constrainedUrl = `${baseUrl}/hitl/approve-constrained?token=${token}`;

  // Enrich with rule metadata and blast radius
  const policy = loadEnterprisePolicy();
  const matchedRules = policy.rules.filter(r => opts.triggeredRules.includes(r.id));
  const blast = computeBlastRadius(opts.commandArg || toolName);

  const rulesText = matchedRules.length > 0
    ? matchedRules.map(r => `• *${r.name}*: ${r.description}`).join('\n')
    : `• ${reason}`;

  const blastText = [
    `Scope: \`${blast.scope}\``,
    `Reversible: ${blast.reversible ? 'Yes' : '*No*'}`,
    blast.dataAtRisk ? '*Data at risk*' : null,
    blast.summary,
  ].filter(Boolean).join('  ·  ');

  const safeToolName    = escapeMrkdwn(toolName);
  const safeArgsSnippet = escapeMrkdwn(argsSnapshot.slice(0, 200));

  const quorumText = opts.quorumRequired > 1
    ? `*Quorum required: ${opts.quorumRequired} approvers*`
    : null;

  const payload = {
    text: `⚠️ *Mergen HITL Gate* — \`${safeToolName}\` is awaiting approval`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⚠️ Mergen HITL Gate — Approval Required', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Tool*\n\`${safeToolName}\`` },
          { type: 'mrkdwn', text: `*Args*\n\`${safeArgsSnippet}\`` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Why flagged*\n${rulesText}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Blast radius*\n${blastText}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Suggested alternative*\n${opts.suggestedAlt}` },
      },
      ...(quorumText ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: quorumText },
      }] : []),
      {
        type: 'actions',
        elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: '▶️ Approve', emoji: true }, url: approveUrl },
          { type: 'button', style: 'danger',  text: { type: 'plain_text', text: '🚫 Deny',    emoji: true }, url: denyUrl },
          { type: 'button', text: { type: 'plain_text', text: '🔒 Approve with Constraints', emoji: true }, url: constrainedUrl },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Token \`${token}\` · Slack reminder at 5 min · PagerDuty/Slack escalation at 10 min · auto-cancel at 15 min` }],
      },
    ],
    mergen: { type: 'hitl_gate', token, toolName, reason, approveUrl, denyUrl, constrainedUrl, quorumRequired: opts.quorumRequired },
  };

  try {
    const resp = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, webhookUrl }, 'tool-guard: HITL webhook returned non-2xx');
    }
  } catch (err) {
    logger.warn({ err, token }, 'tool-guard: HITL webhook fire failed');
  }
}

// ── Quorum progress notification ──────────────────────────────────────────────

async function _fireQuorumProgress(token: string, hold: PendingHold, approvedCount: number, required: number): Promise<void> {
  const webhookUrl = process.env.MERGEN_HITL_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `✅ *Quorum progress*: ${approvedCount}/${required} approvers for \`${escapeMrkdwn(hold.toolName)}\`. Token: \`${token}\``,
        mergen: { type: 'hitl_quorum_progress', token, approvedCount, required },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    logger.warn({ err, token }, 'tool-guard: quorum progress webhook failed');
  }
}

// ── HITL escalation helpers ───────────────────────────────────────────────────

async function fireHitlReminder(token: string, toolName: string, minutesRemaining: number): Promise<void> {
  const webhookUrl = process.env.MERGEN_HITL_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `⚠️ *Reminder:* HITL approval still pending for \`${escapeMrkdwn(toolName)}\` — ${minutesRemaining} minutes remaining. Token: \`${token}\``,
        mergen: { type: 'hitl_reminder', token, toolName },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    logger.warn({ err, token }, 'tool-guard: HITL reminder webhook failed');
  }
}

/**
 * Delegation chain escalation: fire secondary webhook if configured.
 * MERGEN_HITL_SECONDARY_WEBHOOK is the fallback on-call channel / secondary
 * responder webhook. If primary hasn't responded at 5-min mark, fire this.
 */
async function fireDelegationChain(token: string, toolName: string): Promise<void> {
  const secondaryUrl = process.env.MERGEN_HITL_SECONDARY_WEBHOOK;
  if (!secondaryUrl) return;
  try {
    await fetch(secondaryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🔴 *Delegation escalation* — HITL approval for \`${escapeMrkdwn(toolName)}\` has not been responded to after 5 minutes. Escalating to secondary on-call. Token: \`${token}\``,
        mergen: { type: 'hitl_delegation', token, toolName },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    logger.info({ token, toolName }, 'tool-guard: HITL delegation chain fired to secondary webhook');
  } catch (err) {
    logger.warn({ err, token }, 'tool-guard: HITL delegation chain webhook failed');
  }
}

async function fireHitlEscalation(token: string, toolName: string): Promise<void> {
  const pdSecret   = process.env.MERGEN_PAGERDUTY_SECRET;
  const webhookUrl = process.env.MERGEN_HITL_WEBHOOK_URL;

  if (pdSecret) {
    try {
      await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing_key:   pdSecret,
          event_action:  'trigger',
          payload: {
            summary:   `Mergen HITL gate: unanswered approval for \`${toolName}\` (token: ${token})`,
            severity:  'warning',
            source:    'mergen-hitl',
            custom_details: { token, toolName },
          },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      logger.info({ token, toolName }, 'tool-guard: HITL escalation sent to PagerDuty');
    } catch (err) {
      logger.warn({ err, token }, 'tool-guard: PagerDuty escalation failed');
    }
    return;
  }

  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 *URGENT:* HITL approval for \`${escapeMrkdwn(toolName)}\` pending 10 min. 5 min until auto-cancel. Token: \`${token}\``,
          mergen: { type: 'hitl_escalation', token, toolName },
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      logger.warn({ err, token }, 'tool-guard: HITL escalation webhook failed');
    }
  }
}

/**
 * Suspend a held tool call: fire the approval webhook and return a Promise that
 * resolves on operator approve/deny (approveToolCall/denyToolCall), the 15-minute
 * timeout, or 5/10-minute reminder/escalation. This is the entire HOLD path,
 * delegated here from tool-guard's applyGateInner.
 */
export function holdToolCall(opts: {
  token:          string;
  toolName:       string;
  argsSnapshot:   string;
  reason:         string;
  triggeredRules: string[];
  heldAt:         number;
  commandArg:     string;
  suggestedAlt:   string;
  port:           number;
}): Promise<McpResult> {
  const { token, toolName, argsSnapshot, reason, triggeredRules, heldAt, commandArg, suggestedAlt, port } = opts;
  const quorumRequired = _quorumRequired(commandArg, toolName);

  void fireHitlWebhook(token, toolName, argsSnapshot, reason, port, {
    triggeredRules,
    commandArg,
    suggestedAlt,
    quorumRequired,
  });

  return new Promise<McpResult>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      const hold = _pendingHolds.get(token);
      if (hold?.reminderHandle) clearTimeout(hold.reminderHandle);
      if (hold?.escalationHandle) clearTimeout(hold.escalationHandle);
      _pendingHolds.delete(token);
      _persistHolds();
      logger.info({ token, toolName }, 'tool-guard: HITL approval window expired');
      resolve({
        content: [{
          type: 'text',
          text:  `⏰ HITL approval window expired (15 min) for \`${toolName}\`. Tool call cancelled.`,
        }],
        isError: true,
      });
    }, HOLD_TIMEOUT_MS);
    timeoutHandle.unref();

    // 5-min: reminder + delegation chain (fire secondary webhook if configured).
    const reminderHandle = setTimeout(() => {
      void fireHitlReminder(token, toolName, 10);
      void fireDelegationChain(token, toolName);
    }, 5 * 60 * 1_000);
    reminderHandle.unref();

    // 10-min: urgent escalation (PagerDuty or second Slack).
    const escalationHandle = setTimeout(() => {
      void fireHitlEscalation(token, toolName);
    }, 10 * 60 * 1_000);
    escalationHandle.unref();

    _pendingHolds.set(token, {
      toolName,
      argsSnapshot,
      policyReason:   reason,
      triggeredRules,
      heldAt,
      commandArg,
      resolve,
      timeoutHandle,
      reminderHandle,
      escalationHandle,
      quorumRequired,
      approvedBy:     new Set(),
    });
    // Persist hold metadata so a server restart can inform operators of stale holds.
    _persistHolds();
  });
}
