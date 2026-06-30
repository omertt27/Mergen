/**
 * tool-guard.ts — Synchronous local policy gate for every MCP tool call.
 *
 * Wraps McpServer.registerTool via a Proxy so every tool invocation passes
 * through the local policy engine before the handler runs. Three outcomes:
 *
 *   PASS  — policy clear, handler called immediately (<1ms overhead)
 *   BLOCK — destructive pattern matched, MCP error returned, blunder logged
 *   HOLD  — flagged for review, Promise held until /hitl/approve or /hitl/deny
 *
 * The held-Promise model is the key: MCP stdio transports are naturally async,
 * so holding the Promise until a human responds is a synchronous gate from the
 * AI IDE's perspective — it waits for the JSON-RPC response before proceeding.
 *
 * Wire-up in index.ts:
 *   const mcp = new McpServer(...);
 *   registerTools(createGuardedServer(mcp));
 *
 * Billing invariant: this module must never import billing or usage modules.
 * The local execution gate must never fail open because a billing limit was
 * reached. Cloud features (autopilot, AI analysis) are metered separately.
 */

import { randomUUID, randomBytes, createHmac, createHash } from 'crypto';
import { hostname } from 'os';
import fs from 'fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { evaluateEnterprisePolicy, loadEnterprisePolicy } from './enterprise-policy-engine.js';
import { computeBlastRadius, mostSevereBlast } from './blast-radius.js';
import { recordBlunder } from '../sensor/agent-blunder-store.js';
import {
  recordGateBlock,
  recordGatePass,
  recordGateCoverage,
  recordHitlDecision,
  recordGateEvent,
  recordHitlHold,
} from './gate-analytics.js';
import { trackBlock, trackSuccessfulCall } from '../sensor/bypass-tracker.js';
import { recordActivity } from './activity-feed.js';
import { checkAgentProfile } from './agent-profiles.js';
import {
  detectSequenceThreat,
  recordSessionCall,
  markContaminated,
  isSessionContaminated,
  getContaminationSource,
  updateAgentReputation,
  getAgentScrutinyTier,
  READ_ONLY_TOOLS,
} from './session-threat-tracker.js';
import logger from '../sensor/logger.js';
import { BYPASS_PENDING_FILE, HITL_HOLDS_FILE, DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';
import { normalizeForMatching } from './normalize.js';
import { assertGateHeartbeatFresh } from '../sensor/gate-heartbeat.js';

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

// ── Agent fingerprint ─────────────────────────────────────────────────────────
// When MERGEN_AGENT_ID is not set, derive a stable per-process fingerprint so
// reputation tracking works for the majority of deployments that don't set the env var.
// Computed lazily (not at module load) so test overrides of MERGEN_AGENT_ID take effect.
let _warnedNoAgentId = false;
function _resolveAgentId(): string {
  const id = process.env.MERGEN_AGENT_ID;
  if (id && id !== 'agent') return id;
  if (!_warnedNoAgentId) {
    const fp = createHash('sha256')
      .update(`${hostname()}:${process.ppid ?? 0}`)
      .digest('hex')
      .slice(0, 8);
    logger.info({ fingerprint: `env_${fp}` }, 'tool-guard: MERGEN_AGENT_ID not set — using process fingerprint for reputation tracking');
    _warnedNoAgentId = true;
  }
  const fp = createHash('sha256')
    .update(`${hostname()}:${process.ppid ?? 0}`)
    .digest('hex')
    .slice(0, 8);
  return `env_${fp}`;
}

const HOLD_TIMEOUT_MS = 15 * 60 * 1_000; // 15 minutes — matches execution-gate.ts

// ── Bypass file signing secret ────────────────────────────────────────────────
// Set from index.ts once the local secret is loaded. Used to HMAC-sign the
// bypass persistence file so it can't be tampered with while the server is down.
let _bypassSigningSecret = '';
export function setBypassSecret(secret: string): void {
  _bypassSigningSecret = secret;
}

function _signBypassPayload(payload: string): string {
  if (!_bypassSigningSecret) return '';
  return createHmac('sha256', _bypassSigningSecret).update(payload).digest('hex');
}

// ── Command Bypass Logic ──────────────────────────────────────────────────────

interface PendingBypass {
  token: string;
  toolName: string;
  commandArg: string;
  triggeredRules: string[];
  registeredAt: number;
  approved: boolean;
  expiresAt: number;
}

const _pendingBypasses = new Map<string, PendingBypass>();

function normalizeCommand(cmd: unknown): string {
  if (typeof cmd !== 'string') return '';
  return cmd.trim().replace(/\s+/g, ' ');
}

export function registerBypassBlock(toolName: string, commandArg: string, triggeredRules: string[] = []): string {
  const normalizedCmd = normalizeCommand(commandArg);
  const now = Date.now();
  for (const [token, b] of _pendingBypasses.entries()) {
    if (now > b.expiresAt) _pendingBypasses.delete(token);
  }

  for (const [token, b] of _pendingBypasses.entries()) {
    if (b.toolName === toolName && b.commandArg === normalizedCmd && !b.approved) {
      return token;
    }
  }

  // Use 16 random bytes as hex (128 bits) — no hyphens, no modulo bias, opaque.
  let token: string;
  do { token = randomBytes(16).toString('hex'); } while (_pendingBypasses.has(token));

  _pendingBypasses.set(token, {
    token,
    toolName,
    commandArg: normalizedCmd,
    triggeredRules,
    registeredAt: now,
    approved: false,
    expiresAt: now + 10 * 60 * 1000, // 10 minutes
  });
  return token;
}

export function approveBypass(token: string): { ok: boolean; toolName?: string; commandArg?: string } {
  const b = _pendingBypasses.get(token);
  if (!b || Date.now() > b.expiresAt) return { ok: false };
  b.approved = true;
  recordHitlDecision(b.triggeredRules, 'approve', b.registeredAt);
  return { ok: true, toolName: b.toolName, commandArg: b.commandArg };
}

export function checkAndConsumeBypass(toolName: string, commandArg: string): boolean {
  const normalizedCmd = normalizeCommand(commandArg);
  const now = Date.now();
  for (const [token, b] of _pendingBypasses.entries()) {
    if (now > b.expiresAt) {
      _pendingBypasses.delete(token);
      continue;
    }
    if (b.toolName === toolName && b.commandArg === normalizedCmd && b.approved) {
      _pendingBypasses.delete(token);
      return true;
    }
  }
  return false;
}

export function getPendingBypasses(): Array<{ token: string; toolName: string; commandArg: string; expiresAt: number }> {
  const now = Date.now();
  const list = [];
  for (const [token, b] of _pendingBypasses.entries()) {
    if (now > b.expiresAt) {
      _pendingBypasses.delete(token);
      continue;
    }
    if (!b.approved) {
      list.push({
        token: b.token,
        toolName: b.toolName,
        commandArg: b.commandArg,
        expiresAt: b.expiresAt,
      });
    }
  }
  return list;
}

/** Forcibly invalidate a bypass token — called after too many failed approval attempts. */
export function invalidateBypassToken(token: string): void {
  _pendingBypasses.delete(token);
}

// ── Bypass token persistence (survives server restarts within validity window) ──

interface BypassFile { version: 1; bypasses: PendingBypass[]; sig?: string }

export function persistBypasses(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const now    = Date.now();
    const active = [..._pendingBypasses.values()].filter((b) => b.expiresAt > now);
    const payload = JSON.stringify({ version: 1, bypasses: active } satisfies Omit<BypassFile, 'sig'>);
    const sig     = _signBypassPayload(payload);
    const final   = sig ? JSON.stringify({ version: 1, bypasses: active, sig } satisfies BypassFile) : payload;
    const tmp     = `${BYPASS_PENDING_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, final, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, BYPASS_PENDING_FILE);
  } catch (err) {
    logger.warn({ err }, 'tool-guard: bypass persist failed');
  }
}

export function loadBypasses(): void {
  if (zeroRetentionMode() || !fs.existsSync(BYPASS_PENDING_FILE)) return;
  try {
    const fileContent = fs.readFileSync(BYPASS_PENDING_FILE, 'utf8');
    const raw = JSON.parse(fileContent) as BypassFile;
    if (raw?.version !== 1 || !Array.isArray(raw.bypasses)) return;

    // Verify HMAC if we have a signing secret. Reject the file if it fails.
    if (_bypassSigningSecret && raw.sig !== undefined) {
      const { sig, ...rest } = raw;
      const expectedPayload = JSON.stringify(rest);
      const expected = _signBypassPayload(expectedPayload);
      const sigBuf      = Buffer.from(sig,      'hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      const valid = sigBuf.length === expectedBuf.length &&
        createHmac('sha256', _bypassSigningSecret).update(expectedPayload).digest().equals(expectedBuf);
      if (!valid) {
        logger.error(
          { path: BYPASS_PENDING_FILE },
          'tool-guard: bypass file HMAC mismatch — file may have been tampered with. Discarding.',
        );
        try { fs.unlinkSync(BYPASS_PENDING_FILE); } catch { /* ignore */ }
        return;
      }
    } else if (_bypassSigningSecret && raw.sig === undefined) {
      // Secret is set but file has no sig — written before signing was enabled.
      // Accept once and re-sign on next persist (migration path).
      logger.warn({ path: BYPASS_PENDING_FILE }, 'tool-guard: bypass file has no signature — accepting once and re-signing');
    }

    const now = Date.now();
    for (const b of raw.bypasses) {
      if (b.expiresAt > now) _pendingBypasses.set(b.token, b);
    }
    if (_pendingBypasses.size > 0) logger.info({ count: _pendingBypasses.size }, 'tool-guard: restored pending bypass tokens');
  } catch (err) {
    logger.warn({ err }, 'tool-guard: bypass load failed');
  }
}

interface PendingHold {
  toolName:       string;
  argsSnapshot:   string;
  policyReason:   string;
  triggeredRules: string[];
  heldAt:         number;
  resolve:        (result: McpResult) => void;
  timeoutHandle:  ReturnType<typeof setTimeout>;
  reminderHandle?: ReturnType<typeof setTimeout>;
  escalationHandle?: ReturnType<typeof setTimeout>;
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

export function approveToolCall(token: string): boolean {
  const hold = _pendingHolds.get(token);
  if (!hold) return false;
  clearTimeout(hold.timeoutHandle);
  if (hold.reminderHandle) clearTimeout(hold.reminderHandle);
  if (hold.escalationHandle) clearTimeout(hold.escalationHandle);
  _pendingHolds.delete(token);
  _persistHolds();
  recordHitlDecision(hold.triggeredRules, 'approve', hold.heldAt);
  logger.info({ token, toolName: hold.toolName }, 'tool-guard: HITL approved');
  hold.resolve({
    content: [{ type: 'text', text: `✅ Tool call \`${hold.toolName}\` approved by operator.` }],
  });
  return true;
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

export function getPendingHolds(): Array<{ token: string; toolName: string; policyReason: string }> {
  return [..._pendingHolds.entries()].map(([token, h]) => ({
    token,
    toolName:     h.toolName,
    policyReason: h.policyReason,
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
      {
        type: 'actions',
        elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: '▶️ Approve', emoji: true }, url: approveUrl },
          { type: 'button', style: 'danger',  text: { type: 'plain_text', text: '🚫 Deny',    emoji: true }, url: denyUrl },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Token \`${token}\` · Slack reminder at 5 min · PagerDuty/Slack escalation at 10 min · auto-cancel at 15 min` }],
      },
    ],
    mergen: { type: 'hitl_gate', token, toolName, reason, approveUrl, denyUrl },
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

// ── Recursive arg string extractor (fix: agents can hide commands in non-standard keys) ──
// Scans every string value in the args tree, not just command/cmd/fix.
// Depth-limited to prevent DoS via deeply-nested payloads.
function extractAllStrings(obj: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof obj === 'string') return obj.length > 0 ? [obj] : [];
  if (Array.isArray(obj)) return obj.flatMap(v => extractAllStrings(v, depth + 1));
  if (obj !== null && typeof obj === 'object') {
    return Object.values(obj as Record<string, unknown>).flatMap(v => extractAllStrings(v, depth + 1));
  }
  return [];
}

// ── Prompt injection detection ────────────────────────────────────────────────
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(the\s+)?(above|previous|prior)/i,
  /forget\s+(all\s+)?previous\s+instructions?/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /new\s+system\s+prompt/i,
  /\bjailbreak\b/i,
  /\bdan\s+mode\b/i,
  /override\s+(all\s+)?(?:safety|security|policy)\s+(rules?|constraints?|restrictions?)/i,
  // Additional paraphrase variants
  /act\s+as\s+(?:if\s+)?(?:you\s+(?:have\s+no|are\s+without)\s+(?:restrictions?|guidelines?|rules?))/i,
  /from\s+now\s+on\s+(?:you\s+(?:are|will|must|should))/i,
  /pretend\s+(?:you\s+(?:have\s+no|are\s+without)|that\s+(?:safety|policy|rules?))/i,
  /(?:ignore|bypass|circumvent|disable)\s+(?:your\s+)?(?:safety|security|policy|guidelines?|restrictions?)/i,
  /(?:system|instruction|prompt)\s+(?:override|injection|hijack)/i,
  /<\s*(?:system|instructions?)\s*>/i,
];

function detectInjection(text: string): string | null {
  const normalized = normalizeForMatching(text);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) return pattern.source;
  }
  return null;
}

// ── Suggested alternatives for blocked tool calls ─────────────────────────────

const COMMAND_ALTERNATIVES: Array<[RegExp, string]> = [
  [/terraform destroy/i,       'Run `terraform plan -destroy` to preview the blast radius and share the plan output, then request human approval before proceeding.'],
  [/kubectl delete/i,          'Run `kubectl describe <resource>` to confirm the target and current state, then request HITL approval before deletion.'],
  [/drop (table|database)/i,   'Export a schema snapshot, confirm row counts, then create a reversible migration with a rollback path and request HITL approval.'],
  [/truncate table/i,          'Confirm row count with `SELECT count(*) FROM <table>` and back up the data, then request approval to truncate.'],
  [/rm -rf/i,                  'List the target first with `ls -la <path>` to confirm scope, then request human approval before deleting.'],
  [/(destroy|nuke|wipe)\b/i,   'Describe the specific resource and intended outcome, then request human approval — this action is irreversible.'],
];

const RULE_ALTERNATIVES: Record<string, string> = {
  policy_auth_batch_window:
    'Auth changes are locked during the Friday settlement window (12:00–24:00 UTC). Schedule this for after Saturday 00:00 UTC, or submit a change request via HITL for manual override.',
  hold_schema_mutations:
    'Schema mutations require operator approval. Describe the migration intent, submit it for HITL review, and await the operator response before proceeding.',
  policy_prod_database_warn:
    'Database migrations should run via automated pipelines. Open a PR to trigger the migration workflow rather than running it directly.',
};

function getSuggestedAlternative(triggeredRules: string[], commandArg: string): string {
  for (const ruleId of triggeredRules) {
    const ruleAlt = RULE_ALTERNATIVES[ruleId];
    if (ruleAlt) return ruleAlt;
  }
  const haystack = commandArg.toLowerCase();
  for (const [pattern, alt] of COMMAND_ALTERNATIVES) {
    if (pattern.test(haystack)) return alt;
  }
  return 'Describe the intended outcome and the specific resource, then request human approval before executing irreversible actions.';
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

// ── Core gate logic ───────────────────────────────────────────────────────────

async function applyGate(
  toolName: string,
  args:     unknown,
  next:     () => Promise<McpResult>,
  port:     number,
): Promise<McpResult> {
  const t0 = Date.now();
  const heartbeat = assertGateHeartbeatFresh();
  if (!heartbeat.ok) {
    recordGateBlock(['gate_heartbeat_stale']);
    recordBlunder({
      blunderType:     'pipeline_block',
      command:         toolName,
      blockReason:     `Gate heartbeat fail-closed: ${heartbeat.reason}`,
      service:         'mcp',
      tag:             'gate_heartbeat',
      actor:           'agent',
      pid:             null,
      confidenceScore: null,
    });
    logger.error({ toolName, reason: heartbeat.reason }, 'tool-guard: gate heartbeat stale — failing closed');
    return {
      content: [{
        type: 'text',
        text: [
          `🚫 **Mergen fail-closed: local execution gate heartbeat is not fresh.**`,
          ``,
          `**Tool:** \`${toolName}\``,
          `**Why:** ${heartbeat.reason}`,
          ``,
          `_Restart Mergen or restore the gate heartbeat before executing agent actions._`,
        ].join('\n'),
      }],
      isError: true,
    };
  }

  const argsSnapshot = JSON.stringify(args ?? {});
  // Extract the primary command arg (for bypass matching, alternatives, blast radius).
  const argsObj    = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
  const commandArg = (argsObj.command ?? argsObj.cmd ?? argsObj.fix ?? '') as string;
  // All string values in args — passed to policy engine so destructive payloads in
  // non-standard keys (script, input, query, payload, …) are also evaluated.
  const allArgStrings = extractAllStrings(args);

  // Session ID: stable per agent identity; falls back to process fingerprint.
  const agentId   = _resolveAgentId();
  const sessionId = agentId;

  // ── Feature 2: Multi-turn threat sequence detection ───────────────────────────
  const { threat: sequenceThreat, label: sequenceLabel } = detectSequenceThreat(sessionId, commandArg || argsSnapshot.slice(0, 200));
  if (sequenceThreat) {
    updateAgentReputation(agentId, 'sequence');
    recordGateBlock(['sequence_threat']);
    recordBlunder({
      blunderType:     'pipeline_block',
      command:         toolName,
      blockReason:     `Multi-turn threat sequence detected: ${sequenceLabel}`,
      service:         'mcp',
      tag:             'sequence_threat',
      actor:           agentId,
      pid:             null,
      confidenceScore: null,
    });
    recordSessionCall(sessionId, toolName, commandArg, 'BLOCK');
    recordActivity({ toolName, commandArg, verdict: 'BLOCK', triggeredRules: ['sequence_threat'], ruleNames: ['Multi-Turn Threat Sequence'] });
    return {
      content: [{
        type: 'text',
        text: [
          `🚫 **Mergen blocked this tool call: multi-turn threat sequence detected.**`,
          ``,
          `**Tool:** \`${toolName}\``,
          `**Pattern:** \`${sequenceLabel}\``,
          `**Why:** The sequence of recent tool calls matches a known multi-step attack chain.`,
          ``,
          `_This event has been logged to the Agent Blunder Log._`,
        ].join('\n'),
      }],
      isError: true,
    };
  }

  // ── Fix #6: Prompt injection detection ───────────────────────────────────────
  const injectionMatch = detectInjection(argsSnapshot);
  if (injectionMatch) {
    updateAgentReputation(agentId, 'injection');
    // Feature 3: contaminate the session for the next 5 calls
    markContaminated(sessionId, injectionMatch, 5);
    recordGateBlock(['injection_attempt']);
    recordBlunder({
      blunderType:     'injection_attempt',
      command:         toolName,
      blockReason:     `Prompt injection pattern detected in tool arguments: ${injectionMatch}`,
      service:         'mcp',
      tag:             'injection',
      actor:           agentId,
      pid:             null,
      confidenceScore: null,
    });
    logger.warn({ toolName, injectionMatch }, 'tool-guard: prompt injection attempt detected in args');
    recordSessionCall(sessionId, toolName, commandArg, 'BLOCK');
    recordActivity({ toolName, commandArg, verdict: 'BLOCK', triggeredRules: ['injection_attempt'], ruleNames: ['Prompt Injection'] });
    return {
      content: [{
        type: 'text',
        text: `🚫 **Mergen blocked this tool call: prompt injection pattern detected.**\n\n**Tool:** \`${toolName}\`\n\n_This event has been logged to the Agent Blunder Log._`,
      }],
      isError: true,
    };
  }

  // ── Fix #2: Bypass approved — still enforce hard block rules ─────────────────
  // A bypass token only overrides 'warn' (HOLD) rules. Hard 'block' rules are
  // immutable and cannot be bypassed by operator approval.
  if (checkAndConsumeBypass(toolName, commandArg)) {
    const hardEval = evaluateEnterprisePolicy({
      files:       [toolName],
      commands:    [toolName, ...allArgStrings],
      actor:       'agent',
      service:     'mcp',
      timestamp:   Date.now(),
      environment: process.env.MERGEN_ENVIRONMENT ?? undefined,
      repo:        process.env.MERGEN_REPO ?? undefined,
      agentId:     process.env.MERGEN_AGENT_ID ?? undefined,
    });
    if (hardEval.verdict === 'block') {
      const hardReason = hardEval.reasons.join('; ');
      recordGateBlock(hardEval.triggeredRules);
      recordBlunder({
        blunderType:     'pipeline_block',
        command:         toolName,
        blockReason:     `Hard policy block — bypass cannot override: ${hardReason}`,
        service:         'mcp',
        tag:             'tool_guard',
        actor:           'agent',
        pid:             null,
        confidenceScore: null,
      });
      logger.warn({ toolName, reason: hardReason }, 'tool-guard: hard block rule rejected bypass approval');
      return {
        content: [{
          type: 'text',
          text: [
            `🚫 **Hard policy block — this action cannot be bypassed by operator approval.**`,
            ``,
            `**Tool:** \`${toolName}\``,
            `**Why:** ${hardReason}`,
            ``,
            `_Hard blocks are immutable safety guardrails. Modify \`~/.mergen/enterprise-policy.json\` to change the rule itself._`,
          ].join('\n'),
        }],
        isError: true,
      };
    }
    logger.info({ toolName, commandArg }, 'tool-guard: approved bypass consumed, tool call passing');
    recordGatePass();
    trackSuccessfulCall(toolName);
    return next();
  }

  // Per-agent profile check — enforced before enterprise policy
  const profileBlock = checkAgentProfile(toolName);
  if (profileBlock) {
    recordGateBlock([]);
    recordBlunder({
      blunderType:     'rbac_block',
      command:         toolName,
      blockReason:     profileBlock,
      service:         'mcp',
      tag:             'agent_profile',
      actor:           process.env.MERGEN_AGENT_ID ?? 'agent',
      pid:             null,
      confidenceScore: null,
    });
    recordActivity({ toolName, commandArg, verdict: 'BLOCK', triggeredRules: ['agent_profile'], ruleNames: ['Agent Profile Block'] });
    return {
      content: [{
        type: 'text',
        text: `🚫 **Mergen agent profile gate blocked this tool call.**\n\n**Tool:** \`${toolName}\`\n**Why:** ${profileBlock}\n\n_Adjust permissions at: mergen-server agent-update ${process.env.MERGEN_AGENT_ID ?? ''}_`,
      }],
      isError: true,
    };
  }

  // Actor identity is always 'agent' for MCP tool calls — it must not be derived
  // from agent-supplied arguments, which the agent can forge to bypass AI-specific rules.
  // Environment, repo, and agentId come from server-side env vars set by the operator.
  // Fix #3: pass ALL extracted strings as commands so non-standard arg keys are evaluated.
  const evaluation = evaluateEnterprisePolicy({
    files:       [toolName],
    commands:    [toolName, ...allArgStrings],
    actor:       'agent',
    service:     'mcp',
    timestamp:   Date.now(),
    environment: process.env.MERGEN_ENVIRONMENT ?? undefined,
    repo:        process.env.MERGEN_REPO ?? undefined,
    agentId:     process.env.MERGEN_AGENT_ID ?? undefined,
  });

  const evalMs = Date.now() - t0;
  if (evalMs > 10) {
    logger.warn({ evalMs, toolName }, 'tool-guard: policy evaluation exceeded 10ms target');
  }

  recordGateCoverage(toolName, evaluation.triggeredRules);

  if (evaluation.verdict === 'pass') {
    // Blast radius upgrade — only for explicitly data-destructive scope
    // (DROP TABLE / TRUNCATE) that somehow cleared all policy rules. Evaluate over
    // ALL extracted arg strings so payloads in non-standard keys are caught too.
    const blastCandidates = (allArgStrings.length > 0 ? allArgStrings : [commandArg || toolName])
      .map(s => computeBlastRadius(s));
    const blast = mostSevereBlast(blastCandidates);
    if (!blast.reversible && blast.dataAtRisk && blast.scope === 'data-destructive') {
      evaluation.verdict = 'warn';
      evaluation.triggeredRules.push('blast_radius_gate');
      evaluation.reasons.push(`Auto-hold: irreversible data operation detected (scope: ${blast.scope})`);
      logger.info({ toolName, scope: blast.scope }, 'tool-guard: blast radius gate upgraded pass → hold');
    } else {
      // Feature 3: contamination upgrade — PASS → HOLD when session is contaminated
      const contaminated = isSessionContaminated(sessionId);
      if (contaminated) {
        const source = getContaminationSource(sessionId);
        evaluation.verdict = 'warn';
        evaluation.triggeredRules.push('contamination_hold');
        evaluation.reasons.push(`Session contaminated by prior injection attempt (pattern: ${source}). Human review required.`);
        logger.info({ sessionId, toolName }, 'tool-guard: contamination hold — upgrading PASS to HOLD');
      } else {
        // Feature 4: high-scrutiny agent — all non-read-only calls → HOLD
        const tier = getAgentScrutinyTier(agentId);
        if (tier === 'high' && !READ_ONLY_TOOLS.has(toolName)) {
          evaluation.verdict = 'warn';
          evaluation.triggeredRules.push('high_scrutiny_hold');
          evaluation.reasons.push(`Agent ${agentId} is under high scrutiny (repeated injection/sequence threats). Human review required.`);
          logger.info({ agentId, toolName }, 'tool-guard: high-scrutiny hold applied');
        } else if (tier === 'elevated' && !blast.reversible && blast.scope !== 'unknown') {
          // elevated: only hold calls with known blast radius impact
          evaluation.verdict = 'warn';
          evaluation.triggeredRules.push('elevated_scrutiny_hold');
          evaluation.reasons.push(`Agent ${agentId} is under elevated scrutiny (repeated blocks). Non-reversible command requires human review.`);
          logger.info({ agentId, toolName, scope: blast.scope }, 'tool-guard: elevated-scrutiny hold applied');
        } else {
          recordGatePass();
          trackSuccessfulCall(toolName);
          recordSessionCall(sessionId, toolName, commandArg, 'PASS');
          recordActivity({ toolName, commandArg, verdict: 'PASS', triggeredRules: [], ruleNames: [] });
          recordGateEvent({
            ts: Date.now(), toolName, command: commandArg || null,
            actor: 'agent', agentId: process.env.MERGEN_AGENT_ID ?? null,
            service: 'mcp', environment: process.env.MERGEN_ENVIRONMENT ?? null,
            verdict: 'pass', triggeredRules: [], guidedAlternative: null,
          });
          return next();
        }
      }
    }
  }

  const reason      = evaluation.reasons.join('; ');
  const alternative = getSuggestedAlternative(evaluation.triggeredRules, commandArg);

  if (evaluation.verdict === 'block') {
    updateAgentReputation(agentId, 'block');
    recordGateBlock(evaluation.triggeredRules);
    trackBlock(toolName, evaluation.triggeredRules);
    recordBlunder({
      blunderType:     'pipeline_block',
      command:         toolName,
      blockReason:     reason,
      service:         'mcp',
      tag:             'tool_guard',
      actor:           'agent',
      pid:             null,
      confidenceScore: null,
    });
    logger.warn({ toolName, reason }, 'tool-guard: tool call blocked by local policy');
    recordSessionCall(sessionId, toolName, commandArg, 'BLOCK');
    recordGateEvent({
      ts: Date.now(), toolName, command: commandArg || null,
      actor: 'agent', agentId: process.env.MERGEN_AGENT_ID ?? null,
      service: 'mcp', environment: process.env.MERGEN_ENVIRONMENT ?? null,
      verdict: 'block', triggeredRules: evaluation.triggeredRules, guidedAlternative: alternative,
    });
    // Fix #1: Register bypass but do NOT expose the token in the MCP response.
    // The token is logged to the operator terminal only — the agent cannot see it
    // and therefore cannot self-approve via a bash tool call.
    const bypassToken = registerBypassBlock(toolName, commandArg, evaluation.triggeredRules);
    logger.info(
      { bypassToken, toolName, commandArg },
      `tool-guard: bypass approval required — operator can run: mergen approve ${bypassToken}`,
    );
    const ruleNames   = loadEnterprisePolicy().rules
      .filter(r => evaluation.triggeredRules.includes(r.id))
      .map(r => r.name);
    recordActivity({ toolName, commandArg, verdict: 'BLOCK', triggeredRules: evaluation.triggeredRules, ruleNames });
    return {
      content: [{
        type: 'text',
        text:  [
          `🚫 **Mergen policy gate blocked this tool call.**`,
          ``,
          `**Tool:** \`${toolName}\``,
          `**Why:** ${reason}`,
          ``,
          `**What to do instead:** ${alternative}`,
          ``,
          `_Action logged to the Agent Blunder Log. An operator must approve this action via the Mergen terminal or Slack. To modify this policy: \`~/.mergen/enterprise-policy.json\`._`,
        ].join('\n'),
      }],
      isError: true,
    };
  }

  // verdict === 'warn' → HITL hold
  recordSessionCall(sessionId, toolName, commandArg, 'HOLD');
  const token  = randomUUID();
  const heldAt = Date.now();
  logger.info({ toolName, token, reason }, 'tool-guard: tool call held for HITL approval');

  recordGateEvent({
    ts: heldAt, toolName, command: commandArg || null,
    actor: 'agent', agentId: process.env.MERGEN_AGENT_ID ?? null,
    service: 'mcp', environment: process.env.MERGEN_ENVIRONMENT ?? null,
    verdict: 'hold', triggeredRules: evaluation.triggeredRules, guidedAlternative: alternative,
  });
  recordHitlHold();

  const holdRuleNames = loadEnterprisePolicy().rules
    .filter(r => evaluation.triggeredRules.includes(r.id))
    .map(r => r.name);
  recordActivity({ toolName, commandArg, verdict: 'HOLD', triggeredRules: evaluation.triggeredRules, ruleNames: holdRuleNames });
  void fireHitlWebhook(token, toolName, argsSnapshot, reason, port, {
    triggeredRules: evaluation.triggeredRules,
    commandArg,
    suggestedAlt:   alternative,
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

    // Escalation: 5-min reminder, 10-min urgent escalation (PagerDuty or second Slack).
    const reminderHandle = setTimeout(() => {
      void fireHitlReminder(token, toolName, 10);
    }, 5 * 60 * 1_000);
    reminderHandle.unref();

    const escalationHandle = setTimeout(() => {
      void fireHitlEscalation(token, toolName);
    }, 10 * 60 * 1_000);
    escalationHandle.unref();

    _pendingHolds.set(token, {
      toolName,
      argsSnapshot,
      policyReason:   reason,
      triggeredRules: evaluation.triggeredRules,
      heldAt,
      resolve,
      timeoutHandle,
      reminderHandle,
      escalationHandle,
    });
    // Persist hold metadata so a server restart can inform operators of stale holds.
    _persistHolds();
  });
}

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Returns a Proxy over the McpServer that intercepts registerTool and wraps
 * every handler with applyGate. Pass the returned value to registerTools().
 *
 * @param port - The HTTP port so /hitl approve/deny URLs are correct in webhooks
 */
export function createGuardedServer(server: McpServer, port: number): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver);
      return (
        name:    string,
        schema:  unknown,
        handler: (args: unknown, extra: unknown) => Promise<McpResult>,
      ) => {
        const guarded = (args: unknown, extra: unknown): Promise<McpResult> =>
          applyGate(name, args, () => handler(args, extra), port);
        return (target as unknown as Record<string, (...a: unknown[]) => unknown>)
          .registerTool.call(target, name, schema, guarded);
      };
    },
  });
}
