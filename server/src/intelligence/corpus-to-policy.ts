/**
 * corpus-to-policy.ts — Synthesize EnterprisePolicyRules from the override corpus.
 *
 * Closes the learning loop:
 *   human overrides → compactCorpus() → synthesized rule → staged for HITL review
 *
 * For each CompactedRule with ≥3 occurrences, maps:
 *   overrideReason → rule action  (batch-window/maintenance → time-windowed block;
 *                                   compliance-hold → service-scoped block;
 *                                   wrong-fix/wrong-diagnosis → warn/HOLD)
 *   dayOfWeek + hourWindow → conditions.daysOfWeek + conditions.hourWindow
 *
 * Rules are content-hash deduplicated — won't re-generate a rule already present
 * in the live policy. Results are staged (returned to caller), not auto-committed,
 * so operators must activate them via POST /policies/rules or the /policies UI.
 */

import { createHash } from 'crypto';
import { compactCorpus, type CompactedRule, type OverrideReason } from './override-corpus.js';
import { loadEnterprisePolicy, type EnterprisePolicyRule } from './enterprise-policy-engine.js';
import logger from '../sensor/logger.js';

const MIN_OCCURRENCES = 3;

// ── Reason → action mapping ───────────────────────────────────────────────────

type RuleAction = 'block' | 'warn';

function _actionForReason(reason: OverrideReason): RuleAction {
  switch (reason) {
    case 'batch-window':
    case 'maintenance-window':
    case 'compliance-hold':
      return 'block';
    case 'wrong-fix':
    case 'wrong-diagnosis':
    case 'cost-constraint':
    case 'on-call-discretion':
    case 'prefer-read-replica':
    case 'other':
      return 'warn';
  }
}

function _humanReason(reason: OverrideReason): string {
  const labels: Record<OverrideReason, string> = {
    'batch-window':        'batch settlement window',
    'maintenance-window':  'maintenance window',
    'compliance-hold':     'compliance hold',
    'wrong-fix':           'incorrect fix applied previously',
    'wrong-diagnosis':     'incorrect root cause diagnosis',
    'cost-constraint':     'cost ceiling constraint',
    'on-call-discretion':  'on-call discretion override',
    'prefer-read-replica': 'read-replica preferred',
    'other':               'team override',
  };
  return labels[reason] ?? reason;
}

// ── Content hash for deduplication ───────────────────────────────────────────

function _ruleHash(rule: CompactedRule): string {
  const key = JSON.stringify({
    tag:    rule.incidentTag,
    svc:    rule.service,
    reason: rule.overrideReason,
    day:    rule.dayOfWeek,
    hour:   rule.hourWindow,
  });
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function _isAlreadyCovered(hash: string): boolean {
  const policy = loadEnterprisePolicy();
  return policy.rules.some((r) => r.id === `corpus_auto_${hash}`);
}

// ── Core synthesis ────────────────────────────────────────────────────────────

export interface SynthesizedRule {
  rule: EnterprisePolicyRule;
  sourceOccurrences: number;
  compactedRule: CompactedRule;
}

export function synthesizeRulesFromCorpus(): SynthesizedRule[] {
  const compacted = compactCorpus();
  const results: SynthesizedRule[] = [];

  for (const cr of compacted) {
    if (cr.occurrences < MIN_OCCURRENCES) continue;

    const hash = _ruleHash(cr);
    if (_isAlreadyCovered(hash)) continue; // idempotent

    const action = _actionForReason(cr.overrideReason);
    const humanLabel = _humanReason(cr.overrideReason);

    // Build conditions
    const conditions: EnterprisePolicyRule['conditions'] = {};

    if (cr.service && cr.service !== 'unknown') {
      conditions.services = [cr.service];
    }
    if (cr.dayOfWeek !== null) {
      conditions.daysOfWeek = [cr.dayOfWeek];
    }
    if (cr.hourWindow !== null) {
      conditions.hourWindow = cr.hourWindow;
    }
    // All corpus rules target AI actors — these are agent action overrides
    conditions.actorType = 'ai';

    const dayLabel = cr.dayOfWeek !== null
      ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][cr.dayOfWeek]
      : null;
    const hourLabel = cr.hourWindow
      ? `${String(cr.hourWindow[0]).padStart(2,'0')}:00–${String(cr.hourWindow[1]).padStart(2,'0')}:00 UTC`
      : null;

    const timeDesc = [dayLabel, hourLabel].filter(Boolean).join(' ');

    const rule: EnterprisePolicyRule = {
      id:          `corpus_auto_${hash}`,
      name:        `[Auto] ${cr.service !== 'unknown' ? cr.service + ': ' : ''}${humanLabel}${timeDesc ? ' (' + timeDesc + ')' : ''}`,
      description: `Auto-synthesized from ${cr.occurrences} override events. Tag: ${cr.incidentTag}. Reason: ${humanLabel}.`,
      action,
      reason:      `Corpus-derived policy: this action was overridden ${cr.occurrences} time(s) due to ${humanLabel}${timeDesc ? ' during ' + timeDesc : ''}.`,
      conditions,
    };

    results.push({ rule, sourceOccurrences: cr.occurrences, compactedRule: cr });
    logger.info(
      { ruleId: rule.id, occurrences: cr.occurrences, action },
      'corpus-to-policy: synthesized new policy rule from override corpus',
    );
  }

  return results;
}
