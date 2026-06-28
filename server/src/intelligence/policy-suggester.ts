/**
 * policy-suggester.ts — Weekly automated scan that surfaces blunder patterns
 * not yet covered by a named policy rule.
 *
 * How it works:
 *   1. Reads the last 30 days of agent blunders.
 *   2. Groups them by command prefix (first 3 whitespace-separated tokens).
 *   3. For clusters of 5+ blunders, checks whether ANY existing named policy
 *      rule's `conditions.commands` already covers that prefix.
 *   4. Clusters with no coverage are "suggestions" — posted to Slack and
 *      exposed via GET /policy-suggestions so the team can formalise them.
 *
 * Wire-up: call startPolicySuggesterCron() from index.ts after the server
 * starts. It fires immediately (to catch the first restart after deploy) and
 * then every Monday at 09:00 UTC alongside the shadow digest.
 *
 * The goal is the compound moat: as the override corpus and blunder log grow,
 * Mergen proactively turns operational patterns into enforcement policy —
 * without anyone having to remember to do it.
 */

import { getBlunders } from '../sensor/agent-blunder-store.js';
import { loadEnterprisePolicy } from './enterprise-policy-engine.js';
import { synthesizeRulesFromCorpus } from './corpus-to-policy.js';
import logger from '../sensor/logger.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_CLUSTER_SIZE = 5;

export interface PolicySuggestion {
  commandPrefix: string;
  occurrences: number;
  lastSeenAt: number;
  services: string[];
  /** true if ANY existing rule already covers this prefix */
  alreadyCovered: boolean;
  /** 'blunder' = derived from blunder log clusters; 'corpus' = derived from override corpus */
  source?: 'blunder' | 'corpus';
  suggestedRule: {
    id: string;
    name: string;
    action: 'block' | 'warn';
    reason: string;
    conditions: { commands?: string[]; services?: string[]; daysOfWeek?: number[]; hourWindow?: [number, number]; actorType?: string };
  };
}

function commandPrefix(cmd: string | null): string {
  if (!cmd) return '(unknown)';
  return cmd.trim().split(/\s+/).slice(0, 3).join(' ');
}

function isCoveredByPolicy(prefix: string): boolean {
  const policy = loadEnterprisePolicy();
  const lowerPrefix = prefix.toLowerCase();
  for (const rule of policy.rules) {
    const cmds = rule.conditions.commands ?? [];
    if (cmds.some((c) => lowerPrefix.includes(c.toLowerCase()) || c.toLowerCase().includes(lowerPrefix.split(' ')[0]))) {
      return true;
    }
  }
  return false;
}

export function computePolicySuggestions(): PolicySuggestion[] {
  const now = Date.now();
  const cutoff = now - THIRTY_DAYS_MS;
  const recent = getBlunders().filter((b) => b.recordedAt >= cutoff);

  // Cluster by command prefix
  const clusters = new Map<string, { count: number; lastSeenAt: number; services: Set<string> }>();
  for (const b of recent) {
    const prefix = commandPrefix(b.command);
    const entry = clusters.get(prefix) ?? { count: 0, lastSeenAt: 0, services: new Set() };
    entry.count++;
    entry.lastSeenAt = Math.max(entry.lastSeenAt, b.recordedAt);
    if (b.service) entry.services.add(b.service);
    clusters.set(prefix, entry);
  }

  const suggestions: PolicySuggestion[] = [];
  for (const [prefix, data] of clusters) {
    if (data.count < MIN_CLUSTER_SIZE) continue;
    if (prefix === '(unknown)') continue;
    const alreadyCovered = isCoveredByPolicy(prefix);
    const slug = prefix.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 40);
    suggestions.push({
      commandPrefix: prefix,
      occurrences: data.count,
      lastSeenAt: data.lastSeenAt,
      services: [...data.services],
      alreadyCovered,
      suggestedRule: {
        id:     `auto_suggest_${slug}`,
        name:   `Block: ${prefix}`,
        action: 'block',
        reason: `Auto-suggested: this command pattern was blocked ${data.count} times in the last 30 days.`,
        conditions: { commands: [prefix.split(' ')[0]] },
      },
    });
  }

  // Append corpus-derived suggestions (Feature 6)
  const corpusSynthesized = synthesizeRulesFromCorpus();
  for (const { rule, sourceOccurrences, compactedRule } of corpusSynthesized) {
    suggestions.push({
      commandPrefix: compactedRule.incidentTag,
      occurrences:   sourceOccurrences,
      lastSeenAt:    compactedRule.compactedAt,
      services:      compactedRule.service !== 'unknown' ? [compactedRule.service] : [],
      alreadyCovered: false, // synthesizeRulesFromCorpus already filters covered ones
      source:        'corpus',
      suggestedRule: {
        id:         rule.id,
        name:       rule.name,
        action:     rule.action,
        reason:     rule.reason,
        conditions: rule.conditions as PolicySuggestion['suggestedRule']['conditions'],
      },
    });
  }

  return suggestions.sort((a, b) => b.occurrences - a.occurrences);
}

async function postSuggestionsToSlack(suggestions: PolicySuggestion[]): Promise<void> {
  const token   = process.env.MERGEN_SLACK_BOT_TOKEN;
  const channel = process.env.MERGEN_SLACK_DIGEST_CHANNEL ?? process.env.MERGEN_SLACK_CHANNEL;
  if (!token || !channel) return;

  const uncovered = suggestions.filter((s) => !s.alreadyCovered);
  if (uncovered.length === 0) return;

  const lines = uncovered.slice(0, 5).map(
    (s) => `• \`${s.commandPrefix}\` — blocked *${s.occurrences}×* in 30 days (services: ${s.services.join(', ') || 'unknown'})`,
  );

  const payload = {
    channel,
    text: `📋 Mergen Policy Suggestions — ${uncovered.length} uncovered pattern${uncovered.length !== 1 ? 's' : ''}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📋 Mergen Policy Suggestions', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${uncovered.length}* command pattern${uncovered.length !== 1 ? 's' : ''} have been blocked repeatedly but have no named policy rule. Consider formalising them:\n\n${lines.join('\n')}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `View all suggestions and generated rule JSON: \`GET /policy-suggestions\`\nAdd a rule: \`POST /policies/rules\``,
        },
      },
    ],
  };

  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(8_000),
    });
  } catch (err) {
    logger.warn({ err }, 'policy-suggester: Slack post failed');
  }
}

function msUntilNextMonday0900Utc(): number {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday, 9, 5, 0, 0,
  ));
  return Math.max(next.getTime() - Date.now(), 0);
}

function scheduleNext(): void {
  const delay = msUntilNextMonday0900Utc();
  setTimeout(() => {
    const suggestions = computePolicySuggestions();
    void postSuggestionsToSlack(suggestions);
    scheduleNext();
  }, delay).unref();
}

export function startPolicySuggesterCron(): void {
  // Run once shortly after startup (30s delay to let blunder store load)
  setTimeout(() => {
    const suggestions = computePolicySuggestions();
    if (suggestions.length > 0) {
      logger.info({ count: suggestions.length }, 'policy-suggester: startup scan complete');
    }
    scheduleNext();
  }, 30_000).unref();
}