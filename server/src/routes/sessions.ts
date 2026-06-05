/**
 * routes/sessions.ts — Session history endpoints.
 *
 * GET /sessions/history/list          → metadata for all saved sessions (newest first)
 * GET /sessions/history?since=&until= → events from sessions in that time range
 * GET /audit?limit=<n>                → recent audit log entries
 */

import { Router } from 'express';
import { listSessionMetas, loadSessionsByTimeRange } from '../sensor/session-history.js';
import { getAuditLog } from '../sensor/audit-log.js';

export function createSessionsRouter(): Router {
  const router = Router();

  router.get('/sessions/history/list', (_req, res) => {
    res.json({ sessions: listSessionMetas() });
  });

  router.get('/sessions/history', (req, res) => {
    const since  = parseInt(req.query.since  as string, 10) || 0;
    const until  = parseInt(req.query.until  as string, 10) || Date.now();
    const limit  = Math.min(parseInt(req.query.limit as string, 10) || 200, 2000);
    const events = loadSessionsByTimeRange(since, until).slice(0, limit);
    res.json({ events, count: events.length, since, until });
  });

  router.get('/audit', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 1000);
    res.json({ entries: getAuditLog(limit) });
  });

  return router;
}
