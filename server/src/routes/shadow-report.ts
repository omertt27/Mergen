/**
 * routes/shadow-report.ts — Shadow mode track record API.
 *
 *   GET  /shadow-report                 aggregated track record (JSON or CSV)
 *   GET  /shadow-report/slack-digest    pre-formatted Slack block for weekly digest
 *   GET  /shadow-report/entries         raw shadow log entries
 *   POST /shadow-report/:id/verdict     annotate a shadow entry → closes feedback loop
 *
 * The verdict endpoint is the critical link between shadow mode and the override corpus.
 * When an SRE reviews a shadow entry and says "I would have stopped this", that
 * annotation becomes an override corpus entry — without requiring a separate API call.
 * This closes the loop: shadow report generates signal → human reviews → corpus learns.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  getShadowReport,
  getShadowSlackDigest,
  getShadowLog,
  recordShadowVerdict,
  exportShadowCsv,
} from '../intelligence/shadow-log.js';
import { OVERRIDE_REASONS, type OverrideReason } from '../intelligence/override-corpus.js';
import logger from '../sensor/logger.js';

const VerdictSchema = z.object({
  verdict:        z.enum(['would-approve', 'would-override']),
  note:           z.string().max(200).optional(),
  overrideReason: z.enum(OVERRIDE_REASONS as [OverrideReason, ...OverrideReason[]]).optional(),
  manualAction:   z.string().max(500).optional(),
  actor:          z.string().max(200).optional(),
});

// Short aliases used by the one-click GET links embedded in Slack messages.
const VERDICT_ALIAS: Record<string, 'would-approve' | 'would-override'> = {
  approve:  'would-approve',
  override: 'would-override',
};

export function createShadowReportRouter(): Router {
  const router = Router();

  // ── Aggregated report (JSON default, CSV on ?format=csv) ───────────────────
  router.get('/shadow-report', (req, res) => {
    const windowDays = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));

    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="mergen-shadow-log.csv"');
      res.send(exportShadowCsv());
      return;
    }

    const report = getShadowReport(windowDays);
    res.json({ ok: true, report });
  });

  // ── Slack digest block ─────────────────────────────────────────────────────
  router.get('/shadow-report/slack-digest', (req, res) => {
    const windowDays = Math.min(30, Math.max(1, Number(req.query.days ?? 7)));
    res.json(getShadowSlackDigest(windowDays));
  });

  // ── One-click verdict link (GET) — embedded in shadow mode Slack messages ──
  // ?v=approve|override  &reason=<OverrideReason>  &actor=<string>
  // Returns HTML so clicking the link in Slack gives instant visual feedback.
  router.get('/shadow-report/:id/verdict', (req, res) => {
    const alias = String(req.query.v ?? '');
    const verdict = VERDICT_ALIAS[alias];
    if (!verdict) {
      res.status(400).send('<h2>❌ Unknown verdict. Use ?v=approve or ?v=override</h2>');
      return;
    }
    const overrideReason = (req.query.reason as OverrideReason | undefined) ?? 'on-call-discretion';
    if (verdict === 'would-override' && !OVERRIDE_REASONS.includes(overrideReason)) {
      res.status(400).send(`<h2>❌ Unknown override reason: ${overrideReason}</h2>`);
      return;
    }

    const result = recordShadowVerdict(req.params.id, verdict, {
      overrideReason: verdict === 'would-override' ? overrideReason : undefined,
      actor:          String(req.query.actor ?? 'slack-link'),
    });

    if (!result.found) {
      res.status(404).send('<h2>❌ Shadow entry not found — it may have expired.</h2>');
      return;
    }

    logger.info(
      { id: req.params.id, verdict, overrideId: result.overrideId },
      'shadow verdict recorded via one-click link',
    );

    const icon    = verdict === 'would-approve' ? '✅' : '✋';
    const label   = verdict === 'would-approve' ? 'Approved' : 'Override recorded';
    const corpusNote = result.overrideId
      ? `<p style="color:#666">Override corpus entry created — Mergen won't auto-execute this pattern again without review.</p>`
      : '';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center}
h1{font-size:2.5rem;margin-bottom:.5rem}p{color:#555;margin:.25rem 0}</style></head>
<body><h1>${icon}</h1><h2>${label}</h2>
<p>Shadow entry <code>${req.params.id.slice(0, 8)}</code> annotated.</p>
${corpusNote}
<p style="margin-top:2rem;font-size:.85rem"><a href="/shadow-report">View full shadow report →</a></p>
</body></html>`);
  });

  // ── Raw entries ────────────────────────────────────────────────────────────
  router.get('/shadow-report/entries', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    const entries = [...getShadowLog()].reverse().slice(0, limit);
    res.json({ ok: true, entries });
  });

  // ── Human verdict — closes the feedback loop ───────────────────────────────
  // An SRE reviews the shadow report, finds an entry they would have stopped,
  // and POSTs their verdict here. The 'would-override' path automatically
  // creates an override corpus entry — no second API call needed.
  router.post('/shadow-report/:id/verdict', (req, res) => {
    const parsed = VerdictSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation failed', details: parsed.error.issues });
      return;
    }
    if (parsed.data.verdict === 'would-override' && !parsed.data.overrideReason) {
      res.status(400).json({ error: 'overrideReason is required when verdict is "would-override"' });
      return;
    }

    const result = recordShadowVerdict(req.params.id, parsed.data.verdict, {
      note:           parsed.data.note,
      overrideReason: parsed.data.overrideReason,
      manualAction:   parsed.data.manualAction,
      actor:          parsed.data.actor,
    });

    if (!result.found) {
      res.status(404).json({ error: 'shadow entry not found' });
      return;
    }

    logger.info(
      { id: req.params.id, verdict: parsed.data.verdict, overrideId: result.overrideId },
      'shadow verdict recorded',
    );

    res.json({
      ok: true,
      entry: result.entry,
      ...(result.overrideId ? { overrideId: result.overrideId, note: 'Override corpus entry created automatically.' } : {}),
    });
  });

  return router;
}
