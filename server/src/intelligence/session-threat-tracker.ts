/**
 * session-threat-tracker.ts — Multi-turn behavioral memory for the MCP gate.
 *
 * Three intelligence layers built on per-session call history:
 *
 *   Feature 2 — Multi-Turn Threat Sequencing:
 *     Maintains a 20-call ring per session. Before policy evaluation, checks
 *     whether [prior calls + current call] complete a known dangerous sequence
 *     (credential steal → exfil, probe → destroy, etc.). Sequences the gate
 *     cannot catch in a single call.
 *
 *   Feature 3 — Contamination Chain Tracking:
 *     When a prompt injection is blocked, marks the session as contaminated for
 *     the next N calls. Contaminated sessions have PASS verdicts upgraded to
 *     HOLD because the agent's reasoning may already be corrupted.
 *
 *   Feature 4 — Cross-Session Bad Actor Tracking:
 *     Accumulates a reputation score per agent ID across sessions. Agents that
 *     repeatedly trigger blocks, injections, or sequence threats are promoted to
 *     elevated or high scrutiny tiers, which raise the bar for autonomous PASSes.
 *
 * All session state is in-memory (no disk write). Reputation is persisted async
 * via agent-context-store so it survives server restarts.
 */

import logger from '../sensor/logger.js';

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionCall {
  toolName: string;
  commandArg: string;
  verdict: 'PASS' | 'BLOCK' | 'HOLD';
  ts: number;
}

interface SessionState {
  calls: SessionCall[];
  contaminatedCallsRemaining: number;
  contaminationSource: string;
  lastActivity: number;
}

const SESSION_RING_SIZE = 20;
const SESSION_EXPIRY_MS = 30 * 60 * 1_000; // 30 minutes inactivity

const _sessions = new Map<string, SessionState>();

function _getOrCreate(sessionId: string): SessionState {
  let s = _sessions.get(sessionId);
  if (!s) {
    s = { calls: [], contaminatedCallsRemaining: 0, contaminationSource: '', lastActivity: Date.now() };
    _sessions.set(sessionId, s);
    // Restore contamination state from the persistent store on first access.
    void _hydrateContamination(sessionId);
  }
  s.lastActivity = Date.now();
  return s;
}

const _pruneHandle = setInterval(() => {
  const cutoff = Date.now() - SESSION_EXPIRY_MS;
  for (const [id, s] of _sessions) {
    if (s.lastActivity < cutoff) _sessions.delete(id);
  }
}, 60 * 60 * 1_000);
_pruneHandle.unref();

// ── Threat sequence patterns ──────────────────────────────────────────────────

interface ThreatSequence {
  steps: RegExp[];
  label: string;
}

const THREAT_SEQUENCES: ThreatSequence[] = [
  {
    steps: [/env|printenv|cat\s+\.env/i, /curl\b|wget\b|nc\b|netcat\b/i],
    label: 'credential_exfil_chain',
  },
  {
    steps: [/rm.*log|delete.*log|clear.*log/i, /rm\s+-rf/i],
    label: 'cover_tracks_chain',
  },
  {
    steps: [/select.*from|describe\s+table|show\s+tables/i, /drop\s+table|truncate\s+table/i],
    label: 'db_recon_destroy_chain',
  },
  {
    steps: [/kubectl\s+get|kubectl\s+describe/i, /kubectl\s+delete|terraform\s+destroy/i],
    label: 'infra_recon_destroy_chain',
  },
  // git history read → exfil: agent dumps commit history or secrets then ships them out
  {
    steps: [/git\s+log|git\s+show|git\s+diff\b/i, /curl\b|wget\b|nc\b|netcat\b/i],
    label: 'git_history_exfil_chain',
  },
  // AWS identity probe → privilege escalation via role assumption or IAM mutation
  {
    steps: [/aws\s+sts\s+get-caller-identity|aws\s+iam\s+list/i, /aws\s+sts\s+assume-role|aws\s+iam\s+attach|aws\s+iam\s+put/i],
    label: 'aws_priv_esc_chain',
  },
  // /etc/passwd or /etc/shadow read → exfil of system credentials
  {
    steps: [/cat\s+\/etc\/passwd|cat\s+\/etc\/shadow|\/etc\/shadow/i, /curl\b|wget\b|nc\b|netcat\b/i],
    label: 'system_cred_exfil_chain',
  },
  // setuid/world-writable chmod → execute as privileged user
  {
    steps: [/chmod\s+(777|[0-9]*[47][0-9]*s|[ugo]\+s)/i, /\.\/|\bbash\b|\bsh\b|\bexec\b/i],
    label: 'suid_escalation_chain',
  },
];

// ── Public API — Feature 2: Multi-turn sequencing ────────────────────────────

export function recordSessionCall(
  sessionId: string,
  toolName: string,
  commandArg: string,
  verdict: 'PASS' | 'BLOCK' | 'HOLD',
): void {
  const s = _getOrCreate(sessionId);
  s.calls.push({ toolName, commandArg, verdict, ts: Date.now() });
  if (s.calls.length > SESSION_RING_SIZE) s.calls.shift();
  if (s.contaminatedCallsRemaining > 0) s.contaminatedCallsRemaining--;
}

/**
 * Check whether the current commandArg, combined with the session's prior calls,
 * completes a known multi-step attack sequence.
 * Returns immediately on first match (O(sequences × history_len)).
 */
export function detectSequenceThreat(
  sessionId: string,
  currentCommandArg: string,
): { threat: boolean; label: string | null } {
  const s = _sessions.get(sessionId);
  if (!s || s.calls.length === 0) return { threat: false, label: null };

  const history = s.calls.map((c) => c.commandArg);

  for (const seq of THREAT_SEQUENCES) {
    if (seq.steps.length < 2) continue;
    const lastStep = seq.steps[seq.steps.length - 1];
    if (!lastStep.test(currentCommandArg)) continue; // current must be the final step

    // Walk backward through history to find earlier steps in order
    let stepIdx = seq.steps.length - 2;
    for (let i = history.length - 1; i >= 0 && stepIdx >= 0; i--) {
      if (seq.steps[stepIdx].test(history[i])) stepIdx--;
    }

    if (stepIdx < 0) {
      logger.warn({ sessionId, label: seq.label }, 'session-threat-tracker: multi-turn threat sequence detected');
      return { threat: true, label: seq.label };
    }
  }

  return { threat: false, label: null };
}

// ── Public API — Feature 3: Contamination chain ───────────────────────────────

/**
 * Mark the session as contaminated for the next `callCount` calls.
 * Called immediately after a prompt injection block.
 */
export function markContaminated(sessionId: string, source: string, callCount: number): void {
  const s = _getOrCreate(sessionId);
  s.contaminatedCallsRemaining = callCount;
  s.contaminationSource = source;
  logger.info({ sessionId, source, callCount }, 'session-threat-tracker: session marked contaminated');
  void _persistContamination(sessionId, source, callCount);
}

async function _persistContamination(sessionId: string, source: string, remaining: number): Promise<void> {
  try {
    const { agentContextStore } = await import('../sensor/agent-context-store.js');
    const expiresAt = Date.now() + SESSION_EXPIRY_MS;
    agentContextStore.store(
      sessionId,
      'contamination_v1',
      JSON.stringify({ source, remaining, expiresAt }),
      SESSION_EXPIRY_MS,
    );
  } catch { /* non-critical */ }
}

async function _hydrateContamination(sessionId: string): Promise<void> {
  try {
    const { agentContextStore } = await import('../sensor/agent-context-store.js');
    const entries = agentContextStore.recall(sessionId, 'contamination_v1', 1);
    if (entries.length === 0) return;
    const { source, remaining, expiresAt } = JSON.parse(entries[0].value) as {
      source: string; remaining: number; expiresAt: number;
    };
    if (Date.now() > expiresAt || remaining <= 0) return;
    const s = _getOrCreate(sessionId);
    s.contaminatedCallsRemaining = remaining;
    s.contaminationSource = source;
    logger.info({ sessionId, remaining }, 'session-threat-tracker: contamination state restored from store');
  } catch { /* non-critical */ }
}

export function isSessionContaminated(sessionId: string): boolean {
  const s = _sessions.get(sessionId);
  return s ? s.contaminatedCallsRemaining > 0 : false;
}

export function getContaminationSource(sessionId: string): string | null {
  const s = _sessions.get(sessionId);
  return (s && s.contaminatedCallsRemaining > 0) ? s.contaminationSource || null : null;
}

// ── Public API — Feature 4: Agent reputation ──────────────────────────────────

export type ScrutinyTier = 'normal' | 'elevated' | 'high';

interface AgentReputation {
  blockCount24h: number;
  injectionAttempts: number;
  sequenceThreats: number;
  scrutinyTier: ScrutinyTier;
  windowStart: number;
}

const _reputations = new Map<string, AgentReputation>();
const DAY_MS = 24 * 60 * 60 * 1_000;

const GENERIC_AGENT_ID = 'agent'; // fallback when MERGEN_AGENT_ID is unset

function _defaultReputation(): AgentReputation {
  return { blockCount24h: 0, injectionAttempts: 0, sequenceThreats: 0, scrutinyTier: 'normal', windowStart: Date.now() };
}

function _loadReputation(agentId: string): AgentReputation {
  if (!_reputations.has(agentId)) _reputations.set(agentId, _defaultReputation());
  return _reputations.get(agentId)!;
}

function _computeTier(rep: AgentReputation): ScrutinyTier {
  if (rep.injectionAttempts >= 2 || rep.sequenceThreats >= 1) return 'high';
  if (rep.blockCount24h >= 3) return 'elevated';
  return 'normal';
}

export function updateAgentReputation(
  agentId: string,
  eventType: 'block' | 'injection' | 'sequence',
): void {
  if (!agentId || agentId === GENERIC_AGENT_ID) return;
  const rep = _loadReputation(agentId);
  const now = Date.now();
  if (now - rep.windowStart > DAY_MS) {
    rep.blockCount24h = 0;
    rep.windowStart = now;
  }
  if (eventType === 'block')     rep.blockCount24h++;
  if (eventType === 'injection') rep.injectionAttempts++;
  if (eventType === 'sequence')  rep.sequenceThreats++;
  rep.scrutinyTier = _computeTier(rep);
  void _persistReputation(agentId, rep);
}

export function getAgentScrutinyTier(agentId: string): ScrutinyTier {
  if (!agentId || agentId === GENERIC_AGENT_ID) return 'normal';
  return _loadReputation(agentId).scrutinyTier;
}

async function _persistReputation(agentId: string, rep: AgentReputation): Promise<void> {
  try {
    const { agentContextStore } = await import('../sensor/agent-context-store.js');
    agentContextStore.store(agentId, 'reputation_v1', JSON.stringify(rep), 0);
  } catch { /* non-critical — in-memory state is still correct */ }
}

/** Load persisted reputation from agent-context-store on first access for a given agent. */
export async function hydrateReputation(agentId: string): Promise<void> {
  if (!agentId || agentId === GENERIC_AGENT_ID || _reputations.has(agentId)) return;
  try {
    const { agentContextStore } = await import('../sensor/agent-context-store.js');
    const entries = agentContextStore.recall(agentId, 'reputation_v1', 1);
    if (entries.length > 0) {
      const rep = JSON.parse(entries[0].value) as AgentReputation;
      _reputations.set(agentId, rep);
    }
  } catch { /* non-critical */ }
}

// Read-only tools that are never elevated to HOLD for high-scrutiny agents.
export const READ_ONLY_TOOLS = new Set([
  'analyze_runtime',
  'get_recent_logs',
  'get_network_activity',
  'get_unified_timeline',
  'validate_fix',
  'clear_buffer',
]);

// ── Test helpers ──────────────────────────────────────────────────────────────

export function _resetSessionsForTesting(): void {
  _sessions.clear();
  _reputations.clear();
}
