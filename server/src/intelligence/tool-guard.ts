/**
 * tool-guard.ts — Synchronous local policy gate for every MCP tool call.
 *
 * Patches the McpServer's low-level `tools/call` dispatch (see
 * createGuardedServer below) so every tool invocation passes through the
 * local policy engine before the handler runs, regardless of which SDK
 * method registered the tool. Three outcomes:
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

import { randomUUID, createHash } from 'crypto';
import { hostname } from 'os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { evaluateEnterprisePolicy, loadEnterprisePolicy } from './enterprise-policy-engine.js';
import { computeBlastRadius, mostSevereBlast } from './blast-radius.js';
import { getStores } from '../storage/store-registry.js';
import {
  recordGateBlock,
  recordGatePass,
  recordGateCoverage,
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
import { assertGateHeartbeatFresh } from '../sensor/gate-heartbeat.js';

// ── Lifecycle helpers moved into focused modules (C1 refactor) ────────────────
// Used locally by the gate; also re-exported below so existing importers
// (index.ts, routes/hitl.ts, tests) keep importing them from tool-guard.js.
import { registerBypassBlock, checkAndConsumeBypass } from './bypass.js';
import { holdToolCall } from './hitl-hold.js';
import { detectInjection, extractAllStrings, getSuggestedAlternative } from './gate-decision.js';

export {
  setBypassSecret, registerBypassBlock, approveBypass, checkAndConsumeBypass,
  getPendingBypasses, getPendingBypassDetail,
  invalidateBypassToken, persistBypasses, loadBypasses,
} from './bypass.js';
export {
  denyStaleHoldsOnStartup, approveToolCall, denyToolCall, getPendingHolds,
} from './hitl-hold.js';

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


// ── Core gate logic ───────────────────────────────────────────────────────────

/**
 * Public entry point — wraps applyGateInner in an explicit fail-closed
 * try/catch. Previously, a thrown exception anywhere in the gate (malformed
 * policy rule, unexpected input shape, etc.) happened to fail closed only
 * because every `next()` call site sits after evaluation completes
 * successfully, so a rejected promise propagated to the SDK's own outer
 * catch without ever reaching the real handler. That was an accident of call
 * order, not a guarantee — a future change that reordered or wrapped
 * evaluation could silently turn it into fail-open. This makes fail-closed
 * an explicit, tested property of the gate itself.
 */
async function applyGate(
  toolName: string,
  args:     unknown,
  next:     () => Promise<McpResult>,
  port:     number,
): Promise<McpResult> {
  try {
    return await applyGateInner(toolName, args, next, port);
  } catch (err) {
    logger.error({ err, toolName }, 'tool-guard: applyGate threw an unexpected error — failing closed');
    await getStores().blunders.record({
      blunderType:     'pipeline_block',
      command:         toolName,
      blockReason:     `Gate threw an unexpected error and failed closed: ${err instanceof Error ? err.message : String(err)}`,
      service:         'mcp',
      tag:             'gate_internal_error',
      actor:           'agent',
      pid:             null,
      confidenceScore: null,
    });
    return {
      content: [{
        type: 'text',
        text: [
          `🚫 **Mergen fail-closed: the local execution gate hit an internal error while evaluating this call.**`,
          ``,
          `**Tool:** \`${toolName}\``,
          ``,
          `_The tool call was not executed. This event has been logged to the Agent Blunder Log._`,
        ].join('\n'),
      }],
      isError: true,
    };
  }
}

async function applyGateInner(
  toolName: string,
  args:     unknown,
  next:     () => Promise<McpResult>,
  port:     number,
): Promise<McpResult> {
  const t0 = Date.now();
  const heartbeat = assertGateHeartbeatFresh();
  if (!heartbeat.ok) {
    recordGateBlock(['gate_heartbeat_stale']);
    await getStores().blunders.record({
      blunderType:     'pipeline_block',
      command:         toolName,
      blockReason:     `Gate heartbeat fail-closed: ${heartbeat.reason}`,
      service:         'mcp',
      tag:             'gate_heartbeat',
      actor:           'agent',
      pid:             null,
      confidenceScore: null,
      triggeredRules:  ['gate_heartbeat_stale'],
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
    await getStores().blunders.record({
      blunderType:     'pipeline_block',
      command:         toolName,
      blockReason:     `Multi-turn threat sequence detected: ${sequenceLabel}`,
      service:         'mcp',
      tag:             'sequence_threat',
      actor:           agentId,
      pid:             null,
      confidenceScore: null,
      triggeredRules:  ['sequence_threat'],
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
    await getStores().blunders.record({
      blunderType:     'injection_attempt',
      command:         toolName,
      blockReason:     `Prompt injection pattern detected in tool arguments: ${injectionMatch}`,
      service:         'mcp',
      tag:             'injection',
      actor:           agentId,
      pid:             null,
      confidenceScore: null,
      triggeredRules:  ['injection_attempt'],
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
      await getStores().blunders.record({
        blunderType:     'pipeline_block',
        command:         toolName,
        blockReason:     `Hard policy block — bypass cannot override: ${hardReason}`,
        service:         'mcp',
        tag:             'tool_guard',
        actor:           'agent',
        pid:             null,
        confidenceScore: null,
        triggeredRules:  hardEval.triggeredRules,
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
    await getStores().blunders.record({
      blunderType:     'rbac_block',
      command:         toolName,
      blockReason:     profileBlock,
      service:         'mcp',
      tag:             'agent_profile',
      actor:           process.env.MERGEN_AGENT_ID ?? 'agent',
      pid:             null,
      confidenceScore: null,
      triggeredRules:  ['agent_profile'],
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
    await getStores().blunders.record({
      blunderType:     'pipeline_block',
      command:         toolName,
      blockReason:     reason,
      service:         'mcp',
      tag:             'tool_guard',
      actor:           'agent',
      pid:             null,
      confidenceScore: null,
      triggeredRules:  evaluation.triggeredRules,
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

  // Delegate the entire HOLD path (approval webhook + held Promise + timeout/
  // reminder/escalation + persistence) to hitl-hold.ts.
  return holdToolCall({
    token,
    toolName,
    argsSnapshot,
    reason,
    triggeredRules: evaluation.triggeredRules,
    heldAt,
    commandArg,
    suggestedAlt:   alternative,
    port,
  });
}

// ── Server factory ────────────────────────────────────────────────────────────

/** Set to true the first time installProtocolGate() successfully patches a
 *  server's dispatch handler — read by assertGateIsInstalled() so startup can
 *  refuse to accept connections if the patch never took effect. */
let _gateInstalled = false;

/** For tests and the startup self-check: true once a guarded server has been created. */
export function isGateInstalled(): boolean {
  return _gateInstalled;
}

/** Reset for testing only. */
export function _resetGateInstalledForTesting(): void {
  _gateInstalled = false;
}

/** Per-instance record of the live gated tools/call dispatch handler, keyed by
 *  server so assertGateCoversRegisteredTools can invoke it directly instead of
 *  re-triggering setRequestHandler (which would install a second wrapped layer
 *  rather than reading the existing one back). */
const _installedGatedHandlers = new WeakMap<McpServer, (request: unknown, extra: unknown) => Promise<McpResult>>();

/**
 * Patches every McpServer instance passed through here so that the MCP
 * `tools/call` JSON-RPC dispatch — the single point every tool invocation
 * must cross to actually execute — runs through applyGate first.
 *
 * This intercepts at the protocol boundary instead of enumerating SDK
 * registration methods. The previous approach trapped `registerTool` and,
 * after a bypass was found, also `tool()` — but the SDK exposes a third,
 * currently-unaudited path (`server.experimental.tasks.registerToolTask()`,
 * which also calls the private `_createRegisteredTool` directly) that neither
 * trap covers, and any future registration sugar the SDK adds would reproduce
 * the same gap. `registerTool`, `tool`, and `registerToolTask` all populate
 * `_registeredTools`, but regardless of which one was used, invoking a tool
 * only ever happens through the low-level `Server`'s dispatch for the
 * `tools/call` method (identified here by reference to the SDK's own exported
 * `CallToolRequestSchema`, not by re-deriving its internal method-literal
 * logic). Patching that one call site is stable across SDK versions because
 * it's dictated by the MCP protocol itself, not by how many registration
 * methods the SDK happens to expose today.
 *
 * @param port - The HTTP port so /hitl approve/deny URLs are correct in webhooks
 */
export function createGuardedServer(server: McpServer, port: number): McpServer {
  // Ordering guard: if any tool was already registered on this exact instance
  // before createGuardedServer ran, the SDK will have already installed its
  // unpatched tools/call dispatch handler (_toolHandlersInitialized flips true
  // the first time any registration method executes) — the patch below would
  // have nothing left to wrap, and those tools would be permanently ungated.
  // index.ts's `registerTools(createGuardedServer(mcp, port))` call order
  // already prevents this, but that's a convention this function can't see
  // from inside itself — assert it instead of assuming it holds forever.
  if ((server as unknown as { _toolHandlersInitialized?: boolean })._toolHandlersInitialized) {
    throw new Error(
      'createGuardedServer: a tool was already registered on this McpServer before the gate was ' +
      'installed — the tools/call dispatch handler is already active and unpatched. Call ' +
      'createGuardedServer(mcp, port) before any registerTool/tool/registerToolTask call, never after.',
    );
  }

  const lowLevel = (server as unknown as {
    server: { setRequestHandler: (schema: unknown, handler: (...a: unknown[]) => unknown) => unknown };
  }).server;

  const originalSetRequestHandler = lowLevel.setRequestHandler.bind(lowLevel);

  lowLevel.setRequestHandler = (schema: unknown, handler: (request: unknown, extra: unknown) => unknown) => {
    if (schema !== CallToolRequestSchema) {
      return originalSetRequestHandler(schema, handler);
    }
    const gated = (request: unknown, extra: unknown): Promise<McpResult> => {
      const r = request as { params?: { name?: string; arguments?: unknown } };
      const toolName = r?.params?.name ?? 'unknown_tool';
      const args      = r?.params?.arguments;
      return applyGate(toolName, args, () => Promise.resolve(handler(request, extra)) as Promise<McpResult>, port);
    };
    // Recorded so assertGateCoversRegisteredTools can invoke the exact live
    // dispatch handler directly — calling lowLevel.setRequestHandler again to
    // "read it back" would install yet another wrapped layer on top of this
    // one instead of reading it, corrupting the real dispatch table entry.
    _installedGatedHandlers.set(server, gated);
    return originalSetRequestHandler(schema, gated);
  };

  _gateInstalled = true;
  return server;
}

/**
 * Startup self-check for the one thing this module cannot see from inside
 * itself: whether the closed-source `intelligence/tools.ts` (registerTools())
 * actually registered its tools on the exact guarded instance it was handed,
 * using it consistently for every tool. That file isn't part of this
 * open-source layer, so its wiring can't be reviewed as source here — this
 * exercises it as a black box instead of assuming it's correct.
 *
 * Two checks, both against the REAL running gate, not a mock:
 *   1. At least one tool was actually registered on `server` — catches
 *      registerTools() silently doing nothing (empty _registeredTools).
 *   2. A synthetic, unmistakably destructive tools/call request — fired
 *      through the actual installed dispatch handler for whatever tool name
 *      IS registered — comes back blocked, and the real handler behind it is
 *      never invoked. This proves the live gate blocks destructive commands
 *      right now, in this process, with whatever policy is actually loaded —
 *      not just that createGuardedServer ran.
 *
 * Call after registerTools(createGuardedServer(mcp, port)) and before
 * mcp.connect(transport). Throws (does not return a boolean) so a failure
 * can't be silently ignored by a caller that forgets to check a return value.
 */
export async function assertGateCoversRegisteredTools(server: McpServer): Promise<void> {
  if (!isGateInstalled()) {
    throw new Error('assertGateCoversRegisteredTools: createGuardedServer was never called on this server.');
  }

  const registeredTools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
  const toolNames = Object.keys(registeredTools);
  if (toolNames.length === 0) {
    throw new Error(
      'assertGateCoversRegisteredTools: no tools are registered on this server — registerTools() ' +
      'appears to have registered nothing. Refusing to start with an empty, unverifiable tool set.',
    );
  }

  const installedHandler = _installedGatedHandlers.get(server);
  if (!installedHandler) {
    throw new Error(
      'assertGateCoversRegisteredTools: no tools/call dispatch handler is installed — ' +
      'setToolRequestHandlers() may never have run despite tools being present in _registeredTools.',
    );
  }

  const syntheticRequest = {
    params: { name: toolNames[0], arguments: { command: 'terraform destroy prod-mergen-selftest' } },
  };
  // The real dispatch handler ultimately calls executeToolHandler → the actual
  // tool implementation if PASS. We can't safely invoke that for an arbitrary
  // registered tool (unknown side effects), so a thrown error here is treated
  // the same as "not blocked" — either way the gate did not return a clean
  // isError:true block, which is the only acceptable outcome for this payload.
  let result: unknown;
  try {
    result = await installedHandler(syntheticRequest, { signal: new AbortController().signal });
  } catch (err) {
    throw new Error(
      `assertGateCoversRegisteredTools: self-test call raised instead of being cleanly blocked by the ` +
      `gate: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const isBlocked = !!(result && typeof result === 'object' && (result as { isError?: boolean }).isError === true);
  if (!isBlocked) {
    throw new Error(
      'assertGateCoversRegisteredTools: a synthetic "terraform destroy" call was NOT blocked by the ' +
      'live tools/call dispatch handler — the gate is not enforcing on this server. Refusing to start.',
    );
  }
}
