/**
 * agent-profiles.ts — Per-agent identity and permission store.
 *
 * Teams register named agent profiles once; from then on policy rules can
 * target specific agents (conditions.agentIds) and the tool guard enforces
 * profile-level tool allow/block lists on top of enterprise policy.
 *
 * Storage: ~/.mergen/agent-profiles.json
 * Identity: a profile is only applied for a VERIFIED agent identity — see
 *   agent-identity.ts. Run `mergen-server agent-register <profile-id>` to
 *   issue a signed MERGEN_AGENT_TOKEN; the caller must present a valid token
 *   to have this profile's allow/block lists enforced. The old bare
 *   MERGEN_AGENT_ID env var alone is not sufficient — it's self-asserted by
 *   the same actor a profile is meant to constrain.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

export interface AgentProfile {
  id:              string;
  name:            string;
  description:     string;
  createdAt:       number;
  /** Tools this agent is allowed to call (empty = all tools allowed) */
  allowedTools:    string[];
  /** Tools this agent is explicitly blocked from calling */
  blockedTools:    string[];
  /** Services this agent may target (empty = all services) */
  allowedServices: string[];
  /** Max risk tier this agent may execute autonomously */
  maxRiskTier:     'read' | 'restart' | 'deploy' | 'full';
}

const PROFILES_FILE = path.join(DATA_DIR, 'agent-profiles.json');

interface ProfilesFile { version: 1; profiles: AgentProfile[] }

let _profiles: AgentProfile[] = [];
let _loaded = false;

function load(force = false): void {
  if (_loaded && !force) return;
  _loaded = true;
  if (!fs.existsSync(PROFILES_FILE)) { _profiles = []; return; }
  try {
    const raw = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')) as ProfilesFile;
    _profiles = raw?.version === 1 && Array.isArray(raw.profiles) ? raw.profiles : [];
  } catch { _profiles = []; }
}

function persist(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${PROFILES_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: _profiles } satisfies ProfilesFile), 'utf8');
    fs.renameSync(tmp, PROFILES_FILE);
  } catch (err) { logger.warn({ err }, 'agent-profiles: persist failed'); }
}

export function listProfiles(): AgentProfile[] {
  load();
  return [..._profiles];
}

export function getProfile(id: string): AgentProfile | null {
  load();
  return _profiles.find((p) => p.id === id) ?? null;
}

export function saveProfile(profile: AgentProfile): void {
  load(true);
  const idx = _profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) _profiles[idx] = profile;
  else _profiles.push(profile);
  persist();
}

export function deleteProfile(id: string): boolean {
  load(true);
  const before = _profiles.length;
  _profiles = _profiles.filter((p) => p.id !== id);
  if (_profiles.length < before) { persist(); return true; }
  return false;
}

/**
 * Check a tool call against the active agent profile (if any).
 * Returns null if allowed, or a reason string if blocked.
 *
 * `verifiedAgentId` must come from agent-identity.ts's resolveAgentIdentity()
 * with `verified: true` — a profile's allow/block lists are a privilege
 * boundary, so they must never be satisfiable by a self-asserted identity.
 * Pass undefined (no profile applies) when the caller has no verified token.
 */
export function checkAgentProfile(toolName: string, service?: string, verifiedAgentId?: string): string | null {
  const agentId = verifiedAgentId;
  if (!agentId) return null;

  load();
  const profile = _profiles.find((p) => p.id === agentId);
  if (!profile) return null;

  if (profile.blockedTools.includes(toolName)) {
    return `Agent profile "${profile.name}" (${agentId}) is not permitted to call ${toolName}`;
  }

  if (profile.allowedTools.length > 0 && !profile.allowedTools.includes(toolName)) {
    return `Agent profile "${profile.name}" (${agentId}) is restricted to: ${profile.allowedTools.join(', ')}`;
  }

  if (service && profile.allowedServices.length > 0 && !profile.allowedServices.includes(service)) {
    return `Agent profile "${profile.name}" (${agentId}) is not permitted to target service: ${service}`;
  }

  return null;
}
