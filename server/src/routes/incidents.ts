/**
 * routes/incidents.ts — Incident workflow endpoints.
 *
 *   GET  /incidents            list all (query: ?status=open|acknowledged|resolved)
 *   POST /incidents            create from hypothesis pid + metadata
 *   GET  /incidents/:pid       get one
 *   POST /incidents/:pid/acknowledge
 *   POST /incidents/:pid/assign
 *   POST /incidents/:pid/resolve
 *   POST /incidents/:pid/note
 *
 * The pid is the stable hypothesis prediction ID from the calibration system.
 * It's surfaced in the Slack alert, the dashboard, and the VS Code panel —
 * so engineers can act on it from wherever they see the alert.
 */

import { Router } from 'express';
import { incidentStore } from '../sensor/incident-store.js';
import { memoryStore, inferResolutionType } from '../datadog/memory-store.js';
import { getActiveIncident, clearActiveIncident } from '../datadog/incident-state.js';
import logger from '../sensor/logger.js';

export function createIncidentsRouter(): Router {
  const router = Router();

  // ── List ──────────────────────────────────────────────────────────────────────
  router.get('/incidents', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status as 'open'|'acknowledged'|'resolved' : undefined;
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
    res.json({ ok: true, incidents: incidentStore.list(status, limit) });
  });

  // ── Get one ───────────────────────────────────────────────────────────────────
  router.get('/incidents/:pid', (req, res) => {
    const inc = incidentStore.get(req.params.pid);
    if (!inc) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ ok: true, incident: inc });
  });

  // ── Create / upsert ───────────────────────────────────────────────────────────
  router.post('/incidents', (req, res) => {
    const { pid, hypothesis, tag, sha, environment, confidence } =
      (req.body ?? {}) as Record<string, string | number | undefined>;
    if (!pid || typeof pid !== 'string') {
      res.status(400).json({ error: 'pid is required' }); return;
    }
    const inc = incidentStore.upsert(String(pid), {
      hypothesis: hypothesis ? String(hypothesis) : '',
      tag: tag ? String(tag) : '',
      sha: sha ? String(sha) : null,
      environment: environment ? String(environment) : null,
      confidence: typeof confidence === 'number' ? confidence : Number(confidence ?? 0),
    });
    logger.info({ pid: inc.pid }, 'incident created');
    res.json({ ok: true, incident: inc });
  });

  // ── Acknowledge ───────────────────────────────────────────────────────────────
  router.post('/incidents/:pid/acknowledge', (req, res) => {
    const { by } = (req.body ?? {}) as { by?: string };
    let inc = incidentStore.get(req.params.pid);
    if (!inc) {
      // Auto-create if hypothesis is known from the request body
      const { hypothesis, tag, sha, confidence } = (req.body ?? {}) as Record<string, string | number | undefined>;
      inc = incidentStore.upsert(req.params.pid, {
        hypothesis: hypothesis ? String(hypothesis) : 'Unknown',
        tag: tag ? String(tag) : '',
        sha: sha ? String(sha) : null,
        confidence: typeof confidence === 'number' ? confidence : Number(confidence ?? 0),
      });
    }
    const updated = incidentStore.upsert(req.params.pid, {
      status: 'acknowledged',
      acknowledgedBy: by ? String(by) : null,
    });
    logger.info({ pid: req.params.pid, by }, 'incident acknowledged');
    res.json({ ok: true, incident: updated });
  });

  // ── Assign ────────────────────────────────────────────────────────────────────
  router.post('/incidents/:pid/assign', (req, res) => {
    const { to } = (req.body ?? {}) as { to?: string };
    if (!to) { res.status(400).json({ error: 'to is required' }); return; }
    const existing = incidentStore.get(req.params.pid) ??
      incidentStore.upsert(req.params.pid, { hypothesis: 'Unknown' });
    const updated = incidentStore.upsert(req.params.pid, {
      assignee: String(to),
      status: existing.status === 'open' ? 'acknowledged' : existing.status,
    });
    logger.info({ pid: req.params.pid, to }, 'incident assigned');
    res.json({ ok: true, incident: updated });
  });

  // ── Resolve ───────────────────────────────────────────────────────────────────
  router.post('/incidents/:pid/resolve', (req, res) => {
    const { by, note } = (req.body ?? {}) as { by?: string; note?: string };
    incidentStore.upsert(req.params.pid, {
      status: 'resolved',
      resolvedAt: Date.now(),
    });
    if (note) incidentStore.addNote(req.params.pid, `[resolved] ${note}`, by);
    const updated = incidentStore.get(req.params.pid);
    logger.info({ pid: req.params.pid, by }, 'incident resolved');
    res.json({ ok: true, incident: updated });
  });

  // ── Resolve active — called by `mergen-server resolved` CLI command ───────────
  // Closes whatever incident is currently open in the memory store and records
  // the engineer's free-text fix summary. This is Option B explicit capture.
  router.post('/incidents/resolve-active', (req, res) => {
    const { fixSummary, fixPrUrl, resolvedAt } = (req.body ?? {}) as Record<string, string | undefined>;
    const active = getActiveIncident();
    const resType = fixPrUrl ? inferResolutionType(fixSummary ?? '') : 'unknown';

    const openRecs = memoryStore.listOpen();
    if (openRecs.length === 0 && !active) {
      res.status(404).json({ error: 'no open incident found' });
      return;
    }

    const target = openRecs[0];
    if (target) {
      memoryStore.closeIncident({
        id: target.id,
        resolvedAt: resolvedAt ? Number(resolvedAt) : Date.now(),
        fixSummary: fixSummary ?? undefined,
        fixPrUrl: fixPrUrl ?? undefined,
        resolutionType: resType,
      });
    }

    clearActiveIncident();
    logger.info({ id: target?.id, fixSummary }, 'incident resolved via CLI');
    res.json({ ok: true, id: target?.id });
  });

  // ── Add note ──────────────────────────────────────────────────────────────────
  router.post('/incidents/:pid/note', (req, res) => {
    const { text, author } = (req.body ?? {}) as { text?: string; author?: string };
    if (!text) { res.status(400).json({ error: 'text is required' }); return; }
    const updated = incidentStore.addNote(req.params.pid, String(text), author);
    if (!updated) { res.status(404).json({ error: 'incident not found — POST /incidents first' }); return; }
    res.json({ ok: true, incident: updated });
  });

  return router;
}
