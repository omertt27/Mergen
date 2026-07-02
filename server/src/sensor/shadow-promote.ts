/**
 * shadow-promote.ts — Progressive shadow-to-enforce promotion.
 *
 * Tracks per-rule shadow hit/miss statistics. When a rule has been in warn
 * (or has been firing in shadow mode without a single false-positive annotation
 * for 14 days), Mergen automatically stages it as a policy-proposal for
 * one-click promotion to block. It never auto-promotes directly — every
 * promotion requires a human to approve via the proposals endpoint.
 *
 * This closes the loop: shadow mode tells you what WOULD have been blocked.
 * Shadow promote turns that evidence into a structured promotion proposal so
 * the team doesn't have to manually audit shadow logs to tighten policies.
 *
 * Storage: ~/.mergen/shadow-rule-stats.json (bounded map, 1000 rules)
 *
 * Exposed via:
 *   GET  /policies/shadow-promote/stats   — per-rule summary
 *   POST /policies/shadow-promote/reset/:ruleId — reset stats for a rule
 *
 * Integration: recordShadowRuleHit() is called from enterprise-policy-engine.ts
 * whenever a rule fires with action=warn and a shadow entry is logged.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, zeroRetentionMode } from './paths.js';
import logger from './logger.js';
import { stageProposal } from '../intelligence/policy-proposals.js';
import { loadEnterprisePolicy } from '../intelligence/enterprise-policy-engine.js';

const SHADOW_RULE_STATS_FILE = path.join(DATA_DIR, 'shadow-rule-stats.json');
const MAX_STATS_ENTRIES = 1000;

/** Promotion threshold: 14 days of clean shadow hits with 0 false positives. */
const PROMOTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Minimum shadow hits before promotion can be considered. */
const MIN_HITS_FOR_PROMOTION = 5;

export interface ShadowRuleStats {
  ruleId:         string;
  ruleName:       string;
  /** Total times this rule fired in warn/shadow mode. */
  totalHits:      number;
  /** Human annotations where they said "this was a false positive". */
  falsePositives: number;
  /** Human annotations where they confirmed "this was correct". */
  confirmedHits:  number;
  /** First hit timestamp. */
  firstHitAt:     number;
  /** Most recent hit timestamp. */
  lastHitAt:      number;
  /** Whether a promotion proposal has already been staged. */
  proposalStaged: boolean;
  /** Timestamp of last staged proposal. */
  proposalStagedAt: number | null;
}

interface StatsFile { version: 1; stats: Record<string, ShadowRuleStats> }

let _stats: Record<string, ShadowRuleStats> = {};
let _loaded = false;

function _load(): void {
  if (_loaded) return;
  _loaded = true;
  if (!fs.existsSync(SHADOW_RULE_STATS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SHADOW_RULE_STATS_FILE, 'utf8')) as StatsFile;
    if (raw?.version === 1 && raw.stats) {
      _stats = raw.stats;
    }
  } catch (err) {
    logger.warn({ err }, 'shadow-promote: failed to load stats — starting fresh');
  }
}

function _persist(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const entries = Object.entries(_stats);
    if (entries.length > MAX_STATS_ENTRIES) {
      // Prune by oldest lastHitAt
      const sorted = entries.sort(([, a], [, b]) => b.lastHitAt - a.lastHitAt);
      _stats = Object.fromEntries(sorted.slice(0, MAX_STATS_ENTRIES));
    }
    const tmp = `${SHADOW_RULE_STATS_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, stats: _stats } satisfies StatsFile), 'utf8');
    fs.renameSync(tmp, SHADOW_RULE_STATS_FILE);
  } catch (err) {
    logger.warn({ err }, 'shadow-promote: persist failed');
  }
}

function _ensureRule(ruleId: string, ruleName: string): ShadowRuleStats {
  if (!_stats[ruleId]) {
    _stats[ruleId] = {
      ruleId,
      ruleName,
      totalHits:       0,
      falsePositives:  0,
      confirmedHits:   0,
      firstHitAt:      Date.now(),
      lastHitAt:       Date.now(),
      proposalStaged:  false,
      proposalStagedAt: null,
    };
  }
  return _stats[ruleId];
}

/**
 * Record a shadow/warn rule hit.
 * Called from enterprise-policy-engine.ts when a rule with action=warn fires.
 */
export function recordShadowRuleHit(ruleId: string, ruleName: string): void {
  _load();
  const stat = _ensureRule(ruleId, ruleName);
  stat.totalHits++;
  stat.lastHitAt = Date.now();
  _persist();
  _maybeStagePromosal(stat);
}

/**
 * Record a human feedback annotation on a shadow rule firing.
 * @param isFalsePositive true = human said "this shouldn't have fired"
 */
export function recordShadowRuleFeedback(
  ruleId: string,
  ruleName: string,
  isFalsePositive: boolean,
): void {
  _load();
  const stat = _ensureRule(ruleId, ruleName);
  if (isFalsePositive) {
    stat.falsePositives++;
    // Reset proposal status — false positive disqualifies pending proposal
    stat.proposalStaged = false;
    stat.proposalStagedAt = null;
  } else {
    stat.confirmedHits++;
  }
  _persist();
}

/** Reset stats for a specific rule (e.g., after it's been promoted or manually reviewed). */
export function resetShadowRuleStats(ruleId: string): void {
  _load();
  delete _stats[ruleId];
  _persist();
}

/** Get all shadow rule stats. */
export function getShadowRuleStats(): ShadowRuleStats[] {
  _load();
  return Object.values(_stats).sort((a, b) => b.totalHits - a.totalHits);
}

/**
 * Evaluate whether a rule qualifies for promotion and, if so, stage a proposal.
 * Qualification criteria:
 *   1. totalHits >= MIN_HITS_FOR_PROMOTION
 *   2. falsePositives === 0
 *   3. firstHitAt is at least PROMOTION_WINDOW_MS ago (14 days)
 *   4. No proposal already pending for this rule cycle
 */
function _maybeStagePromosal(stat: ShadowRuleStats): void {
  if (stat.proposalStaged) return;
  if (stat.totalHits < MIN_HITS_FOR_PROMOTION) return;
  if (stat.falsePositives > 0) return;
  if (Date.now() - stat.firstHitAt < PROMOTION_WINDOW_MS) return;

  // Check if the rule still exists and is currently in warn mode
  const policy = loadEnterprisePolicy();
  const rule = policy.rules.find((r) => r.id === stat.ruleId);
  if (!rule || rule.action !== 'warn') return;

  // Stage a HOLD-only proposal (action must be 'warn' per policy-proposals API).
  // The name makes the intent clear: "promote from warn to block pending approval".
  const proposalRule = {
    ...rule,
    action: 'warn' as const,
    name:   `[Shadow Promote] ${rule.name}`,
    reason: `Shadow promotion: rule "${rule.name}" has fired ${stat.totalHits} times ` +
            `over ${Math.round((Date.now() - stat.firstHitAt) / 86_400_000)} days ` +
            `with zero false positives. Approve to promote to block.`,
  };

  const ruleHash = `shadow_promote_${stat.ruleId}`;

  try {
    const proposal = stageProposal(ruleHash, proposalRule, stat.totalHits);
    if (proposal) {
      stat.proposalStaged  = true;
      stat.proposalStagedAt = Date.now();
      _persist();
      logger.info(
        { ruleId: stat.ruleId, hits: stat.totalHits },
        'shadow-promote: staged promotion proposal for rule',
      );
    }
  } catch (err) {
    logger.warn({ err, ruleId: stat.ruleId }, 'shadow-promote: failed to stage proposal');
  }
}
