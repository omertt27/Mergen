import { Router } from 'express';
import { getRecentActivity, subscribeToActivity } from '../intelligence/activity-feed.js';

export function createActivityFeedRouter(): Router {
  const router = Router();

  router.get('/activity-feed', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({ ok: true, events: getRecentActivity(limit) });
  });

  router.get('/activity-feed/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const unsubscribe = subscribeToActivity(res as unknown as import('http').ServerResponse);
    req.on('close', unsubscribe);
  });

  return router;
}
