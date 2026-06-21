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
import { replayIncident, listSnapshotPids } from '../intelligence/incident-replay.js';
import { postmortemStore } from '../intelligence/postmortem-store.js';
import { commitContextStore } from '../sensor/commit-context-store.js';
import logger from '../sensor/logger.js';
import { getShadowLog } from '../intelligence/shadow-log.js';
import { isShadowMode } from '../intelligence/execution-mode.js';

export function createIncidentsRouter(): Router {
  const router = Router();

  // ── List ──────────────────────────────────────────────────────────────────────
  router.get('/incidents', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status as 'open'|'acknowledged'|'resolved' : undefined;
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
    res.json({ ok: true, incidents: incidentStore.list(status, limit) });
  });

  // ── Static sub-paths — MUST be registered before GET /incidents/:pid ─────────
  // Express matches routes in registration order; registering /:pid first would
  // shadow every static path below (impact-report, graph, postmortems, etc.).

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

  // ── Mark context brief viewed ─────────────────────────────────────────────────
  // Call this when an engineer reads Mergen's diagnosis brief before acting.
  // Recorded automatically when GET /trust-score/:pid is called.
  // Used to split MTTR into context-assisted vs. unassisted in the impact report.
  router.post('/incidents/:pid/mark-context-viewed', (req, res) => {
    const inc = incidentStore.get(req.params.pid);
    if (!inc) { res.status(404).json({ error: 'not found' }); return; }
    incidentStore.markContextViewed(req.params.pid);
    res.json({ ok: true, pid: req.params.pid, contextBriefViewedAt: inc.contextBriefViewedAt ?? Date.now() });
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

    // Return attribution context so the CLI can prompt for explicit feedback
    res.json({
      ok: true,
      id: target?.id,
      attributionSha: target?.attributionSha ?? null,
      attributionConfidence: target?.attributionConfidence ?? null,
    });
  });

  // ── Attribution explicit feedback — called by `mergen-server resolved` after prompt ─
  router.post('/incidents/resolve-active/attribution-feedback', (req, res) => {
    const { id, attributionCorrect } = (req.body ?? {}) as { id?: number; attributionCorrect?: boolean };
    if (id == null || attributionCorrect == null) {
      res.status(400).json({ error: 'id and attributionCorrect are required' });
      return;
    }
    memoryStore.recordAttributionFeedback(Number(id), attributionCorrect ? 1 : 0);
    logger.info({ id, attributionCorrect }, 'explicit attribution feedback recorded');
    res.json({ ok: true });
  });

  // ── MTTR Impact Report ────────────────────────────────────────────────────────
  // Board-deck metric: how many incidents resolved, how many autonomously, avg MTTR.
  // Designed to be called by any dashboard or reporting tool.
  router.get('/incidents/impact-report', (_req, res) => {
    const isShadow = isShadowMode();
    const all = incidentStore.list(undefined, 500);
    const resolved = all.filter((i) => i.status === 'resolved' && i.resolvedAt !== null);

    let autonomousCount = 0;
    let manualCount = resolved.length;
    let causallyCorrectCount = 0;
    const wouldResolvePids = new Set<string>();
    const approvedPids = new Set<string>();

    if (isShadow) {
      const shadowLog = getShadowLog();
      for (const e of shadowLog) {
        if (e.wouldHaveExecuted) {
          wouldResolvePids.add(e.pid);
        }
        if (e.humanVerdict === 'would-approve') {
          approvedPids.add(e.pid);
        }
      }
      autonomousCount = resolved.filter((i) => wouldResolvePids.has(i.pid)).length;
      manualCount     = resolved.length - autonomousCount;
      causallyCorrectCount = resolved.filter((i) => approvedPids.has(i.pid)).length;
    } else {
      autonomousCount = resolved.filter((i) => i.resolvedAutonomously).length;
      manualCount     = resolved.length - autonomousCount;
      causallyCorrectCount = resolved.filter((i) => i.causallyCorrect).length;
    }

    const causallyCorrectRate  = autonomousCount > 0
      ? Math.round((causallyCorrectCount / autonomousCount) * 100)
      : 0;

    const mttrMs = (incidents: typeof resolved): number | null => {
      if (incidents.length === 0) return null;
      const valid = incidents.filter((i) => i.resolvedAt !== null && i.createdAt > 0);
      if (valid.length === 0) return null;
      const total = valid.reduce((sum, i) => sum + (i.resolvedAt! - i.createdAt), 0);
      return Math.round(total / valid.length);
    };

    let autonomousIncidents: typeof resolved = [];
    let manualIncidents: typeof resolved = [];

    if (isShadow) {
      autonomousIncidents = resolved.filter((i) => wouldResolvePids.has(i.pid));
      manualIncidents     = resolved.filter((i) => !wouldResolvePids.has(i.pid));
    } else {
      autonomousIncidents = resolved.filter((i) => i.resolvedAutonomously);
      manualIncidents     = resolved.filter((i) => !i.resolvedAutonomously);
    }

    res.json({
      ok: true,
      isShadowMode: isShadow,
      totalResolved: resolved.length,
      autonomousResolutions: autonomousCount,
      manualResolutions: manualCount,
      autonomousRate: resolved.length > 0 ? Math.round((autonomousCount / resolved.length) * 100) : 0,
      // ── The LeCun metric: fraction of autonomous fixes that were causally correct ──
      // Not just "resolved fast" but "root cause was right and error rate dropped".
      causallyCorrectFixes: causallyCorrectCount,
      causallyCorrectRate,  // % of autonomous resolutions that were causally correct
      mttr: {
        overallMs: mttrMs(resolved),
        autonomousMs: mttrMs(autonomousIncidents),
        manualMs: mttrMs(manualIncidents),
      },
      recentResolutions: resolved
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
        .slice(0, 10)
        .map((i) => ({
          pid: i.pid,
          tag: i.tag,
          resolvedAt: i.resolvedAt,
          resolvedAutonomously: isShadow ? wouldResolvePids.has(i.pid) : i.resolvedAutonomously,
          causallyCorrect: isShadow ? approvedPids.has(i.pid) : i.causallyCorrect,
          mttrMs: i.resolvedAt && i.createdAt ? i.resolvedAt - i.createdAt : null,
        })),
    });
  });

  // ── Add note ──────────────────────────────────────────────────────────────────
  router.post('/incidents/:pid/note', (req, res) => {
    const { text, author } = (req.body ?? {}) as { text?: string; author?: string };
    if (!text) { res.status(400).json({ error: 'text is required' }); return; }
    const updated = incidentStore.addNote(req.params.pid, String(text), author);
    if (!updated) { res.status(404).json({ error: 'incident not found — POST /incidents first' }); return; }
    res.json({ ok: true, incident: updated });
  });

  // ── Service graph (Y3 system-of-record) ─────────────────────────────────────
  // Returns a service × failure-mode matrix derived from resolved incidents.
  // Expansion signals: new services connected = NRR growth trigger.
  router.get('/incidents/graph', (_req, res) => {
    const all = incidentStore.list(undefined, 1000);
    const services = new Map<string, Map<string, number>>();

    for (const inc of all) {
      const svc = inc.service ?? 'unknown';
      if (!services.has(svc)) services.set(svc, new Map());
      const modes = services.get(svc)!;
      const tag = inc.tag.replace(/^infra_/, '') || 'unknown';
      modes.set(tag, (modes.get(tag) ?? 0) + 1);
    }

    const graph = [...services.entries()].map(([service, modes]) => ({
      service,
      incidentCount: [...modes.values()].reduce((a, b) => a + b, 0),
      failureModes: Object.fromEntries(modes),
    })).sort((a, b) => b.incidentCount - a.incidentCount);

    res.json({
      ok: true,
      serviceCount: graph.length,
      totalIncidents: all.length,
      graph,
    });
  });

  // ── Service interaction graph ────────────────────────────────────────────────
  // Returns the persistent co-occurrence graph: edges between services that have
  // had incidents within 10 minutes of each other. Weight accumulates over time.
  // Optional ?service= filter to return only edges touching a specific service.
  router.get('/services/interactions', (req, res) => {
    const service = typeof req.query.service === 'string' ? req.query.service : undefined;
    const edges = incidentStore.getInteractionGraph(service);
    const services = [...new Set(edges.flatMap((e) => [e.source, e.target]))];
    res.json({
      ok: true,
      service: service ?? null,
      edgeCount: edges.length,
      services,
      edges,
    });
  });

  // ── Commit intent archive ────────────────────────────────────────────────────
  // GET /commit-contexts          — list captured PR contexts (paginated)
  // GET /commit-contexts/:sha     — lookup by commit SHA (full or 7-char prefix)
  // Query params: ?repo=  ?limit=  ?since=  ?until=
  router.get('/commit-contexts', (req, res) => {
    const repo  = typeof req.query.repo  === 'string' ? req.query.repo  : undefined;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
    const since = req.query.since ? Number(req.query.since) : undefined;
    const until = req.query.until ? Number(req.query.until) : undefined;

    const contexts = since != null || until != null
      ? commitContextStore.listByWindow(since ?? 0, until ?? Date.now(), repo, limit)
      : repo
        ? commitContextStore.listByRepo(repo, limit)
        : commitContextStore.listByWindow(0, Date.now(), undefined, limit);

    res.json({
      ok: true,
      total: commitContextStore.count(),
      count: contexts.length,
      contexts,
    });
  });

  router.get('/commit-contexts/:sha', (req, res) => {
    const ctx = commitContextStore.getBySha(req.params.sha);
    if (!ctx) { res.status(404).json({ ok: false, error: 'not found' }); return; }
    res.json({ ok: true, context: ctx });
  });

  // ── Postmortems list ─────────────────────────────────────────────────────────
  // Returns structured postmortems for a given tag or all recent ones.
  router.get('/incidents/postmortems', (req, res) => {
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));

    const postmortems = tag
      ? postmortemStore.getByTag(tag, limit)
      : postmortemStore.list(limit);

    res.json({
      ok: true,
      count: postmortems.length,
      total: postmortemStore.count(),
      tagStats: postmortemStore.tagStats(),
      postmortems,
    });
  });

  // ── Replay snapshots list ────────────────────────────────────────────────────
  // Returns the pids for which a telemetry replay snapshot exists.
  router.get('/incidents/replay-snapshots', (_req, res) => {
    const pids = listSnapshotPids();
    res.json({ ok: true, count: pids.length, pids });
  });

  // ── Get one — registered LAST so static /incidents/* paths match first ─────────
  router.get('/incidents/:pid', (req, res) => {
    const inc = incidentStore.get(req.params.pid);
    if (!inc) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ ok: true, incident: inc });
  });

  // ── Replay incident analysis ─────────────────────────────────────────────────
  // Re-runs buildCausalChain against the stored telemetry snapshot and returns
  // a drift report comparing the original vs. replayed diagnosis.
  router.post('/incidents/:pid/replay', (req, res) => {
    const { pid } = req.params;
    replayIncident(pid).then((result) => {
      if (!result) {
        res.status(404).json({ ok: false, error: `No replay snapshot found for pid ${pid}. Snapshots are captured automatically when autopilot runs.` });
        return;
      }
      res.json({ ok: true, ...result });
    }).catch((err: unknown) => {
      logger.warn({ err, pid }, 'incidents: replay failed');
      res.status(500).json({ ok: false, error: 'Replay analysis failed' });
    });
  });

  return router;
}
