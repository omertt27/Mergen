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
 */

import { randomUUID, randomBytes, createHmac } from 'crypto';
import fs from 'fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { evaluateEnterprisePolicy, loadEnterprisePolicy } from './enterprise-policy-engine.js';
import { computeBlastRadius } from './blast-radius.js';
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
import logger from '../sensor/logger.js';
import { BYPASS_PENDING_FILE, HITL_HOLDS_FILE, DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

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

  const payload = {
    text: `⚠️ *Mergen HITL Gate* — \`${toolName}\` is awaiting approval`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⚠️ Mergen HITL Gate — Approval Required', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Tool*\n\`${toolName}\`` },
          { type: 'mrkdwn', text: `*Args*\n\`${argsSnapshot.slice(0, 200)}\`` },
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
        elements: [{ type: 'mrkdwn', text: `Token \`${token}\` · expires in 15 minutes` }],
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

// ── Core gate logic ───────────────────────────────────────────────────────────

async function applyGate(
  toolName: string,
  args:     unknown,
  next:     () => Promise<McpResult>,
  port:     number,
): Promise<McpResult> {
  const t0 = Date.now();

  const argsSnapshot = JSON.stringify(args ?? {});
  // Extract command-like shapes
  const argsObj    = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
  const commandArg = (argsObj.command ?? argsObj.cmd ?? argsObj.fix ?? '') as string;

  if (checkAndConsumeBypass(toolName, commandArg)) {
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
  const evaluation = evaluateEnterprisePolicy({
    files:       [toolName],
    commands:    [toolName, commandArg].filter(Boolean),
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
    recordGatePass();
    trackSuccessfulCall(toolName);
    recordActivity({ toolName, commandArg, verdict: 'PASS', triggeredRules: [], ruleNames: [] });
    recordGateEvent({
      ts: Date.now(), toolName, command: commandArg || null,
      actor: 'agent', agentId: process.env.MERGEN_AGENT_ID ?? null,
      service: 'mcp', environment: process.env.MERGEN_ENVIRONMENT ?? null,
      verdict: 'pass', triggeredRules: [], guidedAlternative: null,
    });
    return next();
  }

  const reason      = evaluation.reasons.join('; ');
  const alternative = getSuggestedAlternative(evaluation.triggeredRules, commandArg);

  if (evaluation.verdict === 'block') {
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
    recordGateEvent({
      ts: Date.now(), toolName, command: commandArg || null,
      actor: 'agent', agentId: process.env.MERGEN_AGENT_ID ?? null,
      service: 'mcp', environment: process.env.MERGEN_ENVIRONMENT ?? null,
      verdict: 'block', triggeredRules: evaluation.triggeredRules, guidedAlternative: alternative,
    });
    const bypassToken = registerBypassBlock(toolName, commandArg, evaluation.triggeredRules);
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
          `👉 **To approve this execution once, run this command in your terminal:**`,
          `   \`mergen approve ${bypassToken}\``,
          ``,
          `_Action logged to the Agent Blunder Log. To modify this policy: \`~/.mergen/enterprise-policy.json\`._`,
        ].join('\n'),
      }],
      isError: true,
    };
  }

  // verdict === 'warn' → HITL hold
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

    _pendingHolds.set(token, {
      toolName,
      argsSnapshot,
      policyReason:   reason,
      triggeredRules: evaluation.triggeredRules,
      heldAt,
      resolve,
      timeoutHandle,
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
