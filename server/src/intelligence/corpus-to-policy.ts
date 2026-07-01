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
 *   commandSignatures      → conditions.commands — scopes the rule to the commands
 *                             that were actually overridden, never to the whole
 *                             service. A bucket with no extractable signature is
 *                             skipped rather than promoted unscoped.
 *
 * Rules are content-hash deduplicated — won't re-generate a rule already present
 * in the live policy. Results are staged (returned to caller), not auto-committed —
 * except when a human operator reviews (re-affirms) an override event via
 * POST /overrides/:id/review. That review is the human-in-the-loop signal: it
 * confirms the underlying pattern still reflects real policy, so
 * autoActivateReviewedRules() commits any corpus rule for that (tag, service)
 * directly into the live enterprise policy, without a separate POST /policies/rules
 * step. Rules synthesized for tags/services that haven't been reviewed still
 * require manual activation via POST /policies/rules or the /policies UI.
 */

import { createHash } from 'crypto';
import { compactCorpus, type CompactedRule, type OverrideReason } from './override-corpus.js';
import { loadEnterprisePolicy, saveEnterprisePolicy, type EnterprisePolicyRule } from './enterprise-policy-engine.js';
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

export function synthesizeRulesFromCorpus(scope?: { incidentTag: string; service: string }): SynthesizedRule[] {
  const compacted = compactCorpus().filter(
    (cr) => !scope || (cr.incidentTag === scope.incidentTag && cr.service === scope.service),
  );
  const results: SynthesizedRule[] = [];

  for (const cr of compacted) {
    if (cr.occurrences < MIN_OCCURRENCES) continue;

    // Every rule this pipeline promotes must be scoped to the commands that
    // were actually overridden — never to "all AI activity on this service".
    // Without commandSignatures, a reviewed override for one action would
    // silently block/hold every unrelated agent call against the service.
    if (cr.commandSignatures.length === 0) {
      logger.warn(
        { incidentTag: cr.incidentTag, service: cr.service },
        'corpus-to-policy: skipping synthesis — no command signatures could be extracted from this bucket',
      );
      continue;
    }

    const hash = _ruleHash(cr);
    if (_isAlreadyCovered(hash)) continue; // idempotent

    const action = _actionForReason(cr.overrideReason);
    const humanLabel = _humanReason(cr.overrideReason);

    // Build conditions
    const conditions: EnterprisePolicyRule['conditions'] = {
      commands: cr.commandSignatures,
    };

    // Deliberately NOT setting conditions.services here. The MCP tool-call gate
    // (tool-guard.ts — the primary consumer of this pipeline, per this module's
    // stated purpose of feeding "the tool-call firewall") always evaluates with
    // service='mcp', never the target infra service name. Every condition on a
    // rule is AND-ed (enterprise-policy-engine.ts evaluateEnterprisePolicy), so
    // a services condition set to cr.service (e.g. 'payments-api') would make
    // serviceMatched permanently false against every MCP call and silently
    // disable the whole rule for the surface it exists to protect. The CI/CD
    // gate (routes/ci-gate.ts) does pass a real service name and could use this
    // condition, but scoping for that surface isn't worth reintroducing a
    // rule that's inert on the MCP path. commandSignatures + time window
    // already carry the actionable scoping; the service is recorded in the
    // rule's name/description for operator context instead.
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
    const commandsDesc = cr.commandSignatures.map((s) => `"${s}"`).join(', ');

    const rule: EnterprisePolicyRule = {
      id:          `corpus_auto_${hash}`,
      name:        `[Auto] ${cr.service !== 'unknown' ? cr.service + ': ' : ''}${humanLabel}${timeDesc ? ' (' + timeDesc + ')' : ''}`,
      description: `Auto-synthesized from ${cr.occurrences} override events. Tag: ${cr.incidentTag}. Reason: ${humanLabel}. Scoped to commands: ${commandsDesc}.`,
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

// ── Auto-activation on human review ───────────────────────────────────────────

/** Appends a synthesized rule to the live enterprise policy. No-op if already present. */
function _activateRule(rule: EnterprisePolicyRule): void {
  const policy = loadEnterprisePolicy();
  if (policy.rules.some((r) => r.id === rule.id)) return;
  saveEnterprisePolicy({ ...policy, rules: [...policy.rules, rule] });
}

/**
 * Called after a human operator reviews (re-affirms) an override event via
 * POST /overrides/:id/review. A review is the human-in-the-loop confirmation
 * that the pattern still reflects real policy, so — for the (incidentTag, service)
 * pair the reviewed event belongs to — any corpus rule that has already cleared
 * MIN_OCCURRENCES is committed straight into the live enterprise policy (Gate A),
 * instead of waiting on a separate manual POST /policies/rules.
 *
 * This is what makes the runtime detector's corpus actually feed the tool-call
 * firewall, rather than only informing autopilot's own execute decision.
 */
export function autoActivateReviewedRules(incidentTag: string, service: string): SynthesizedRule[] {
  const staged = synthesizeRulesFromCorpus({ incidentTag, service });
  for (const { rule } of staged) {
    _activateRule(rule);
    logger.info(
      { ruleId: rule.id, incidentTag, service },
      'corpus-to-policy: auto-activated rule into live policy after operator review',
    );
  }
  return staged;
}
