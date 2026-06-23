/**
 * gate-analytics.ts — GET /gate-analytics
 *
 * Returns three feedback datasets from the policy gate:
 *   1. retrySuccessRate  — did the agent reformulate successfully after a block?
 *   2. policyCoverage    — unguarded tool calls + dead rules
 *   3. hitlPatterns      — approve/deny ratios + latency per rule
 */

import { Router } from 'express';
import { loadEnterprisePolicy } from '../intelligence/enterprise-policy-engine.js';
import {
  getRetryStats,
  getToolCallCounts,
  getUngardedCounts,
  getRuleFirings,
  getHitlStats,
} from '../intelligence/gate-analytics.js';

function retryAssessment(passRate: number): string {
  if (passRate >= 75) return 'guidance working — agent reformulates successfully';
  if (passRate >= 50) return 'guidance partially working — consider refining the suggested alternative';
  return 'guidance ineffective — agent cannot reformulate from this hint';
}

function hitlRecommendation(approvalRate: number, avgApprovalLatencyMs: number): string {
  if (approvalRate >= 90) return '90%+ approval rate — candidate for auto-approve after corpus validation';
  if (approvalRate <= 30) return '70%+ denial rate — consider converting to hard block';
  if (avgApprovalLatencyMs > 30 * 60 * 1_000) return 'avg approval latency >30 min — consider narrowing the hold condition';
  return 'calibrated — no action needed';
}

export function createGateAnalyticsRouter(): Router {
  const router = Router();

  router.get('/gate-analytics', (_req, res) => {
    const policy       = loadEnterprisePolicy();
    const retryStats   = getRetryStats();
    const toolCalls    = getToolCallCounts();
    const ungarded     = getUngardedCounts();
    const ruleFirings  = getRuleFirings();
    const hitlStats    = getHitlStats();

    // ── 1. Retry success rate ──────────────────────────────────────────────
    const retryByRule: Record<string, unknown> = {};
    for (const [ruleId, stats] of retryStats) {
      const resolved   = stats.retryPassed + stats.retryBlocked;
      const passRate   = resolved > 0 ? Math.round((stats.retryPassed / resolved) * 100) : null;
      retryByRule[ruleId] = {
        fired:        stats.fired,
        retryPassed:  stats.retryPassed,
        retryBlocked: stats.retryBlocked,
        retryPassRate: passRate,
        assessment:   passRate !== null ? retryAssessment(passRate) : 'no retries yet',
      };
    }

    // ── 2. Policy coverage ─────────────────────────────────────────────────
    let totalCalls   = 0;
    let coveredCalls = 0;
    for (const [toolName, count] of toolCalls) {
      totalCalls += count;
      const ungardedCount = ungarded.get(toolName) ?? 0;
      coveredCalls += count - ungardedCount;
    }

    const ungardedTools = [...ungarded.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([toolName, calls]) => ({ toolName, calls }));

    const allRuleIds = policy.rules.map((r) => r.id);
    const deadRules  = allRuleIds.filter((id) => !ruleFirings.has(id));

    const liveRuleFirings: Record<string, number> = {};
    for (const [ruleId, count] of ruleFirings) liveRuleFirings[ruleId] = count;

    // ── 3. HITL patterns ───────────────────────────────────────────────────
    const hitlByRule: Record<string, unknown> = {};
    for (const [ruleId, stats] of hitlStats) {
      const total        = stats.approvals + stats.denials;
      const approvalRate = total > 0 ? Math.round((stats.approvals / total) * 100) : null;
      const avgApprovalMs = stats.approvals > 0
        ? Math.round(stats.totalApprovalLatencyMs / stats.approvals)
        : null;
      const avgDenialMs = stats.denials > 0
        ? Math.round(stats.totalDenialLatencyMs / stats.denials)
        : null;
      hitlByRule[ruleId] = {
        approvals:            stats.approvals,
        denials:              stats.denials,
        approvalRate,
        avgApprovalLatencyMs: avgApprovalMs,
        avgDenialLatencyMs:   avgDenialMs,
        recommendation:       approvalRate !== null
          ? hitlRecommendation(approvalRate, avgApprovalMs ?? 0)
          : 'no decisions recorded yet',
      };
    }

    res.json({
      note: 'In-memory since last restart.',
      retrySuccessRate: {
        description: 'After a BLOCK, did the agent reformulate and pass on the next call? (60s attribution window)',
        byRule: retryByRule,
      },
      policyCoverage: {
        description: 'Tool calls with no matching policy rule (unguarded) and rules that have never fired (dead).',
        totalCalls,
        coveredCalls,
        coverageRate: totalCalls > 0 ? Math.round((coveredCalls / totalCalls) * 100) : null,
        ungardedTools,
        deadRules,
        liveRuleFirings,
      },
      hitlPatterns: {
        description: 'Approve/deny ratios and latency per rule. High approval rate → candidate for auto-approve. High denial rate → candidate for hard block.',
        byRule: hitlByRule,
      },
    });
  });

  return router;
}
