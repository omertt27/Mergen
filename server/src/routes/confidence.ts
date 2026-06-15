/**
 * routes/confidence.ts — Confidence report endpoints.
 *
 *   POST /confidence-reports         file a pre-implementation confidence report
 *   GET  /confidence-reports         list recent reports (optional ?limit=)
 *   GET  /confidence-reports/:id     get one report
 */

import { Router } from 'express';
import { confidenceStore, ConfidenceReportSchema } from '../intelligence/confidence-report.js';

export function createConfidenceRouter(): Router {
  const router = Router();

  router.post('/confidence-reports', (req, res) => {
    const parsed = ConfidenceReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation failed', details: parsed.error.issues });
      return;
    }
    const report = confidenceStore.add(parsed.data);
    res.status(201).json({ ok: true, report });
  });

  router.get('/confidence-reports', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    res.json({ ok: true, reports: confidenceStore.list(limit) });
  });

  router.get('/confidence-reports/:id', (req, res) => {
    const report = confidenceStore.get(req.params.id);
    if (!report) { res.status(404).json({ error: 'report not found' }); return; }
    res.json({ ok: true, report });
  });

  return router;
}
