/**
 * routes/calibration.ts — Feedback & calibration endpoints.
 *
 * POST /feedback { pid, verdict, note?, verdictDimension? }
 *   — record a user verdict; optionally qualify which component was judged
 * GET  /calibration
 *   — per-detector accuracy snapshot with pending-feedback list and config
 * GET  /calibration/export
 *   — full verdict ring as RFC-4180 CSV with SHA-256 integrity comment
 *
 * These are FREE endpoints — trust is binary: either users can verify our
 * claims or they should stop using us. No plan-gating here.
 */
import { Router } from 'express';
import {
  recordVerdict,
  getStats,
  getRecords,
  exportCsv,
  getPendingFeedback,
  getGlobalStats,
  CALIBRATION_CONFIG,
  type VerdictDimension,
} from '../intelligence/calibration.js';
import { getClusters } from '../intelligence/unclassified-clusters.js';
import { getSessionMetrics } from '../intelligence/session-metrics.js';

const VALID_VERDICT_DIMENSIONS = new Set<VerdictDimension>(['root_cause', 'fix_hint', 'both']);

export function createCalibrationRouter(): Router {
  const router = Router();

  // POST /feedback ────────────────────────────────────────────────────────────
  // Tells the engine whether the hypothesis with the given pid was right.
  // After 5 verdicts a detector is "trusted"; below 50% it is demoted,
  // below 20% suppressed entirely.
  router.post('/feedback', (req, res) => {
    const { pid, verdict, note, verdictDimension } = (req.body ?? {}) as {
      pid?: string;
      verdict?: string;
      note?: string;
      verdictDimension?: string;
    };
    if (!pid || typeof pid !== 'string') {
      res.status(400).json({ ok: false, error: 'pid (string) is required' });
      return;
    }
    if (verdict !== 'correct' && verdict !== 'wrong' && verdict !== 'partial') {
      res.status(400).json({ ok: false, error: "verdict must be 'correct' | 'wrong' | 'partial'" });
      return;
    }
    if (verdictDimension !== undefined && !VALID_VERDICT_DIMENSIONS.has(verdictDimension as VerdictDimension)) {
      res.status(400).json({
        ok: false,
        error: "verdictDimension must be 'root_cause' | 'fix_hint' | 'both'",
      });
      return;
    }
    const cleanNote = typeof note === 'string' && note.trim() ? note : undefined;
    const cleanDim = verdictDimension as VerdictDimension | undefined;
    const result = recordVerdict(pid, verdict, cleanNote, cleanDim);
    if (!result.found) {
      res.status(404).json({ ok: false, error: `unknown pid: ${pid}` });
      return;
    }
    if (!result.persisted) {
      // In-memory update succeeded but disk write failed. Verdict is live for
      // this process session but will be lost on restart. Surface as 207 so
      // callers can warn the user without treating it as a hard failure.
      res.status(207).json({
        ok: true,
        warning: 'verdict recorded in memory but failed to persist to disk',
        retryable: true,
        retryAfterMs: 5000,
      });
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
    const anyInterruptsAllowed = stats.some((s) => s.shouldInterrupt);
    res.json({
      ok: true,
      overallAccuracy: overall,
      trustedDetectors: trusted.length,
      totalDetectors: stats.length,
      anyInterruptsAllowed,
      pendingFeedback: getPendingFeedback(),
      config: CALIBRATION_CONFIG,
      perDetector: stats,
    });
  });

  // GET /calibration/export ───────────────────────────────────────────────────
  // Full verdict ring as RFC-4180 CSV. Privacy-safe by construction:
  // the ring only stores tag + confidence + verdict + ≤140-char note.
  // The first line is an integrity comment (# rows: N, sha256: <hash>).
  router.get('/calibration/export', (_req, res) => {
    const csv = exportCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="mergen-calibration-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  });

  // GET /calibration/unclassified ─────────────────────────────────────────────
  // Error patterns that fired zero detectors, grouped by structural fingerprint.
  // Clusters with count >= minCount are candidates for new detector rules.
  router.get('/calibration/unclassified', (req, res) => {
    const minCount = Math.max(1, parseInt(String(req.query['minCount'] ?? '3'), 10) || 3);
    const clusters = getClusters(minCount);
    res.json({
      ok: true,
      total: clusters.length,
      minCount,
      clusters,
    });
  });

  // GET /calibration/global ───────────────────────────────────────────────────
  // Global accuracy stats from the aggregation server (requires opt-in telemetry
  // and MERGEN_TELEMETRY_URL to be configured). Returns empty array when no
  // global data has been fetched yet.
  router.get('/calibration/global', (_req, res) => {
    res.json({
      ok: true,
      stats: getGlobalStats(),
    });
  });

  // GET /calibration/corpus-progress ─────────────────────────────────────────
  // Progress toward the 20 HIGH-confidence verdict gate.
  // A validated HIGH-confidence verdict = confidence=HIGH + verdict correct/partial.
  // Partners use this number to know when the accuracy corpus is ready to publish.
  router.get('/calibration/corpus-progress', (_req, res) => {
    const TARGET = 20;
    const records = getRecords();
    const highCorrect = records.filter(
      (r) => r.confidence === 'HIGH' && (r.verdict === 'correct' || r.verdict === 'partial'),
    ).length;
    const stats = getStats();
    res.json({
      ok: true,
      highConfidentCorrect: highCorrect,
      target: TARGET,
      targetReached: highCorrect >= TARGET,
      pct: Math.min(100, Math.round((highCorrect / TARGET) * 100)),
      trustedDetectors: stats.filter((s) => s.trusted).length,
      totalVerdicts: records.filter((r) => r.verdict).length,
    });
  });

  // GET /session-metrics ──────────────────────────────────────────────────────
  // First-attempt fix success rate — the board-slide metric.
  router.get('/session-metrics', (_req, res) => {
    res.json({ ok: true, ...getSessionMetrics() });
  });

  return router;
}
