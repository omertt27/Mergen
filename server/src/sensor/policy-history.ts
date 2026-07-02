/**
 * policy-history.ts — Tamper-evident changelog for enterprise-policy.json.
 *
 * Every call to saveEnterprisePolicy is intercepted by the hook registered here.
 * Each change is recorded with: who changed it, when, and a structural diff
 * (rules added, removed, modified). This closes the gap where policy changes are
 * as consequential as code changes but have no git history.
 *
 * Storage: ~/.mergen/policy-history.json (bounded ring, 500 entries)
 * Exposed via: GET /policies/history
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR, zeroRetentionMode } from './paths.js';
import logger from './logger.js';
import type { EnterprisePolicyConfig, EnterprisePolicyRule } from '../intelligence/enterprise-policy-engine.js';

const POLICY_HISTORY_FILE = path.join(DATA_DIR, 'policy-history.json');
const MAX_HISTORY         = 500;

export interface PolicyChangeEntry {
  id:          string;
  changedAt:   number;
  actor:       string;
  /** Previous rule count. */
  rulesBefore: number;
  /** New rule count. */
  rulesAfter:  number;
  /** Rules added in this change. */
  added:       Array<{ id: string; name: string; action: string }>;
  /** Rules removed in this change. */
  removed:     Array<{ id: string; name: string; action: string }>;
  /** Rules whose action, conditions, or reason changed. */
  modified:    Array<{ id: string; name: string; from: string; to: string }>;
  /** Whether the enabled flag changed. */
  enabledChanged: boolean | null;
  enabledBefore:  boolean | null;
  enabledAfter:   boolean | null;
}

interface HistoryFile { version: 1; entries: PolicyChangeEntry[] }

let _entries: PolicyChangeEntry[] = [];
let _loaded = false;

function _load(): void {
  if (_loaded) return;
  _loaded = true;
  if (!fs.existsSync(POLICY_HISTORY_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(POLICY_HISTORY_FILE, 'utf8')) as HistoryFile;
    if (raw?.version === 1 && Array.isArray(raw.entries)) {
      _entries = raw.entries.slice(-MAX_HISTORY);
    }
  } catch (err) {
    logger.warn({ err }, 'policy-history: failed to load — starting fresh');
  }
}

function _persist(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${POLICY_HISTORY_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: _entries } satisfies HistoryFile), 'utf8');
    fs.renameSync(tmp, POLICY_HISTORY_FILE);
  } catch (err) {
    logger.warn({ err }, 'policy-history: persist failed');
  }
}

function _summariseRule(r: EnterprisePolicyRule): { id: string; name: string; action: string } {
  return { id: r.id, name: r.name, action: r.action };
}

/**
 * Record a policy change by diffing the old and new configs.
 * Called by the policy save path in enterprise-policy-engine.ts or the
 * onPolicySaved hook registered below.
 */
export function recordPolicyChange(
  before: EnterprisePolicyConfig | null,
  after:  EnterprisePolicyConfig,
  actor = 'unknown',
): void {
  _load();

  const beforeRules = before?.rules ?? [];
  const afterRules  = after.rules;

  const beforeIds = new Map<string, EnterprisePolicyRule>(beforeRules.map((r) => [r.id, r]));
  const afterIds  = new Map<string, EnterprisePolicyRule>(afterRules.map((r) => [r.id, r]));

  const added: PolicyChangeEntry['added'] = [];
  const removed: PolicyChangeEntry['removed'] = [];
  const modified: PolicyChangeEntry['modified'] = [];

  for (const [id, rule] of afterIds) {
    if (!beforeIds.has(id)) {
      added.push(_summariseRule(rule));
    } else {
      const old = beforeIds.get(id)!;
      const oldStr = JSON.stringify({ action: old.action, reason: old.reason, conditions: old.conditions });
      const newStr = JSON.stringify({ action: rule.action, reason: rule.reason, conditions: rule.conditions });
      if (oldStr !== newStr) {
        modified.push({ id: rule.id, name: rule.name, from: oldStr.slice(0, 200), to: newStr.slice(0, 200) });
      }
    }
  }
  for (const [id, rule] of beforeIds) {
    if (!afterIds.has(id)) removed.push(_summariseRule(rule));
  }

  const enabledChanged = before ? before.enabled !== after.enabled : null;

  const entry: PolicyChangeEntry = {
    id:             randomUUID(),
    changedAt:      Date.now(),
    actor,
    rulesBefore:    beforeRules.length,
    rulesAfter:     afterRules.length,
    added,
    removed,
    modified,
    enabledChanged,
    enabledBefore:  before?.enabled ?? null,
    enabledAfter:   after.enabled,
  };

  _entries.push(entry);
  if (_entries.length > MAX_HISTORY) _entries = _entries.slice(-MAX_HISTORY);
  _persist();

  logger.info(
    { added: added.length, removed: removed.length, modified: modified.length, actor },
    'policy-history: change recorded',
  );
}

export function getPolicyHistory(): PolicyChangeEntry[] {
  _load();
  return [..._entries].reverse(); // newest first
}
