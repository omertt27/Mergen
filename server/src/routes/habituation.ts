/**
 * routes/habituation.ts
 *
 *   GET /habituation              weekly engagement summary
 *   GET /habituation?weeks=N      custom look-back window (max 26)
 *
 * "Organic Habituation Rate" = engineers who received a Mergen PR comment
 * and then engaged (submitted a review on that PR) in the same week, without
 * being explicitly asked to.
 *
 * A rising habituationRate means engineers are treating Mergen as part of
 * their review workflow, not a one-off notification they dismiss.
 */

import { Router } from 'express';
import { getHabituationEvents, getWeeklyHabituation } from '../sensor/habituation-store.js';

export function createHabituationRouter(): Router {
  const router = Router();

  router.get('/habituation', (req, res) => {
    const windowWeeks = Math.min(26, Math.max(1, Number(req.query.weeks ?? 8)));
    const weekly = getWeeklyHabituation(windowWeeks);
    const all = getHabituationEvents();

    const withComments = new Set(
      all.filter((e) => e.eventType === 'comment_posted').map((e) => e.actor),
    ).size;
    const engaged = new Set(
      all.filter((e) => e.eventType !== 'comment_posted').map((e) => e.actor),
    ).size;

    res.json({
      ok: true,
      windowWeeks,
      totalPRsCommented:   all.filter((e) => e.eventType === 'comment_posted').length,
      uniqueEngineers:     new Set(all.map((e) => e.actor)).size,
      engineersWithComments: withComments,
      engagedEngineers:    engaged,
      habituationRate:     withComments > 0 ? engaged / withComments : null,
      weekly,
    });
  });

  return router;
}