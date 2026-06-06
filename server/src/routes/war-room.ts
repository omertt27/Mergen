/**
 * war-room.ts — War room API: open incidents + attribution accuracy + MTTR history.
 *
 * GET /api/war-room — returns everything the dashboard war room section needs.
 * GET /attribution-feedback — link-based fallback when no Slack bot token.
 *
 * This endpoint is the data backbone for the CTO demo:
 *   "HIGH confidence: 92% correct across 13 incidents"
 */

import { Router } from 'express';
import { memoryStore, formatMttr } from '../datadog/memory-store.js';
import { getActiveIncident } from '../datadog/incident-state.js';
import { store } from '../sensor/buffer.js';
import logger from '../sensor/logger.js';

export function createWarRoomRouter(): Router {
  const router = Router();

  // ── War room data ─────────────────────────────────────────────────────────────
  router.get('/api/war-room', (_req, res) => {
    const active     = getActiveIncident();
    const openRecs   = memoryStore.listOpen();
    const blastRadius = store.getBlastRadius({ since: active?.firedAt });

    // MTTR history — last 20 resolved incidents
    const allRecs = memoryStore.listAll(100);
    const resolved = allRecs
      .filter((r) => r.mttrMs !== null)
      .sort((a, b) => b.firedAt - a.firedAt)
      .slice(0, 20)
      .map((r) => ({
        id: r.id,
        service: r.service,
        alertTitle: r.pdAlertTitle,
        firedAt: r.firedAt,
        mttrMs: r.mttrMs,
        mttrFmt: r.mttrMs ? formatMttr(r.mttrMs) : null,
        resolutionType: r.resolutionType,
        fingerprint: r.fingerprint,
        attributionConfidence: r.attributionConfidence,
        attributionSha: r.attributionSha ? r.attributionSha.slice(0, 8) : null,
        attributionValidated: r.attributionValidated,
        fixPrUrl: r.fixPrUrl,
      }));

    // Attribution accuracy by confidence band
    const validated = allRecs.filter(
      (r) => r.attributionConfidence !== null && r.attributionValidated !== null,
    );
    const bands = {
      high:   validated.filter((r) => r.attributionConfidence! >= 0.80),
      medium: validated.filter((r) => r.attributionConfidence! >= 0.60 && r.attributionConfidence! < 0.80),
      low:    validated.filter((r) => r.attributionConfidence! < 0.60),
    };
    const accuracy = Object.fromEntries(
      Object.entries(bands).map(([band, recs]) => [
        band,
        {
          correct: recs.filter((r) => r.attributionValidated === 1).length,
          total: recs.length,
          pct: recs.length > 0
            ? Math.round((recs.filter((r) => r.attributionValidated === 1).length / recs.length) * 100)
            : null,
        },
      ]),
    );

    // Open incidents enriched with attribution + blast radius
    const openEnriched = openRecs.map((r) => ({
      id: r.id,
      service: r.service,
      alertTitle: r.pdAlertTitle,
      alertUrl: r.pdAlertUrl,
      firedAt: r.firedAt,
      implicatedFile: r.implicatedFile,
      implicatedLine: r.implicatedLine,
      attributionConfidence: r.attributionConfidence,
      attributionSha: r.attributionSha ? r.attributionSha.slice(0, 8) : null,
      traceId: r.traceId,
    }));

    res.json({
      ok: true,
      activeIncident: active ? {
        service: active.service,
        alertTitle: active.alertTitle,
        firedAt: active.firedAt,
        blameConfidence: active.blameAttribution?.confidence ?? null,
        blameLabel: active.blameAttribution?.confidenceLabel ?? null,
        blameSha: active.blameAttribution?.topCandidate?.sha.slice(0, 8) ?? null,
        blameExplanation: active.blameAttribution?.explanation ?? null,
      } : null,
      openIncidents: openEnriched,
      blastRadius: {
        affectedSessions: blastRadius.affectedSessions,
        affectedUsers: blastRadius.affectedUsers,
        errorCount: blastRadius.errorCount,
        firstSeenAt: blastRadius.firstSeenAt,
        durationMs: blastRadius.durationMs,
        browserSegments: blastRadius.browserSegments,
        topErrors: blastRadius.topErrors.slice(0, 3),
      },
      mttrHistory: resolved,
      attributionAccuracy: accuracy,
    });
  });

  // ── Attribution feedback route — GET (link-based, no JS required) ─────────────
  // Slack buttons post to this URL when the team isn't using interactive mode.
  router.get('/attribution-feedback', (req, res) => {
    const id      = parseInt(String(req.query.id ?? ''), 10);
    const correct = req.query.correct === '1';

    if (isNaN(id)) { res.status(400).send('Invalid id'); return; }

    memoryStore.recordAttributionFeedback(id, correct ? 1 : 0);
    logger.info({ id, correct }, 'attribution feedback via link');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Mergen — Feedback</title>
<style>body{font-family:system-ui;text-align:center;padding:60px;background:#0f1117;color:#e2e8f0}</style>
</head>
<body>
  <h2 style="color:${correct ? '#22c55e' : '#ef4444'}">${correct ? '✅ Attribution marked correct' : '❌ Attribution marked incorrect'}</h2>
  <p style="color:#64748b;margin-top:12px">Feedback stored. Mergen's accuracy improves with every validated incident.</p>
  <p style="margin-top:24px"><a href="/dashboard" style="color:#3b82f6">Back to war room</a></p>
</body></html>`);
  });

  return router;
}
