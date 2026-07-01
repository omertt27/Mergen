/**
 * routes/agent-blunders.ts
 *
 *   GET /agent-blunders           summary + recent events + policy refinement candidates
 *   GET /agent-blunders?limit=N   change page size (max 100)
 *   GET /agent-blunders/verify    cryptographic hash-chain audit
 *
 * "Prevented" is the headline number: every time Mergen's safety layer
 * blocked an autonomous action that could have caused harm. YC partner Q:
 * "Why would you trust an AI agent with prod?" Answer: because it blocked
 * itself N times before you had to.
 *
 * "policyRefinementCandidates" are rules that triggered a block and were
 * immediately bypassed (same tool called again within 60s and passed) 5+
 * times — a signal the rule may be too aggressive for this team's workflow.
 *
 * /verify answers: "Has the log been tampered with?" An external auditor
 * calls this endpoint without trusting the server — the hash chain proves
 * integrity of every surviving entry.
 */

import { Router } from 'express';
import { getStores } from '../storage/store-registry.js';
import { getRefinementCandidates, getBypassStats } from '../sensor/bypass-tracker.js';
import { getGateCoverageSummary } from '../intelligence/enterprise-policy-engine.js';
import { buildReport, renderMarkdown } from '../intelligence/case-study-generator.js';

export function createAgentBlundersRouter(): Router {
  const router = Router();

  router.get('/agent-blunders', async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const store = getStores().blunders;
    const [stats, all] = await Promise.all([store.getStats(), store.list()]);
    const recent = all.slice(-limit).reverse();
    const policyRefinementCandidates = getRefinementCandidates();
    const bypassStats = getBypassStats();
    const gateCovers = getGateCoverageSummary();
    res.json({
      ok: true,
      prevented: stats.total,
      ...stats,
      gateCovers,
      recentBlunders: recent,
      bypassStats,
      policyRefinementCandidates,
    });
  });

  /**
   * GET /agent-blunders/verify
   *
   * Runs a cryptographic hash-chain verification over the blunder log.
   * Safe to call from an external audit script — no authentication required,
   * no state is mutated.
   *
   * Response fields:
   *   valid        — true if every surviving entry is cryptographically intact
   *   truncated    — true if the ring buffer has wrapped (pre-eviction entries
   *                  cannot be verified; this is expected, not a tamper signal)
   *   verified     — count of entries that passed verification
   *   verifiedFrom — id of the oldest entry included in the verified range
   *   firstInvalidIdx / reason — present only when valid: false
   */
  router.get('/agent-blunders/verify', async (_req, res) => {
    const result = await getStores().blunders.verifyChain();
    res.json({ ok: true, ...result });
  });

  /**
   * GET /agent-blunders/case-study-export
   *
   * Returns anonymized, narrative-enriched case studies derived from the
   * blunder log. Suitable for customer-facing documentation and sales material.
   *
   * Query params:
   *   format=json (default) — structured JSON with caseId, narrative, etc.
   *   format=md             — Markdown document ready to paste into docs/website
   *   limit=N               — cap the number of unique case studies returned (default: 20)
   *
   * Anonymization applied:
   *   - Service names replaced with opaque svc-{hash} identifiers
   *   - PIDs replaced with sequential case-001, case-002, ...
   *   - Timestamps converted to relative ("3 days ago")
   *   - Deep file paths truncated at depth 2
   *   - Commands containing credentials fully redacted
   *
   * Deduplication: repeated identical block patterns appear as a single case.
   */
  router.get('/agent-blunders/case-study-export', async (req, res) => {
    const format = req.query.format === 'md' ? 'md' : 'json';
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));

    const blunders = await getStores().blunders.list();
    const report   = buildReport(blunders);
    report.cases   = report.cases.slice(0, limit);

    if (format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="mergen-case-studies.md"');
      res.send(renderMarkdown(report));
      return;
    }

    res.json({ ok: true, ...report });
  });

  return router;
}
