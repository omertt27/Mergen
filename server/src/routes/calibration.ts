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
  getStatsForTag,
  getRecords,
  exportCsv,
  getPendingFeedback,
  getGlobalStats,
  isCorpusSeeded,
  getRealVerdictCount,
  CALIBRATION_CONFIG,
  type VerdictDimension,
} from '../intelligence/calibration.js';
import { getClusters } from '../intelligence/unclassified-clusters.js';
import { getSessionMetrics } from '../intelligence/session-metrics.js';
import { computeRocCurve, getExecutionThreshold } from '../intelligence/threshold-optimizer.js';
import { computeBlastRadius } from '../intelligence/blast-radius.js';
import { plattScale, getPlattDiagnostics } from '../intelligence/platt-scaling.js';
import { getStores } from '../storage/store-registry.js';

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
    const corpusSeeded = isCorpusSeeded();
    const realVerdictCount = getRealVerdictCount();
    res.json({
      ok: true,
      overallAccuracy: overall,
      trustedDetectors: trusted.length,
      totalDetectors: stats.length,
      anyInterruptsAllowed,
      corpusSeeded,
      realVerdictCount,
      warmUpComplete: realVerdictCount >= 10,
      pendingFeedback: getPendingFeedback(),
      config: CALIBRATION_CONFIG,
      perDetector: stats,
    });
  });

  // GET /calibration/precision ────────────────────────────────────────────────
  // Empirical per-detector precision metrics for FAANG-style trust evaluation.
  // Precision = P(correct | verdict given). Recall is not measurable without
  // ground-truth negatives (we only see incidents that Mergen detected).
  router.get('/calibration/precision', (_req, res) => {
    const stats = getStats();

    const totalPredictions = stats.reduce((s, d) => s + d.predictions, 0);
    const totalVerdicts    = stats.reduce((s, d) => s + d.verdicts, 0);
    const coverageRate     = totalPredictions > 0
      ? Math.round((totalVerdicts / totalPredictions) * 100) / 100
      : 0;

    const trusted = stats.filter((d) => d.trusted);
    const trustedVerdicts = trusted.reduce((s, d) => s + d.verdicts, 0);
    const globalAccuracy = trustedVerdicts > 0
      ? Math.round((trusted.reduce((s, d) => s + d.accuracy * d.verdicts, 0) / trustedVerdicts) * 1000) / 1000
      : null;

    const detectors = stats.map((d) => ({
      tag:                  d.tag,
      predictions:          d.predictions,
      verdicts:             d.verdicts,
      precision:            typeof d.accuracy === 'number' ? Math.round(d.accuracy * 1000) / 1000 : null,
      diagnosisPrecision:   typeof d.diagnosisAccuracy === 'number' ? Math.round(d.diagnosisAccuracy * 1000) / 1000 : null,
      remediationPrecision: typeof d.remediationAccuracy === 'number' ? Math.round(d.remediationAccuracy * 1000) / 1000 : null,
      trusted:              d.trusted,
      trend:                d.trendDelta !== null
        ? `${d.trendDelta >= 0 ? '+' : ''}${(d.trendDelta * 100).toFixed(1)}%`
        : null,
      topFailureModes:      d.commonFailureModes.map((f) => f.note),
    }));

    res.json({
      ok: true,
      generated:     new Date().toISOString(),
      note:          'Precision = P(correct | verdict given). Recall not measurable without ground-truth negatives.',
      totalPredictions,
      totalVerdicts,
      coverageRate,
      globalAccuracy,
      detectors,
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

  // GET /calibration/threshold ────────────────────────────────────────────────
  // ROC curve + data-derived execution threshold.
  // The threshold is Youden's-J optimal over the calibration corpus.
  // Falls back to 0.85 when fewer than 20 verdicts exist.
  router.get('/calibration/threshold', (_req, res) => {
    const records = getRecords();
    const verdicted = records.filter((r) => r.verdict !== undefined);
    const withNumeric = verdicted.filter((r) => (r as typeof r & { numericScore?: number }).numericScore !== undefined);
    const rocCurve = computeRocCurve();
    const recommended = getExecutionThreshold();
    res.json({
      ok: true,
      generated: new Date().toISOString(),
      note: 'Threshold maximizes Youden\'s J (TPR - FPR). Min 20 verdicts required; uses 0.85 fallback until then.',
      currentThreshold: 0.85,
      recommendedThreshold: recommended,
      usingFallback: rocCurve.length === 0,
      sampleSize: verdicted.length,
      sampleSizeWithNumericScore: withNumeric.length,
      rocCurve,
    });
  });

  // GET /blast-radius ─────────────────────────────────────────────────────────
  // Compute the blast radius of a command without executing it.
  // Query params: command (required), service?, namespace?, environment?
  router.get('/blast-radius', (req, res) => {
    const command = typeof req.query.command === 'string' ? req.query.command.trim() : '';
    if (!command) {
      res.status(400).json({ ok: false, error: 'command query param is required' });
      return;
    }
    const service     = typeof req.query.service     === 'string' ? req.query.service     : undefined;
    const namespace   = typeof req.query.namespace   === 'string' ? req.query.namespace   : undefined;
    const environment = typeof req.query.environment === 'string' ? req.query.environment : undefined;
    const br = computeBlastRadius(command, { service, namespace, environment });
    res.json({ ok: true, ...br });
  });

  // GET /trust-score/:pid ───────────────────────────────────────────────────
  // Per-incident trust score: looks up the incident by hypothesis pid, applies
  // Platt scaling using its tag and raw confidence, and returns the full
  // calibration picture including verdict history and tag-level accuracy.
  // This is the endpoint VPs of Eng use during PoCs to verify our confidence claims.
  router.get('/trust-score/:pid', async (req, res) => {
    const { pid } = req.params;
    const inc = await getStores().incidents.get(pid, req.tenantId);
    if (!inc) {
      res.status(404).json({ error: 'incident not found', pid });
      return;
    }

    // Reading the trust-score brief counts as the engineer consulting Mergen's diagnosis
    await getStores().incidents.markContextViewed(pid, req.tenantId);

    const rawScore = inc.confidence;
    const tag      = inc.tag;
    const result   = plattScale(rawScore, tag);
    const pct      = Math.round(result.calibrated * 100);

    // All prediction records for this pid — verdict history
    const records = getRecords().filter((r: Record<string, unknown>) => r['pid'] === pid);
    const verdictHistory = records.map((r: Record<string, unknown>) => ({
      verdict:     r['verdict']          ?? null,
      note:        r['note']             ?? null,
      recordedAt:  r['recordedAt']       ?? null,
      dimension:   r['verdictDimension'] ?? null,
    }));

    // Tag-level accuracy stats
    const tagStats = getStatsForTag(tag) as { accuracy?: number; n?: number } | null;

    const interpretation =
      pct >= 85 ? 'high — strong historical basis for automated action'  :
      pct >= 65 ? 'medium — recommend human review before execution'     :
      pct >= 40 ? 'low — diagnosis is a signal, not a conclusion'        :
                  'insufficient — surface as context only';

    res.json({
      ok:                    true,
      pid,
      service:               inc.service      ?? null,
      tag,
      rawScore,
      calibrated:            result.calibrated,
      calibratedPct:         pct,
      calibrationSource:     result.source,
      calibrationSampleSize: result.n,
      verdictHistory,
      tagAccuracy:       tagStats?.accuracy   ?? null,
      tagSampleSize:     tagStats?.n          ?? null,
      interpretation,
      resolvedAutonomously: inc.resolvedAutonomously,
      causallyCorrect:      inc.causallyCorrect,
    });
  });

  // GET /trust-score?tag=&rawScore= ─────────────────────────────────────────
  // Returns the Platt-calibrated probability for a (tag, rawScore) pair.
  // "If Mergen says 85%, this endpoint proves it means 85 out of 100 were correct."
  // This is the endpoint enterprise security/infra teams check during PoCs.
  router.get('/trust-score', (req, res) => {
    const tag      = typeof req.query.tag      === 'string' ? req.query.tag      : undefined;
    const rawScore = parseFloat(String(req.query.rawScore ?? req.query.score ?? ''));

    if (isNaN(rawScore) || rawScore < 0 || rawScore > 1) {
      res.status(400).json({ error: 'rawScore must be a number between 0 and 1' });
      return;
    }

    const result = plattScale(rawScore, tag);
    const pct    = Math.round(result.calibrated * 100);

    // Interpretation bands — used in Slack messages and PR comments
    const interpretation =
      pct >= 85 ? 'high — strong historical basis for automated action'  :
      pct >= 65 ? 'medium — recommend human review before execution'     :
      pct >= 40 ? 'low — diagnosis is a signal, not a conclusion'        :
                  'insufficient — surface as context only';

    res.json({
      ok:           true,
      rawScore,
      tag:          tag ?? null,
      calibrated:   result.calibrated,
      calibratedPct: pct,
      source:       result.source,
      empiricalBasis: result.n,
      interpretation,
      // Diagnostic: show all fitted Platt models (useful for PoC demos)
      models: tag ? undefined : getPlattDiagnostics(),
    });
  });

  // GET /confidence-report ─────────────────────────────────────────────────────
  // YC board-deck metric: "how do we know when to trust the AI agent?"
  // Synthesises threshold calibration, autonomous accuracy, and per-detector
  // health into a single human-readable + machine-readable report.
  router.get('/confidence-report', async (req, res) => {
    const windowDays = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? '30'), 10)));
    const windowStart = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Threshold data
    const currentThreshold = getExecutionThreshold();
    const roc = computeRocCurve();
    const bestRoc = roc.length > 0
      ? roc.reduce((best, pt) => pt.youdensJ > best.youdensJ ? pt : best, roc[0])
      : null;
    const records = getRecords();
    const thresholdSampleSize = records.filter((r) => r.verdict !== null).length;

    // Autonomous incident outcomes — fetch all incidents (large limit, no status filter)
    const allIncidents = await getStores().incidents.list(undefined, 10_000, req.tenantId);
    const windowIncidents = allIncidents.filter(
      (i) => (i.createdAt ?? 0) >= windowStart,
    );
    const autonomous = windowIncidents.filter((i) => i.resolvedAutonomously);
    const successful = autonomous.filter((i) => i.causallyCorrect === true);
    const falsePositives = autonomous.filter((i) => i.causallyCorrect === false);

    const recent7d = autonomous.filter((i) => (i.resolvedAt ?? i.createdAt ?? 0) >= sevenDaysAgo);
    const recent7dSuccess = recent7d.filter((i) => i.causallyCorrect === true);
    const rollingRate7d = recent7d.length > 0
      ? Math.round((recent7dSuccess.length / recent7d.length) * 1000) / 1000
      : null;

    // Detector health
    const stats = getStats();
    const detectorHealth = stats.map((s) => ({
      tag: s.tag,
      accuracy: Math.round(s.accuracy * 1000) / 1000,
      verdicts: s.verdicts,
      trusted: s.trusted,
      status: s.accuracy >= 0.8 ? 'healthy' : s.accuracy >= 0.6 ? 'degraded' : 'poor',
    })).sort((a, b) => b.verdicts - a.verdicts);

    const successRate = autonomous.length > 0
      ? Math.round((successful.length / autonomous.length) * 100)
      : null;

    const deckSummary = autonomous.length === 0
      ? `No autonomous resolutions yet in the last ${windowDays} days. Mergen is in observation mode.`
      : `Mergen acted autonomously ${autonomous.length} time${autonomous.length !== 1 ? 's' : ''} in ${windowDays} days. ` +
        `Success rate: ${successRate}%. ` +
        `Current confidence threshold: ${Math.round(currentThreshold * 100)}%` +
        (thresholdSampleSize >= 10
          ? ` (calibrated from ${thresholdSampleSize} verdicts).`
          : ' (default prior — calibrates with use).');

    res.json({
      ok: true,
      report: {
        generatedAt: new Date().toISOString(),
        windowDays,
        threshold: {
          current: Math.round(currentThreshold * 1000) / 1000,
          recommendation: bestRoc
            ? Math.round(bestRoc.threshold * 1000) / 1000
            : Math.round(currentThreshold * 1000) / 1000,
          basis: thresholdSampleSize >= 10 ? 'empirical' : 'prior',
          sampleSize: thresholdSampleSize,
        },
        autonomousAccuracy: {
          attempts: autonomous.length,
          successful: successful.length,
          falsePositives: falsePositives.length,
          rollingRate7d,
          label: successRate !== null
            ? `${successRate}% of autonomous fixes resolved the incident`
            : 'No autonomous actions yet — enable MERGEN_AUTOPILOT=true',
        },
        detectorHealth,
        deckSummary,
      },
    });
  });

  return router;
}
