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

import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { evaluateEnterprisePolicy } from './enterprise-policy-engine.js';
import { recordBlunder } from '../sensor/agent-blunder-store.js';
import {
  recordGateBlock,
  recordGatePass,
  recordGateCoverage,
  recordHitlDecision,
} from './gate-analytics.js';
import { trackBlock, trackSuccessfulCall } from '../sensor/bypass-tracker.js';
import logger from '../sensor/logger.js';

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const HOLD_TIMEOUT_MS = 15 * 60 * 1_000; // 15 minutes — matches execution-gate.ts

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

// ── Public resolution API (called by routes/hitl.ts) ─────────────────────────

export function approveToolCall(token: string): boolean {
  const hold = _pendingHolds.get(token);
  if (!hold) return false;
  clearTimeout(hold.timeoutHandle);
  _pendingHolds.delete(token);
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

  // In team/cloud mode the server is reachable from the internet but 127.0.0.1
  // is not. MERGEN_PUBLIC_URL lets operators set the externally-reachable base
  // URL so Slack can POST the approve/deny callback. Falls back to localhost for
  // single-developer local mode.
  const baseUrl    = (process.env.MERGEN_PUBLIC_URL ?? '').replace(/\/$/, '') || `http://127.0.0.1:${port}`;
  const approveUrl = `${baseUrl}/hitl/approve?token=${token}`;
  const denyUrl    = `${baseUrl}/hitl/deny?token=${token}`;

  // Slack-compatible payload (works with Incoming Webhooks and generic HTTP endpoints)
  const payload = {
    text: `⚠️ *Mergen HITL Gate* — tool call \`${toolName}\` is awaiting approval`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*⚠️ Mergen HITL Gate — Approval Required*`,
            `Tool: \`${toolName}\``,
            `Reason: ${reason}`,
            `Args: \`${argsSnapshot.slice(0, 200)}\``,
            '',
            `▶️ Approve: ${approveUrl}`,
            `🚫 Deny: ${denyUrl}`,
            `_Token expires in 15 minutes._`,
          ].join('\n'),
        },
      },
    ],
    // Also include structured data for non-Slack consumers
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
  // Extract command-like strings from well-known arg shapes only.
  // Do NOT pass the full argsSnapshot — arbitrary JSON containing user text
  // (e.g. {"query": "why did the wipe job fail?"}) would trigger false blocks.
  const argsObj    = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
  const commandArg = (argsObj.command ?? argsObj.cmd ?? argsObj.fix ?? '') as string;

  const evaluation = evaluateEnterprisePolicy({
    files:    [toolName],
    commands: [toolName, commandArg].filter(Boolean),
    actor:    'agent',
    service:  'mcp',
    timestamp: Date.now(),
  });

  const evalMs = Date.now() - t0;
  if (evalMs > 10) {
    logger.warn({ evalMs, toolName }, 'tool-guard: policy evaluation exceeded 10ms target');
  }

  recordGateCoverage(toolName, evaluation.triggeredRules);

  if (evaluation.verdict === 'pass') {
    recordGatePass();
    trackSuccessfulCall(toolName);
    return next();
  }

  const reason = evaluation.reasons.join('; ');

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
    const alternative = getSuggestedAlternative(evaluation.triggeredRules, commandArg);
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

  void fireHitlWebhook(token, toolName, argsSnapshot, reason, port);

  return new Promise<McpResult>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      _pendingHolds.delete(token);
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
