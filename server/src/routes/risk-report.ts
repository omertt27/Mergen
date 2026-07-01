/**
 * routes/risk-report.ts — CISO-grade security risk report.
 *
 *   GET /risk-report            JSON summary
 *   GET /risk-report?format=md  Markdown document (shareable, printable)
 *
 * Every blocked action in the Blunder Log becomes board-deck evidence.
 * The developer hands this to their CISO; the report does the security
 * sales pitch without a meeting.
 *
 * Data sources:
 *   - Agent Blunder Log (blocked actions, types, trends)
 *   - Override corpus (enforcement policy entries)
 *   - Enterprise policy (active rules)
 */

import { Router } from 'express';
import { getStores } from '../storage/store-registry.js';
import { loadEnterprisePolicy } from '../intelligence/enterprise-policy-engine.js';

export function createRiskReportRouter(): Router {
  const router = Router();

  router.get('/risk-report', async (req, res) => {
    const format = req.query.format as string | undefined;
    const data = await computeRiskData(req.tenantId);

    if (format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="mergen-risk-report.md"');
      res.send(buildMarkdown(data));
      return;
    }

    res.json({ ok: true, report: data });
  });

  return router;
}

// ── Data ──────────────────────────────────────────────────────────────────────

interface BlunderBreakdown {
  type: string;
  count: number;
  description: string;
}

interface RiskReportData {
  generatedAt: string;
  windowDays: number;
  totalBlocked: number;
  last7Days: number;
  last30Days: number;
  breakdown: BlunderBreakdown[];
  topBlockedCommands: Array<{ command: string; count: number }>;
  activeRules: number;
  overrideCorpusSize: number;
  riskScore: 'low' | 'medium' | 'high';
  riskRationale: string;
}

const TYPE_DESCRIPTIONS: Record<string, string> = {
  allowlist_block:       'Command not on the approved allowlist',
  injection_attempt:     'Prompt injection detected in command payload',
  rbac_block:            'Actor missing required role for this action',
  override_corpus_block: 'Action previously overridden by a human decision',
  pipeline_block:        'Governance pipeline blocked the action',
  planning_gate_block:   'Planning gate: confidence or blast-radius check failed',
};

async function computeRiskData(tenantId?: string): Promise<RiskReportData> {
  const [stats, blunders] = await Promise.all([
    getStores().blunders.getStats(tenantId),
    getStores().blunders.list(tenantId),
  ]);
  const overrides = await getStores().overrides.getOverrideSummary(tenantId);
  const policy  = loadEnterprisePolicy();

  const breakdown: BlunderBreakdown[] = Object.entries(stats.byType).map(([type, count]) => ({
    type,
    count,
    description: TYPE_DESCRIPTIONS[type] ?? type,
  })).sort((a, b) => b.count - a.count);

  // Tally top blocked commands (non-null, deduplicated)
  const cmdCounts = new Map<string, number>();
  for (const b of blunders) {
    if (b.command) {
      const key = b.command.trim().slice(0, 80);
      cmdCounts.set(key, (cmdCounts.get(key) ?? 0) + 1);
    }
  }
  const topBlockedCommands = [...cmdCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([command, count]) => ({ command, count }));

  // Simple risk score: low=0-5 blocks/week, medium=6-20, high=21+
  let riskScore: 'low' | 'medium' | 'high';
  let riskRationale: string;
  if (stats.last7Days <= 5) {
    riskScore = 'low';
    riskRationale = `${stats.last7Days} blocked actions in the past 7 days — agent activity is within safe bounds.`;
  } else if (stats.last7Days <= 20) {
    riskScore = 'medium';
    riskRationale = `${stats.last7Days} blocked actions in the past 7 days — elevated agent activity. Review breakdown for patterns.`;
  } else {
    riskScore = 'high';
    riskRationale = `${stats.last7Days} blocked actions in the past 7 days — significant autonomous activity intercepted. Audit recommended.`;
  }

  return {
    generatedAt:        new Date().toISOString(),
    windowDays:         30,
    totalBlocked:       stats.total,
    last7Days:          stats.last7Days,
    last30Days:         stats.last30Days,
    breakdown,
    topBlockedCommands,
    activeRules:        policy.enabled ? policy.rules.filter((r) => r.action === 'block').length : 0,
    overrideCorpusSize: overrides.length,
    riskScore,
    riskRationale,
  };
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function buildMarkdown(d: RiskReportData): string {
  const riskBadge = { low: '🟢 LOW', medium: '🟡 MEDIUM', high: '🔴 HIGH' }[d.riskScore];

  const breakdownTable = d.breakdown.length > 0
    ? [
        '| Type | Count | Description |',
        '|------|------:|-------------|',
        ...d.breakdown.map((r) => `| \`${r.type}\` | ${r.count} | ${r.description} |`),
      ].join('\n')
    : '_No blocked actions recorded yet._';

  const topCmdsSection = d.topBlockedCommands.length > 0
    ? [
        '| Command | Times Blocked |',
        '|---------|-------------:|',
        ...d.topBlockedCommands.map((c) => `| \`${c.command}\` | ${c.count} |`),
      ].join('\n')
    : '_No commands blocked yet._';

  return `# Mergen — AI Agent Security Risk Report

**Generated:** ${d.generatedAt}
**Risk Level:** ${riskBadge}

---

## Executive Summary

> ${d.riskRationale}

Mergen is the inline Execution and Security Gateway running on your engineering
infrastructure. Every time an AI agent attempted a potentially harmful action,
Mergen intercepted it **before the handler executed** — in under 1ms, with no
LLM in the critical path.

---

## Blocked Actions

| Metric | Value |
|--------|------:|
| Total intercepted (all time) | **${d.totalBlocked}** |
| Intercepted — last 7 days | **${d.last7Days}** |
| Intercepted — last 30 days | **${d.last30Days}** |
| Active block rules | **${d.activeRules}** |
| Override corpus entries | **${d.overrideCorpusSize}** |

### Breakdown by Type

${breakdownTable}

### Top Blocked Commands

${topCmdsSection}

---

## Enforcement Architecture

Mergen applies three enforcement layers before any autonomous tool call executes:

1. **Hard Safety Policies** — Immutable JSON rules evaluated in <1ms. No LLM.
   No amount of agent persuasion bypasses them.
2. **Override Corpus** — Every human override is encoded as binding enforcement
   policy. ${d.overrideCorpusSize} entries active.
3. **Confidence Gate** — Autonomous execution only proceeds above a
   Platt-calibrated threshold set by your team.

---

## Audit Trail

The Agent Blunder Log is **hash-chained and tamper-evident**. Every blocked
action is recorded with a SHA-256 hash of its content plus the previous
entry's hash. An external auditor can verify integrity at any time:

\`\`\`
GET /agent-blunders/verify
\`\`\`

---

## Next Steps

- Review the breakdown table for repeat offenders
- Run \`mergen-server test-safety\` to verify the gate is holding against known bypass patterns
- Share this report with your security team — data is sourced from your local
  infrastructure only; nothing leaves your environment

---

_Mergen — Agent Execution Governance. All data stays on your infrastructure._
`;
}
