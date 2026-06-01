/**
 * routes/sensor.ts — Read-only sensor & diagnostic endpoints.
 *
 * Handles: /health, /clear, /checkpoint, /diagnose, /timeline,
 *          /usage, /last-pack, /history
 *
 * None of these own their own data — they read from the shared in-memory
 * store and the hypothesis history cache. All writes (clear, checkpoint)
 * mutate the store only, no external I/O.
 */
import { Router } from 'express';
import { store } from '../sensor/buffer.js';
import { historyStore } from '../sensor/sqlite-store.js';
import { buildCausalChain } from '../intelligence/causal.js';
import { hypothesisHistory } from '../intelligence/hypothesis-history.js';
import { getStats } from '../intelligence/calibration.js';
import { getUsageSnapshot } from '../intelligence/usage.js';
import { toolCallCounts, lastMcpCallAt } from '../intelligence/tools.js';
import { listActiveSessions } from '../intelligence/debug-sessions.js';
import { getTeamState, isTeamEnabled } from '../intelligence/team.js';

export function createSensorRouter(serverVersion: string): Router {
  const router = Router();

  // ── Health ────────────────────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    const teamState = getTeamState();
    const counters = store.getCounters();
    res.json({
      ok: true,
      buffered: store.size(),
      errors: counters.errors,
      warnings: counters.warnings,
      networkErrors: counters.networkErrors,
      lastEventAt: store.lastEventAt(),
      clearedAt: store.clearedAt(),
      mcpLastCallAt: lastMcpCallAt,
      signals: store.getSignals(),
      name: 'mergen',
      version: serverVersion,
      teamSync: isTeamEnabled()
        ? { enabled: true, memberName: teamState?.memberName, connectedPeers: 0 }
        : { enabled: false },
    });
  });

  // ── Clear ─────────────────────────────────────────────────────────────────
  router.post('/clear', (_req, res) => {
    const was = store.size();
    store.clear();
    historyStore.clear();
    hypothesisHistory.clear();
    res.json({ ok: true, cleared: was });
  });

  // ── Checkpoint ────────────────────────────────────────────────────────────
  // Named dev milestone — injected as a console.log event so it appears in
  // the causal timeline. Called by git pre-commit hook and VS Code on-save task.
  router.post('/checkpoint', (req, res) => {
    const { label } = (req.body ?? {}) as { label?: string };
    const name = (typeof label === 'string' && label.trim())
      ? label.trim().slice(0, 120)
      : 'checkpoint';

    store.push({
      type: 'console',
      level: 'log',
      args: [`[mergen:checkpoint] ${name}`],
      url: 'mergen://checkpoint',
      timestamp: Date.now(),
    });

    const signals = store.getSignals();
    res.json({
      ok: true,
      label: name,
      buffered: store.size(),
      signals: signals.length,
      topSignal: signals[0] ?? null,
    });
  });

  // ── Diagnose ──────────────────────────────────────────────────────────────
  // Returns the current buffer's contextPack + a fully-formed OpenAI request
  // body so callers can pipe it straight into the completions API.
  router.get('/diagnose', async (_req, res) => {
    const logs     = store.getLogs(200);
    const network  = store.getNetwork(200);
    const contexts = store.getContext(20);

    const causal = await buildCausalChain(logs, network, contexts);

    const SYSTEM = [
      'You are a concise runtime-debug assistant.',
      'You will receive a structured telemetry report called a "Context Pack".',
      'Your job is to identify the root cause of the bug and the exact fix.',
      '',
      'Rules:',
      '1. Respond with a single JSON object only — no surrounding prose, no markdown fences.',
      '2. Be maximally specific: name the endpoint, field, or code path that is broken.',
      '3. The fix must be a concrete, immediately-applicable action (a code line, not a concept).',
      '4. If you are not confident, say so in missing_signals — do not hallucinate.',
    ].join('\n');

    const USER = [
      causal.contextPack,
      '',
      'Return a single JSON object with exactly these fields:',
      '  root_cause  — one sentence naming what broke and why (be specific: endpoint/field/line)',
      '  fix         — one concrete action: a code line, config change, or exact command',
      '  confidence  — HIGH | MEDIUM | LOW',
      '  missing_signals — what telemetry would make this HIGH confidence, or null',
    ].join('\n');

    const openaiRequest = {
      model: process.env.MERGEN_MODEL ?? 'gpt-4o',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: USER },
      ],
    };

    res.json({
      ok: true,
      buffered: store.size(),
      hypotheses: causal.hypotheses.length,
      contextPack: causal.contextPack,
      openai_request: openaiRequest,
      prompt: { system: SYSTEM, user: USER },
    });
  });

  // ── Usage ─────────────────────────────────────────────────────────────────
  router.get('/usage', (_req, res) => {
    res.json({ ...getUsageSnapshot(), toolCallCounts });
  });

  // ── Last pack ─────────────────────────────────────────────────────────────
  // Full Context Pack of the most recent diagnosis, enriched with per-detector
  // calibration stats so the panel can render accuracy badges inline.
  router.get('/last-pack', (_req, res) => {
    const latest = hypothesisHistory.latest();
    if (!latest) {
      res.json({ ok: true, hasPack: false });
      return;
    }
    const statsByTag = new Map(getStats().map((s) => [s.tag, s]));
    const enrich = (h: typeof latest.topHypothesis) =>
      h ? { ...h, calibration: statsByTag.get(h.tag) ?? null } : h;
    res.json({
      ok: true,
      hasPack: true,
      builtAt: latest.builtAt,
      builtAtIso: latest.builtAtIso,
      triggerMessage: latest.triggerMessage,
      reason: latest.reason,
      topHypothesis: enrich(latest.topHypothesis),
      hypotheses: latest.chain.hypotheses.map((h) => enrich(h)),
      contextPack: latest.chain.contextPack,
      hypothesesCount: latest.chain.hypotheses.length,
      errorsCount: latest.chain.errors.length,
    });
  });

  // ── History ───────────────────────────────────────────────────────────────
  // Lightweight list of recent diagnoses — no full contextPack, just metadata.
  router.get('/history', (req, res) => {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 10)));
    const statsByTag = new Map(getStats().map((s) => [s.tag, s]));
    const entries = hypothesisHistory.list(limit).map((e) => ({
      ...e,
      topHypothesis: e.topHypothesis
        ? { ...e.topHypothesis, calibration: statsByTag.get(e.topHypothesis.tag) ?? null }
        : null,
    }));
    res.json({ ok: true, entries });
  });

  // ── Timeline ──────────────────────────────────────────────────────────────
  // Interleaved console + network + context events as a chronological stream.
  //   ?seconds=60  — window in seconds (default 60, max 600)
  //   ?limit=200   — max rows returned (default 200, max 500)
  router.get('/timeline', (req, res) => {
    const seconds = Math.min(600, Math.max(1, Number(req.query.seconds ?? 60)));
    const limit   = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
    const since   = Date.now() - seconds * 1000;

    const logs    = store.getLogs(limit, undefined, since);
    const network = store.getNetwork(limit, undefined, since);
    const ctx     = store.getContext(20, since);

    type Row = {
      ts: number;
      isoTs: string;
      kind: 'log' | 'warn' | 'error' | 'request' | 'context';
      summary: string;
    };

    const rows: Row[] = [];
    for (const e of logs) {
      const summary = e.args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ').slice(0, 200);
      rows.push({ ts: e.timestamp, isoTs: new Date(e.timestamp).toISOString(), kind: e.level, summary });
    }
    for (const n of network) {
      const isFail = n.status >= 400 || n.status === 0 || !!n.error;
      const label = n.status === 0 ? `network error (${n.error ?? '—'})` : `${n.status} ${n.statusText}`;
      rows.push({
        ts: n.timestamp,
        isoTs: new Date(n.timestamp).toISOString(),
        kind: 'request',
        summary: `${n.method} ${n.url} → ${label} (${n.duration}ms)${isFail ? ' ⚠' : ''}`,
      });
    }
    for (const c of ctx) {
      rows.push({
        ts: c.timestamp,
        isoTs: new Date(c.timestamp).toISOString(),
        kind: 'context',
        summary: `[${c.trigger}] ${c.url}`,
      });
    }
    rows.sort((a, b) => a.ts - b.ts);

    res.json({ ok: true, windowSeconds: seconds, count: rows.length, rows: rows.slice(-limit) });
  });

  // ── Active debug sessions ─────────────────────────────────────────────────
  // Used by the popup to show the session strip widget.
  router.get('/sessions', (_req, res) => {
    const sessions = listActiveSessions().map(s => {
      const last = s.iterations.length > 0 ? s.iterations[s.iterations.length - 1] : null;
      return {
        id: s.id,
        description: s.description,
        targetComponent: s.targetComponent ?? null,
        startedAt: s.startedAt,
        iterationCount: s.iterations.length,
        baselineErrorCount: s.baseline.errors.length,
        baselineNetworkFailureCount: s.baseline.networkFailures.length,
        latestDiff: last ? {
          resolved: last.diff.resolved.length,
          persisted: last.diff.persisted.length,
          newErrors: last.diff.newErrors.length,
          isFixed: last.diff.isFixed,
        } : null,
      };
    });
    res.json({ ok: true, sessions });
  });

  // ── Replay — historical events from SQLite (last 1 hour) ─────────────────
  // Complements the 200-event ring buffer for long sessions.
  //   GET /replay?since=<unix-ms>&limit=<n>&level=<error|warn|log>&type=<console|network|context>
  router.get('/replay', (req, res) => {
    const since  = Number(req.query['since'])  || 0;
    const limit  = Math.min(Number(req.query['limit'])  || 500, 2_000);
    const level  = typeof req.query['level'] === 'string' ? req.query['level'] : undefined;
    const type   = typeof req.query['type']  === 'string' ? req.query['type']  : undefined;

    const events = historyStore.query({ since, limit, level, type });
    res.json({ ok: true, count: events.length, events });
  });

  return router;
}
