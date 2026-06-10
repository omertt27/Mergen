/**
 * routes/pr-shadow.ts — PR shadow mode stats API.
 *
 *   GET /pr-shadow/stats    aggregated stats + readiness signal
 *   GET /pr-shadow/results  raw shadow results (newest first)
 *
 * The stats endpoint is the decision surface: when readyForPRComments flips
 * to true, it is safe to set MERGEN_PR_COMMENTS=true.
 *
 * Readiness requires BOTH:
 *   - wouldHaveBeenUsefulRate ≥ 40% (at least 4 in 10 PRs have relevant context)
 *   - helpfulRate7d ≥ 80%           (explain_why retrieval is accurate)
 *
 * These two gates prevent different failure modes:
 *   - low wouldHaveBeenUsefulRate → Mergen would spam PRs with noise
 *   - low helpfulRate7d           → retrieval is inaccurate, comments will be wrong
 */

import { Router } from 'express';
import { getPRShadowStats, getPRShadowResults } from '../sensor/pr-shadow-store.js';
import { getUsageSnapshot } from '../intelligence/usage.js';

const USEFUL_RATE_THRESHOLD = 40;   // % of PRs where Mergen would have shown something
const HELPFUL_RATE_THRESHOLD = 80;  // % of explain_why responses rated helpful

export function createPRShadowRouter(): Router {
  const router = Router();

  router.get('/pr-shadow/stats', (_req, res) => {
    const stats = getPRShadowStats();
    const usage = getUsageSnapshot();

    const helpfulRate = usage.helpfulRate7d;
    const helpfulRateOk = helpfulRate !== null && helpfulRate >= HELPFUL_RATE_THRESHOLD;
    const usefulRateOk =
      stats.wouldHaveBeenUsefulRate !== null &&
      stats.wouldHaveBeenUsefulRate >= USEFUL_RATE_THRESHOLD;

    const readyForPRComments = helpfulRateOk && usefulRateOk;

    res.json({
      ok: true,
      shadowMode: true,
      prCommentsEnabled: process.env.MERGEN_PR_COMMENTS === 'true',
      readyForPRComments,
      readyConditions: {
        wouldHaveBeenUsefulRate: stats.wouldHaveBeenUsefulRate,
        wouldHaveBeenUsefulRateThreshold: USEFUL_RATE_THRESHOLD,
        wouldHaveBeenUsefulRateOk: usefulRateOk,
        helpfulRate7d: helpfulRate,
        helpfulRateThreshold: HELPFUL_RATE_THRESHOLD,
        helpfulRateOk,
      },
      ...stats,
      nextSteps: readyForPRComments
        ? [
            'Set MERGEN_PR_COMMENTS=true to enable Phase 2 PR comments.',
            'Start with high-confidence incident matches only.',
            'Monitor helpfulRate7d — disable if it drops below 70%.',
          ]
        : [
            usefulRateOk
              ? `✓ wouldHaveBeenUsefulRate is ${stats.wouldHaveBeenUsefulRate}% — above threshold.`
              : `wouldHaveBeenUsefulRate is ${stats.wouldHaveBeenUsefulRate ?? 'N/A'}% — needs ${USEFUL_RATE_THRESHOLD}%. Run mergen backfill github to populate the intent archive.`,
            helpfulRateOk
              ? `✓ helpfulRate7d is ${helpfulRate}% — above threshold.`
              : `helpfulRate7d is ${helpfulRate ?? 'N/A'}% — needs ${HELPFUL_RATE_THRESHOLD}%. Collect more explain_why feedback.`,
          ],
    });
  });

  router.get('/pr-shadow/results', (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    res.json({ ok: true, results: getPRShadowResults(limit) });
  });

  return router;
}
