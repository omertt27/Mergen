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
import { getMetricCounters } from '../sensor/otel-exporter.js';
import { startProcessWatcher, stopProcessWatcher, listProcessWatchers } from '../sensor/process-watcher.js';
import { startDockerLogStream, stopDockerLogStream, listStreamedContainers } from '../sensor/docker-log-stream.js';
import { saveSessionToHistory } from '../sensor/session-history.js';
import { historyStore } from '../sensor/sqlite-store.js';
import { buildCausalChain } from '../intelligence/causal.js';
import { hypothesisHistory } from '../intelligence/hypothesis-history.js';
import { getStats } from '../intelligence/calibration.js';
import { getUsageSnapshot } from '../intelligence/usage.js';
import { toolCallCounts, lastMcpCallAt, firstAnalyzeAt, lastTimeToFirstAnalysisMs } from '../intelligence/tools.js';
import { listActiveSessions } from '../intelligence/debug-sessions.js';
import { getTeamState, isTeamEnabled } from '../intelligence/team.js';

export function createSensorRouter(serverVersion: string): Router {
  const router = Router();

  // ── Health ────────────────────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    const teamState = getTeamState();
    const counters = store.getCounters();
    const buffered = store.size();
    const signals = store.getSignals();
    const allClear = counters.errors === 0
      && counters.networkErrors === 0
      && signals.length === 0
      && buffered > 0;
    res.json({
      ok: true,
      buffered,
      errors: counters.errors,
      warnings: counters.warnings,
      networkErrors: counters.networkErrors,
      websocketConnections: store.getWebSocketCount(),
      lastEventAt: store.lastEventAt(),
      clearedAt: store.clearedAt(),
      mcpLastCallAt: lastMcpCallAt,
      firstAnalyzeAt,
      lastTimeToFirstAnalysisMs,
      metrics: getMetricCounters(),
      signals,
      allClear,
      allClearMessage: allClear ? `✅ 0 errors in the last session (${buffered} events captured)` : null,
      allClearSince: allClear ? (store.clearedAt() ?? store.lastEventAt()) : null,
      name: 'mergen',
      version: serverVersion,
      teamSync: isTeamEnabled()
        ? { enabled: true, memberName: teamState?.memberName, connectedPeers: 0 }
        : { enabled: false },
    });
  });

  // ── Clear ─────────────────────────────────────────────────────────────────
  router.post('/clear', (_req, res) => {
    const was    = store.size();
    const events = store.serialize();
    saveSessionToHistory(events, 'manual-clear');
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

    const terminal     = store.getTerminalOutput(100);
    const processExits = store.getProcessExits(20);
    const ciEvents     = store.getCIEvents(20);
    const deployments  = store.getDeployments(10);
    const causal = await buildCausalChain(logs, network, contexts, undefined, terminal, processExits, ciEvents, deployments);

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
      kind: 'log' | 'warn' | 'error' | 'request' | 'context' | 'terminal' | 'process_exit';
      summary: string;
      source?: string;
    };

    const terminal    = store.getTerminalOutput(limit, undefined, since);
    const processExits = store.getProcessExits(limit, undefined, since);

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
    for (const t of terminal) {
      rows.push({
        ts: t.timestamp,
        isoTs: new Date(t.timestamp).toISOString(),
        kind: 'terminal',
        summary: t.data.slice(0, 200),
        source: t.terminalName,
      });
    }
    for (const p of processExits) {
      rows.push({
        ts: p.timestamp,
        isoTs: new Date(p.timestamp).toISOString(),
        kind: 'process_exit',
        summary: `[${p.process}] exited ${p.exitCode} (${p.reason})${p.signal ? ' · ' + p.signal : ''}`,
        source: p.process,
      });
    }
    rows.sort((a, b) => a.ts - b.ts);

    res.json({ ok: true, windowSeconds: seconds, count: rows.length, rows: rows.slice(-limit) });
  });

  // ── Current version ──────────────────────────────────────────────────────
  // Browser extension fetches this at page-load to auto-discover the deployed
  // SHA without requiring any frontend code changes.
  // Returns the most recent successful deployment event's SHA, if any.
  router.get('/current-version', (_req, res) => {
    const deploys = store.getDeployments(5);
    const latest = deploys.find((d) => d.status === 'success') ?? deploys[0] ?? null;
    res.json({
      ok: true,
      sha: latest?.sha ?? null,
      shortSha: latest?.shortSha ?? (latest?.sha?.slice(0, 7) ?? null),
      environment: latest?.environment ?? null,
      service: latest?.service ?? null,
      deployedAt: latest ? new Date(latest.timestamp).toISOString() : null,
    });
  });

  // ── Unified Timeline ──────────────────────────────────────────────────────
  // The complete cross-signal causal timeline: browser + backend + CI + deploy.
  // This is the single endpoint that makes the Phase 3 pitch demonstrable.
  //
  //   GET /timeline/unified?seconds=300&limit=50
  //
  router.get('/timeline/unified', (req, res) => {
    const seconds = Math.min(3600, Math.max(1, Number(req.query.seconds ?? 300)));
    const limit   = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const since   = Date.now() - seconds * 1000;

    type UnifiedRow = {
      ts: number;
      isoTs: string;
      kind: 'error' | 'warn' | 'log' | 'request' | 'context' | 'terminal' | 'process_exit' | 'ci_failure' | 'ci_success' | 'deployment' | 'backend_span';
      summary: string;
      source: 'browser' | 'backend' | 'ci' | 'deploy';
      sha?: string;
      confidence?: number;
      traceId?: string;
    };

    const rows: UnifiedRow[] = [];

    // Browser signals
    for (const e of store.getLogs(limit, undefined, since)) {
      rows.push({
        ts: e.timestamp, isoTs: new Date(e.timestamp).toISOString(),
        kind: e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'log',
        summary: e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 200),
        source: 'browser',
      });
    }
    for (const n of store.getNetwork(limit, undefined, since)) {
      const fail = n.status >= 400 || n.status === 0 || !!n.error;
      if (!fail) continue; // only failures in unified view — reduce noise
      rows.push({
        ts: n.timestamp, isoTs: new Date(n.timestamp).toISOString(),
        kind: 'request',
        summary: `${n.method} ${n.url} → ${n.status || 'ERR'} ${n.statusText} (${n.duration}ms)${n.error ? ' — ' + n.error : ''}`,
        source: 'browser',
      });
    }

    // Backend signals
    const BACKEND_ERROR_RE = /error|exception|traceback|panic|fatal|killed|oom/i;
    for (const t of store.getTerminalOutput(limit, undefined, since)) {
      if (!BACKEND_ERROR_RE.test(t.data)) continue;
      rows.push({
        ts: t.timestamp, isoTs: new Date(t.timestamp).toISOString(),
        kind: 'terminal',
        summary: `[${t.terminalName}] ${t.data.slice(0, 200)}`,
        source: 'backend',
      });
    }
    for (const p of store.getProcessExits(20, undefined, since)) {
      if (p.reason === 'normal') continue;
      rows.push({
        ts: p.timestamp, isoTs: new Date(p.timestamp).toISOString(),
        kind: 'process_exit',
        summary: `[${p.process}] exited ${p.exitCode} (${p.reason})${p.signal ? ' · ' + p.signal : ''}`,
        source: 'backend',
      });
    }

    // CI signals
    for (const c of store.getCIEvents(50, undefined, since)) {
      rows.push({
        ts: c.timestamp, isoTs: new Date(c.timestamp).toISOString(),
        kind: c.status === 'failure' ? 'ci_failure' : 'ci_success',
        summary: c.status === 'failure'
          ? `CI failed: ${c.job}${c.workflow ? ' (' + c.workflow + ')' : ''}${c.failedTests && c.failedTests.length > 0 ? ' — ' + c.failedTests.slice(0, 3).map(t => t.name).join(', ') : ''}`
          : `CI passed: ${c.job}${c.workflow ? ' (' + c.workflow + ')' : ''}`,
        source: 'ci',
        sha: c.shortSha ?? c.sha.slice(0, 7),
      });
    }

    // Deployment signals
    for (const d of store.getDeployments(20, undefined, since)) {
      rows.push({
        ts: d.timestamp, isoTs: new Date(d.timestamp).toISOString(),
        kind: 'deployment',
        summary: `Deploy to ${d.environment}: ${d.status}${d.service ? ' (' + d.service + ')' : ''}${d.actor ? ' by ' + d.actor : ''}`,
        source: 'deploy',
        sha: d.shortSha ?? d.sha.slice(0, 7),
      });
    }

    // Backend SDK spans
    const browserTraceIds = new Set(
      store.getNetwork(200, undefined, since)
        .filter(n => n.traceId)
        .map(n => n.traceId as string),
    );
    for (const s of store.getBackendSpans(limit, undefined, since)) {
      const joined = browserTraceIds.has(s.traceId);
      rows.push({
        ts: s.timestamp, isoTs: new Date(s.timestamp).toISOString(),
        kind: 'backend_span',
        summary: `[${s.service}] ${s.method} ${s.route} → ${s.statusCode} (${s.durationMs}ms)${s.error ? ' — ' + s.error : ''}`,
        source: 'backend',
        confidence: joined ? 1.0 : 0.5,
        traceId: s.traceId,
      });
    }

    rows.sort((a, b) => a.ts - b.ts);

    // Root cause — pull from hypothesis history
    const latest = hypothesisHistory.latest();
    const topHyp = latest?.topHypothesis ?? null;
    const statsByTag = new Map(getStats().map((s) => [s.tag, s]));
    const rootCause = topHyp
      ? {
          hypothesis: topHyp.summary,
          tag: topHyp.tag,
          confidence: topHyp.confidenceScore,
          fixHint: topHyp.fixHint,
          builtAt: latest?.builtAt,
          calibration: statsByTag.get(topHyp.tag) ?? null,
        }
      : null;

    res.json({
      ok: true,
      windowSeconds: seconds,
      count: rows.length,
      rootCause,
      rows: rows.slice(-limit),
    });
  });

  // ── Process watchers ─────────────────────────────────────────────────────
  // Start/stop/list process watchers — lets the AI or VS Code panel
  // attach Mergen to any running dev server without code changes.

  router.get('/watchers', (_req, res) => {
    res.json({
      ok: true,
      processes: listProcessWatchers(),
      containers: listStreamedContainers(),
    });
  });

  router.post('/watchers/start', (req, res) => {
    const { name, command, args, cwd } = (req.body ?? {}) as {
      name?: string; command?: string; args?: string[]; cwd?: string;
    };
    if (!command || typeof command !== 'string') {
      res.status(400).json({ error: 'command is required' }); return;
    }
    const watcherName = (typeof name === 'string' && name.trim()) ? name.trim() : command;
    startProcessWatcher({ name: watcherName, command, args, cwd });
    res.json({ ok: true, name: watcherName });
  });

  router.post('/watchers/stop', (req, res) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' }); return;
    }
    stopProcessWatcher(name);
    res.json({ ok: true });
  });

  router.post('/watchers/docker', async (_req, res) => {
    await startDockerLogStream();
    res.json({ ok: true, containers: listStreamedContainers() });
  });

  router.delete('/watchers/docker', (_req, res) => {
    stopDockerLogStream();
    res.json({ ok: true });
  });

  // ── Mark capture start ────────────────────────────────────────────────────
  // Records a timestamp bookmark so the AI and VS Code panel can filter
  // events to "only what happened since I clicked Start Capture".
  let _captureMarkTs: number | null = null;

  router.post('/mark', (_req, res) => {
    _captureMarkTs = Date.now();
    res.json({ ok: true, timestamp: _captureMarkTs, iso: new Date(_captureMarkTs).toISOString() });
  });

  router.get('/mark', (_req, res) => {
    res.json({ ok: true, timestamp: _captureMarkTs, iso: _captureMarkTs ? new Date(_captureMarkTs).toISOString() : null });
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

  // ── Postmortem export ─────────────────────────────────────────────────────
  // GET /export/incident?from=<unix-ms>&to=<unix-ms>&sha=<sha>&format=md|json
  // Returns a structured postmortem document covering all correlated signals
  // in the time window. No auth required — documents are read-only summaries.
  router.get('/export/incident', async (req, res) => {
    const from    = Number(req.query.from) || (Date.now() - 60 * 60 * 1000);
    const to      = Number(req.query.to)   || Date.now();
    const sha     = typeof req.query.sha  === 'string' ? req.query.sha : undefined;
    const format  = req.query.format === 'json' ? 'json' : 'md';

    const window  = { from, to };
    const since   = window.from;

    const logs       = store.getLogs(500, undefined, since).filter((e) => e.timestamp <= to);
    const network    = store.getNetwork(500, undefined, since).filter((e) => e.timestamp <= to);
    const terminal   = store.getTerminalOutput(200, undefined, since).filter((e) => e.timestamp <= to);
    const ciEvents   = store.getCIEvents(50, undefined, since).filter((e) => e.timestamp <= to);
    const deployments= store.getDeployments(20, undefined, since).filter((e) => e.timestamp <= to);
    const exits      = store.getProcessExits(20, undefined, since).filter((e) => e.timestamp <= to);

    const filteredDeploy = sha
      ? deployments.filter((d) => d.sha?.startsWith(sha) || sha.startsWith(d.sha?.slice(0, 7) ?? ''))
      : deployments;

    const latest = hypothesisHistory.latest();
    const topHyp = latest?.topHypothesis ?? null;

    const errors  = logs.filter((e) => e.level === 'error');
    const warns   = logs.filter((e) => e.level === 'warn');
    const netFail = network.filter((n) => n.status >= 400 || n.status === 0);

    const affectedServices = [
      ...new Set([
        ...netFail.map((n) => { try { return new URL(n.url).hostname; } catch { return n.url; } }),
        ...terminal.filter((t) => /error|exception|fatal/i.test(t.data)).map((t) => t.terminalName),
      ]),
    ];

    if (format === 'json') {
      res.json({
        ok: true, generated_at: new Date().toISOString(),
        window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
        sha, topHypothesis: topHyp, affectedServices,
        summary: { errors: errors.length, warnings: warns.length, networkFailures: netFail.length },
        deployments: filteredDeploy, ciEvents, timeline: logs.concat(network as never[]).sort((a, b) => a.timestamp - b.timestamp),
      });
      return;
    }

    // Markdown format
    const lines: string[] = [];
    const startIso = new Date(from).toISOString();
    const endIso   = new Date(to).toISOString();
    const depRef   = filteredDeploy[0];

    lines.push(`# Incident Postmortem — ${startIso.slice(0, 10)}`);
    lines.push('');
    if (topHyp) {
      lines.push(`**Root Cause**`);
      lines.push(`${topHyp.summary}`);
      if (topHyp.evidence && topHyp.evidence.length > 0) {
        lines.push('');
        lines.push(`**Evidence**`);
        for (const ev of topHyp.evidence) lines.push(`- ${ev}`);
      }
    }
    lines.push('');
    lines.push(`**Window:** ${startIso.slice(11, 19)} → ${endIso.slice(11, 19)} UTC`);
    if (depRef) lines.push(`**SHA:** \`${depRef.shortSha ?? depRef.sha.slice(0, 7)}\` — deployed to ${depRef.environment}${depRef.actor ? ' by ' + depRef.actor : ''}`);
    if (topHyp?.fixHint) lines.push(`**Fix:** ${topHyp.fixHint}`);
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    lines.push(`| Signal | Count |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Browser errors | ${errors.length} |`);
    lines.push(`| Warnings | ${warns.length} |`);
    lines.push(`| Network failures | ${netFail.length} |`);
    lines.push(`| CI failures | ${ciEvents.filter((c) => c.status === 'failure').length} |`);
    lines.push(`| Deployments | ${filteredDeploy.length} |`);
    lines.push('');

    if (affectedServices.length > 0) {
      lines.push('## Affected Services');
      lines.push('');
      for (const svc of affectedServices) lines.push(`- ${svc}`);
      lines.push('');
    }

    lines.push('## Timeline');
    lines.push('');
    lines.push('| Time | Source | Event |');
    lines.push('|------|--------|-------|');

    type Row = { ts: number; src: string; msg: string };
    const rows: Row[] = [];
    for (const c of ciEvents)       rows.push({ ts: c.timestamp, src: 'CI', msg: `${c.status === 'failure' ? '❌' : '✅'} ${c.job}${c.failedTests?.length ? ' — ' + c.failedTests.slice(0,2).map(t=>t.name).join(', ') : ''}` });
    for (const d of filteredDeploy) rows.push({ ts: d.timestamp, src: 'Deploy', msg: `🚀 Deployed to ${d.environment}: ${d.status}${d.actor ? ' by ' + d.actor : ''}` });
    for (const e of errors)          rows.push({ ts: e.timestamp, src: 'Browser', msg: `🔴 ${e.args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' ').slice(0,100)}` });
    for (const n of netFail)         rows.push({ ts: n.timestamp, src: 'Network', msg: `${n.method} ${n.url} → ${n.status} (${n.duration}ms)` });
    for (const t of terminal.filter(t=>/error|exception|fatal/i.test(t.data))) rows.push({ ts: t.timestamp, src: t.terminalName, msg: t.data.slice(0, 100) });
    for (const p of exits.filter(p=>p.reason!=='normal')) rows.push({ ts: p.timestamp, src: p.process, msg: `💥 Exited ${p.exitCode} (${p.reason})` });
    rows.sort((a, b) => a.ts - b.ts);

    for (const r of rows) {
      const t = new Date(r.ts).toISOString().slice(11, 19);
      lines.push(`| ${t} | ${r.src} | ${r.msg.replace(/\|/g, '/')} |`);
    }
    lines.push('');

    if (topHyp?.evidence?.length) {
      lines.push('## Evidence');
      lines.push('');
      for (const e of topHyp.evidence) lines.push(`- ${e}`);
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Generated by Mergen at ${new Date().toISOString()}*`);

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(lines.join('\n'));
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

  // ── SDK Status ───────────────────────────────────────────────────────────
  // Returns active backend SDK connections (Node.js / Python services).
  // Scans recent console events for mergen://node/* and mergen://python/* URLs.
  router.get('/sdk-status', (_req, res) => {
    const logs = store.getLogs(500);
    const spans = store.getBackendSpans(200);
    const services = new Map<string, { sdk: string; lastSeen: number; errorCount: number; spanCount: number }>();

    for (const e of logs) {
      if (!e.url?.startsWith('mergen://node/') && !e.url?.startsWith('mergen://python/')) continue;
      const parts = e.url.split('/');
      const sdk  = parts[2] ?? 'unknown';
      const name = parts[3] ?? 'unknown';
      const key  = `${sdk}/${name}`;
      const prev = services.get(key);
      services.set(key, {
        sdk,
        lastSeen: Math.max(e.timestamp, prev?.lastSeen ?? 0),
        errorCount: (prev?.errorCount ?? 0) + (e.level === 'error' ? 1 : 0),
        spanCount: prev?.spanCount ?? 0,
      });
    }
    for (const s of spans) {
      const key = `${s.sdk}/${s.service}`;
      const prev = services.get(key);
      services.set(key, {
        sdk: s.sdk,
        lastSeen: Math.max(s.timestamp, prev?.lastSeen ?? 0),
        errorCount: (prev?.errorCount ?? 0) + (s.statusCode >= 400 ? 1 : 0),
        spanCount: (prev?.spanCount ?? 0) + 1,
      });
    }

    res.json({ ok: true, services: Object.fromEntries(services) });
  });

  // ── Trace detail ─────────────────────────────────────────────────────────
  // Returns all events sharing a single W3C traceId:
  // the browser network event + backend spans + backend log lines.
  router.get('/trace/:traceId', (req, res) => {
    const traceId = req.params['traceId']?.toLowerCase();
    if (!traceId || !/^[0-9a-f]{32}$/.test(traceId)) {
      res.status(400).json({ error: 'invalid traceId — must be 32 hex chars' });
      return;
    }

    const browserNet   = store.getNetwork(200).filter(n => n.traceId?.toLowerCase() === traceId);
    const backendSpans = store.getBackendSpans(50).filter(s => s.traceId.toLowerCase() === traceId);
    const backendLogs  = store.getTerminalOutput(200).filter(t => t.traceId?.toLowerCase() === traceId);

    const found = browserNet.length + backendSpans.length + backendLogs.length > 0;
    res.json({ ok: true, traceId, found, browserNet, backendSpans, backendLogs });
  });

  return router;
}
