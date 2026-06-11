/**
 * routes/agent-blunders.ts
 *
 *   GET /agent-blunders           summary + recent events
 *   GET /agent-blunders?limit=N   change page size (max 100)
 *
 * "Prevented" is the headline number: every time Mergen's safety layer
 * blocked an autonomous action that could have caused harm. YC partner Q:
 * "Why would you trust an AI agent with prod?" Answer: because it blocked
 * itself N times before you had to.
 */

import { Router } from 'express';
import { getBlunders, getBlunderStats } from '../sensor/agent-blunder-store.js';

export function createAgentBlundersRouter(): Router {
  const router = Router();

  router.get('/agent-blunders', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const stats = getBlunderStats();
    const recent = getBlunders().slice(-limit).reverse();
    res.json({
      ok: true,
      prevented: stats.total,
      ...stats,
      recentBlunders: recent,
    });
  });

  return router;
}
