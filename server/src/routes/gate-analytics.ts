/**
 * gate-analytics.ts — GET /gate-analytics
 *
 * Returns three feedback datasets from the policy gate:
 *   1. retrySuccessRate  — did the agent reformulate successfully after a block?
 *   2. policyCoverage    — unguarded tool calls + dead rules
 *   3. hitlPatterns      — approve/deny ratios + latency per rule
 *
 * Additional endpoints:
 *   GET /gate/stream     — live SSE stream of gate decisions (PASS/BLOCK/HOLD)
 *   GET /gate/heatmap    — blast-radius service heatmap: per-service call frequency
 *                          and average blast-radius score
 */

import type { Response } from 'express';
import { Router } from 'express';
import { loadEnterprisePolicy } from '../intelligence/enterprise-policy-engine.js';
import {
  getRetryStats,
  getToolCallCounts,
  getUnguardedCounts,
  getRuleFirings,
  getHitlStats,
  getReformulationRates,
  getHitlFatigueStatus,
  getGateEvents,
  subscribeGateStream,
} from '../intelligence/gate-analytics.js';
import { computeBlastRadius, mostSevereBlast } from '../intelligence/blast-radius.js';
import { computePolicySuggestions } from '../intelligence/policy-suggester.js';

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
    const ungarded     = getUnguardedCounts();
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

    // ── 4. Guided-alternative reformulation rates ──────────────────────────
    const reformRates = getReformulationRates();
    const reformByRule: Record<string, unknown> = {};
    for (const [ruleId, data] of reformRates) {
      reformByRule[ruleId] = {
        fired:         data.fired,
        reformulated:  data.reformulated,
        rate:          Math.round(data.rate * 100),
        assessment:    data.rate >= 0.75
          ? 'guided alternative is working — agent reformulates successfully'
          : data.rate >= 0.4
            ? 'partial success — consider refining the suggested alternative text'
            : 'guided alternative ineffective — agent cannot reformulate from this hint',
      };
    }

    // ── 5. HITL fatigue status ─────────────────────────────────────────────
    const fatigue = getHitlFatigueStatus();

    res.json({
      note: 'In-memory since last restart.',
      retrySuccessRate: {
        description: 'After a BLOCK, did the agent reformulate and pass on the next call? (60s attribution window)',
        byRule: retryByRule,
      },
      guidedAlternativeEffectiveness: {
        description: 'What fraction of blocked calls resulted in a successful reformulation? Measures whether the "what to do instead" hint is actionable.',
        byRule: reformByRule,
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
      hitlFatigue: {
        description: 'Approval fatigue detection — when too many HOLDs fire in a short window, engineers stop responding promptly.',
        ...fatigue,
      },
    });
  });

  // ── GET /gate/stream — live SSE stream of gate decisions ───────────────────
  // Emits one Server-Sent Event per gate decision (PASS/BLOCK/HOLD) as it
  // happens. Clients can use this to build real-time dashboards or dashboards
  // that show exactly what the agent is attempting in flight.
  //
  // Event format (text/event-stream):
  //   event: gate_decision
  //   data: {"ts":...,"toolName":"...","verdict":"block","triggeredRules":["..."]}
  //
  // Streams are automatically cleaned up when the client disconnects.
  router.get('/gate/stream', (req, res: Response) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    // Send recent events as initial burst so client has context immediately
    const recent = getGateEvents().slice(-20);
    for (const ev of recent) {
      res.write(`event: gate_decision\ndata: ${JSON.stringify(ev)}\n\n`);
    }
    res.write(`event: connected\ndata: {"note":"Streaming live gate decisions","recentSent":${recent.length}}\n\n`);

    // Keep-alive heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 30_000);

    const unsubscribe = subscribeGateStream((event) => {
      res.write(`event: gate_decision\ndata: ${JSON.stringify(event)}\n\n`);
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ── GET /gate/heatmap — blast-radius service heatmap ─────────────────────
  // Returns per-service tool-call frequency and average blast-radius score
  // from the gate event ring buffer. Surfaces over-privileged agents (agents
  // that touch many services with high blast-radius scores).
  //
  // Query params:
  //   windowMs=N  — restrict to the last N milliseconds (default: 1 hour)
  router.get('/gate/heatmap', (req, res) => {
    const windowMs = Math.max(60_000, Number(req.query.windowMs ?? 60 * 60 * 1_000));
    const cutoff   = Date.now() - windowMs;
    const events   = getGateEvents().filter((e) => e.ts >= cutoff);

    // Aggregate per service
    type ServiceRow = {
      service:          string;
      totalCalls:       number;
      blocked:          number;
      held:             number;
      passed:           number;
      avgBlastScore:    number;
      maxBlastScope:    string;
      topAgents:        string[];
      topTools:         string[];
    };
    const serviceMap = new Map<string, {
      calls: number; blocked: number; held: number; passed: number;
      blastScores: number[]; blastScopes: string[];
      agents: Map<string, number>; tools: Map<string, number>;
    }>();

    for (const ev of events) {
      const svc = ev.service ?? 'unknown';
      let row = serviceMap.get(svc);
      if (!row) {
        row = { calls: 0, blocked: 0, held: 0, passed: 0, blastScores: [], blastScopes: [], agents: new Map(), tools: new Map() };
        serviceMap.set(svc, row);
      }
      row.calls++;
      if (ev.verdict === 'block') row.blocked++;
      else if (ev.verdict === 'hold') row.held++;
      else row.passed++;

      if (ev.command) {
        const blast = computeBlastRadius(ev.command);
        const scopeScore: Record<string, number> = {
          'data-destructive': 100, 'cluster': 90, 'namespace': 70,
          'data-write': 60, 'deployment': 50, 'config-change': 40,
          'pod': 20, 'unknown': 10,
        };
        row.blastScores.push(scopeScore[blast.scope] ?? 10);
        row.blastScopes.push(blast.scope);
      }

      const agentKey = ev.agentId ?? ev.actor ?? 'unknown';
      row.agents.set(agentKey, (row.agents.get(agentKey) ?? 0) + 1);
      row.tools.set(ev.toolName, (row.tools.get(ev.toolName) ?? 0) + 1);
    }

    const heatmap: ServiceRow[] = [...serviceMap.entries()]
      .map(([service, row]) => ({
        service,
        totalCalls:    row.calls,
        blocked:       row.blocked,
        held:          row.held,
        passed:        row.passed,
        avgBlastScore: row.blastScores.length > 0
          ? Math.round(row.blastScores.reduce((a, b) => a + b, 0) / row.blastScores.length)
          : 0,
        maxBlastScope: row.blastScopes.reduce((max, s) => {
          const order = ['data-destructive','cluster','namespace','data-write','deployment','config-change','pod','unknown'];
          return order.indexOf(s) < order.indexOf(max) ? s : max;
        }, 'unknown'),
        topAgents: [...row.agents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a),
        topTools:  [...row.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t),
      }))
      .sort((a, b) => b.avgBlastScore - a.avgBlastScore);

    res.json({
      ok: true,
      windowMs,
      eventsAnalyzed: events.length,
      services:       heatmap,
      note: 'Services sorted by average blast-radius score. High score + high call frequency = over-privileged agent.',
    });
  });

  return router;
}
