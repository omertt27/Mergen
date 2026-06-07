/**
 * routes/heartbeats.ts — Heartbeat / cron-job monitoring endpoints.
 *
 * POST /heartbeat/:name?interval=86400&grace=300&description=...
 *   Record a ping. Creates the heartbeat if it doesn't exist.
 *   Returns the current heartbeat status.
 *
 * GET  /heartbeats
 *   List all heartbeats with status (ok / late / missing / never-pinged).
 *
 * GET  /heartbeat/:name
 *   Status of a single heartbeat.
 *
 * DELETE /heartbeat/:name
 *   Remove a heartbeat from monitoring.
 */

import { Router } from 'express';
import { ping, getReport, getAllReports, removeHeartbeat } from '../sensor/heartbeat-monitor.js';

export function createHeartbeatsRouter(): Router {
  const router = Router();

  // POST /heartbeat/:name — ping (primary endpoint, called from cron jobs)
  router.post('/heartbeat/:name', (req, res) => {
    const { name } = req.params as { name: string };
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) {
      res.status(400).json({ ok: false, error: 'name must be 1-80 alphanumeric, hyphen, or underscore characters' });
      return;
    }

    const intervalSeconds = Math.max(60, parseInt(String(req.query['interval'] ?? req.body?.interval ?? '86400'), 10) || 86_400);
    const graceSeconds    = req.query['grace'] !== undefined || req.body?.grace !== undefined
      ? Math.max(0, parseInt(String(req.query['grace'] ?? req.body?.grace ?? '0'), 10) || 0)
      : undefined;
    const description = typeof (req.query['description'] ?? req.body?.description) === 'string'
      ? String(req.query['description'] ?? req.body.description).slice(0, 200)
      : undefined;

    const config = ping(name, intervalSeconds, graceSeconds, description);
    const report = getReport(name)!;
    res.json({ ok: true, heartbeat: report, _hint: `curl -s http://localhost:3000/heartbeat/${config.name}` });
  });

  // GET /heartbeats — all heartbeats
  router.get('/heartbeats', (_req, res) => {
    const reports = getAllReports();
    const missing = reports.filter((r) => r.status === 'missing' || r.status === 'never-pinged').length;
    res.json({ ok: true, total: reports.length, missing, heartbeats: reports });
  });

  // GET /heartbeat/:name — single heartbeat status
  router.get('/heartbeat/:name', (req, res) => {
    const { name } = req.params as { name: string };
    const report = getReport(name);
    if (!report) {
      res.status(404).json({ ok: false, error: `no heartbeat named '${name}'` });
      return;
    }
    res.json({ ok: true, heartbeat: report });
  });

  // DELETE /heartbeat/:name — remove
  router.delete('/heartbeat/:name', (req, res) => {
    const { name } = req.params as { name: string };
    const removed = removeHeartbeat(name);
    if (!removed) {
      res.status(404).json({ ok: false, error: `no heartbeat named '${name}'` });
      return;
    }
    res.json({ ok: true, removed: name });
  });

  return router;
}
