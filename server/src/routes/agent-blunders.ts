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
import { getBlunders, getBlunderStats, verifyChain } from '../sensor/agent-blunder-store.js';
import { getRefinementCandidates, getBypassStats } from '../sensor/bypass-tracker.js';
import { getGateCoverageSummary } from '../intelligence/enterprise-policy-engine.js';

export function createAgentBlundersRouter(): Router {
  const router = Router();

  router.get('/agent-blunders', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const stats = getBlunderStats();
    const recent = getBlunders().slice(-limit).reverse();
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
  router.get('/agent-blunders/verify', (_req, res) => {
    const result = verifyChain();
    res.json({ ok: true, ...result });
  });

  return router;
}
