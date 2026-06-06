/**
 * slack-routing.ts — Service-to-Slack webhook routing configuration.
 *
 * Maps service names to specific Slack webhook URLs so alerts from
 * different services go to different channels/workspaces.
 *
 * Match order: exact service name → wildcard '*' → null (use global WEBHOOK env).
 *
 * Stored at ~/.mergen/slack-routing.json. Managed via:
 *   GET  /slack/routing          — list all rules
 *   POST /slack/routing          — upsert a rule
 *   DELETE /slack/routing/:id    — remove a rule
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

export interface SlackRoutingRule {
  id: string;
  /** Service name to match, or '*' for catch-all fallback. */
  service: string;
  /** Slack incoming webhook URL for this service's alerts. */
  webhook: string;
  /** Human-readable channel name (metadata only — routing is by webhook). */
  channel?: string;
  /** Minimum confidence score [0–1] to alert. Overrides global MIN_CONFIDENCE. */
  minConfidence?: number;
  /**
   * Confidence score at which to add an @oncall mention in the alert.
   * Only effective when oncallMention is also set.
   */
  escalateAt?: number;
  /** Slack user or group to mention on escalation, e.g. '<!oncall>' or '<@U12345>'. */
  oncallMention?: string;
}

interface RoutingFile {
  version: 1;
  rules: SlackRoutingRule[];
}

const ROUTING_FILE = path.join(DATA_DIR, 'slack-routing.json');

let _rules: SlackRoutingRule[] = [];
let _loaded = false;

function load(): void {
  if (_loaded) return;
  _loaded = true;
  if (!fs.existsSync(ROUTING_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8')) as RoutingFile;
    if (parsed?.version === 1 && Array.isArray(parsed.rules)) {
      _rules = parsed.rules;
    }
  } catch (err) {
    logger.warn({ err }, 'slack-routing: failed to load config, starting empty');
  }
}

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${ROUTING_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, rules: _rules } satisfies RoutingFile, null, 2), 'utf8');
    fs.renameSync(tmp, ROUTING_FILE);
  } catch (err) {
    logger.warn({ err }, 'slack-routing: failed to persist config');
  }
}

export function getRules(): SlackRoutingRule[] {
  load();
  return [..._rules];
}

/**
 * Find the best webhook for a given service name.
 * Returns the matched rule so callers can read escalation config.
 */
export function getRoutingForService(service: string): SlackRoutingRule | null {
  load();
  const exact = _rules.find((r) => r.service === service);
  if (exact) return exact;
  return _rules.find((r) => r.service === '*') ?? null;
}

/**
 * Upsert a routing rule. If a rule with the same `service` already exists,
 * it is replaced. Otherwise the rule is appended.
 */
export function upsertRule(input: Omit<SlackRoutingRule, 'id'> & { id?: string }): SlackRoutingRule {
  load();
  const id = input.id ?? `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const rule: SlackRoutingRule = { ...input, id };

  const existingIdx = _rules.findIndex((r) => r.id === id || r.service === input.service);
  if (existingIdx >= 0) {
    _rules[existingIdx] = rule;
  } else {
    _rules.push(rule);
  }
  persist();
  return rule;
}

export function deleteRule(id: string): boolean {
  load();
  const before = _rules.length;
  _rules = _rules.filter((r) => r.id !== id);
  if (_rules.length === before) return false;
  persist();
  return true;
}
