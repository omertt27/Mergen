/**
 * routes/calibration.ts — Feedback & calibration endpoints.
 *
 * POST /feedback { pid, verdict, note? }   — record a user verdict
 * GET  /calibration                        — per-detector accuracy snapshot
 * GET  /calibration/export                 — full verdict ring as RFC-4180 CSV
 *
 * These are FREE endpoints — trust is binary: either users can verify our
 * claims or they should stop using us. No plan-gating here.
 */
import { Router } from 'express';
import { recordVerdict, getStats, exportCsv } from '../intelligence/calibration.js';

export function createCalibrationRouter(): Router {
  const router = Router();

  // POST /feedback ────────────────────────────────────────────────────────────
  // Tells the engine whether the hypothesis with the given pid was right.
  // After 5 verdicts a detector is "trusted"; below 50% it is demoted,
  // below 20% suppressed entirely.
  router.post('/feedback', (req, res) => {
    const { pid, verdict, note } = (req.body ?? {}) as { pid?: string; verdict?: string; note?: string };
    if (!pid || typeof pid !== 'string') {
      res.status(400).json({ ok: false, error: 'pid (string) is required' });
      return;
    }
    if (verdict !== 'correct' && verdict !== 'wrong' && verdict !== 'partial') {
      res.status(400).json({ ok: false, error: "verdict must be 'correct' | 'wrong' | 'partial'" });
      return;
    }
    const cleanNote = typeof note === 'string' && note.trim() ? note : undefined;
    const result = recordVerdict(pid, verdict, cleanNote);
    if (!result.found) {
      res.status(404).json({ ok: false, error: `unknown pid: ${pid}` });
      return;
    }
    if (!result.persisted) {
      // In-memory update succeeded but disk write failed. Verdict is live for
      // this process session but will be lost on restart. Surface as 207 so
      // callers can warn the user without treating it as a hard failure.
      res.status(207).json({ ok: true, warning: 'verdict recorded in memory but failed to persist to disk' });
      return;
    }
    res.json({ ok: true });
  });

  // GET /calibration ──────────────────────────────────────────────────────────
  router.get('/calibration', (_req, res) => {
    const stats = getStats();
    const trusted = stats.filter((s) => s.trusted);
    const totalVerdicts = trusted.reduce((sum, s) => sum + s.verdicts, 0);
    const overall = totalVerdicts > 0
      ? trusted.reduce((sum, s) => sum + s.accuracy * s.verdicts, 0) / totalVerdicts
      : null;
    res.json({
      ok: true,
      overallAccuracy: overall,
      trustedDetectors: trusted.length,
      totalDetectors: stats.length,
      perDetector: stats,
    });
  });

  // GET /calibration/export ───────────────────────────────────────────────────
  // Full verdict ring as RFC-4180 CSV. Privacy-safe by construction:
  // the ring only stores tag + confidence + verdict + ≤140-char note.
  router.get('/calibration/export', (_req, res) => {
    const csv = exportCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="mergen-calibration-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  });

  return router;
}
