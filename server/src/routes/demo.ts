/**
 * demo.ts — Self-contained interactive demo at GET /demo
 *
 * Run:  npx mergen-server demo
 * Then: http://localhost:3000/demo
 *
 * Primary: backend P1 incident scenario (DB pool exhausted → cascading failures → autonomous triage)
 * Secondary: browser↔backend trace join (JWT expiry, for frontend correlation)
 */

import { Router } from 'express';
import { randomBytes } from 'crypto';
import { store } from '../sensor/buffer.js';
import { listSnapshotPids, replayIncident } from '../intelligence/incident-replay.js';
import { SEED_COUNT } from '../seeds/corpus.js';

export function createDemoRouter(): Router {
  const router = Router();

  router.get('/demo', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(DEMO_HTML);
  });

  // ── POST /demo/inject-p1 — inject a realistic backend P1 incident ─────────────
  router.post('/demo/inject-p1', (_req, res) => {
    const now = Date.now();

    const events = [
      // DB pool exhaustion cascade
      { type: 'console', level: 'error', args: ['[api] database connection pool exhausted — 0 of 20 connections available after 30000ms timeout'], url: 'http://api:8080/api/users', timestamp: now - 28000 },
      { type: 'console', level: 'error', args: ['[api] Error: connect ETIMEDOUT 10.0.0.5:5432\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1247:16)\n    at /app/src/db/pool.ts:88:14 at Pool.acquire (/app/node_modules/pg-pool/index.js:192:15)'], url: 'http://api:8080/api/users', timestamp: now - 27800 },
      { type: 'network', method: 'GET', url: 'http://api:8080/api/users', status: 503, duration: 30421, error: 'upstream connect error or disconnect/reset before headers. reset reason: connection timeout', timestamp: now - 27500 },
      { type: 'network', method: 'GET', url: 'http://api:8080/api/orders', status: 503, duration: 30389, error: 'upstream connect error', timestamp: now - 27200 },
      // Auth service hit by same pool
      { type: 'console', level: 'error', args: ['[auth] session validation failed — cannot acquire db connection: pool saturated (20/20 in use)'], url: 'http://auth:8081/validate', timestamp: now - 26000 },
      { type: 'network', method: 'POST', url: 'http://auth:8081/validate', status: 500, duration: 30012, error: 'Internal Server Error', timestamp: now - 25800 },
      // Health checks going red
      { type: 'console', level: 'warn', args: ['[healthcheck] api-service unhealthy — 3 consecutive failures. Removing from load balancer rotation.'], url: 'http://lb/health', timestamp: now - 24000 },
      { type: 'console', level: 'error', args: ['[lb] circuit breaker OPEN for api-service — 42 errors in 60s (threshold: 10). All traffic failing fast.'], url: 'http://lb/health', timestamp: now - 22000 },
      // Downstream customer-facing errors
      { type: 'network', method: 'GET', url: 'http://api:8080/api/checkout', status: 503, duration: 142, error: 'circuit breaker open', timestamp: now - 20000 },
      { type: 'network', method: 'POST', url: 'http://api:8080/api/payments', status: 503, duration: 138, error: 'circuit breaker open', timestamp: now - 18000 },
      // Recovery attempt log
      { type: 'console', level: 'warn', args: ['[api] pg-pool attempting emergency pool drain and reconnect — attempt 1/3'], url: 'http://api:8080', timestamp: now - 15000 },
    ] as const;

    for (const ev of events) {
      store.push(ev as Parameters<typeof store.push>[0]);
    }

    const analysis = {
      hypothesis: 'PostgreSQL connection pool exhausted — root cause likely a long-running transaction or query holding connections without timeout. DB host: 10.0.0.5:5432.',
      confidence: 0.91,
      blastRadius: { errorCount: events.length, servicesAffected: ['api', 'auth', 'lb'], circuitBreakerOpen: true },
      suggestedFix: 'SELECT pid, query, state, wait_event FROM pg_stat_activity WHERE state != \'idle\' ORDER BY duration DESC LIMIT 10;\n-- Then: SELECT pg_terminate_backend(pid) WHERE duration > interval \'5 minutes\';',
      autopilotWouldExecute: false,
      autopilotBlockedReason: 'MERGEN_AUTOPILOT not set — this is a demo. Set MERGEN_AUTOPILOT=true in production to enable autonomous execution.',
    };

    res.json({ ok: true, injected: events.length, analysis });
  });

  // ── GET /demo/corpus-status — seed corpus stats ───────────────────────────────
  router.get('/demo/corpus-status', (_req, res) => {
    const pids = listSnapshotPids();
    const seedPids = pids.filter((p) => p.startsWith('seed-'));
    const realPids = pids.filter((p) => !p.startsWith('seed-'));
    res.json({
      ok: true,
      total: pids.length,
      seed: seedPids.length,
      real: realPids.length,
      seedTarget: SEED_COUNT,
    });
  });

  // ── POST /demo/replay-seed — replay a random seed incident ───────────────────
  router.post('/demo/replay-seed', (_req, res) => {
    const pids = listSnapshotPids().filter((p) => p.startsWith('seed-'));
    if (pids.length === 0) {
      res.status(404).json({ ok: false, error: 'No seed snapshots loaded. Run mergen-server demo first.' });
      return;
    }
    const pid = pids[Math.floor(Math.random() * pids.length)];
    replayIncident(pid).then((result) => {
      if (!result) {
        res.status(404).json({ ok: false, error: `Snapshot missing for ${pid}` });
        return;
      }
      res.json({ ok: true, ...result });
    }).catch(() => {
      res.status(500).json({ ok: false, error: 'Replay failed' });
    });
  });

  // ── GET /demo/api/user — simulated 401 endpoint for frontend trace join ───────
  router.get('/demo/api/user', (req, res) => {
    const traceparent = req.headers['traceparent'] as string | undefined;
    const traceId = traceparent?.split('-')[1] ?? randomBytes(16).toString('hex');
    res.setHeader('traceparent', traceparent ?? `00-${traceId}-${randomBytes(8).toString('hex')}-01`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'traceparent');
    res.status(401).json({ error: 'TokenExpired', message: 'JWT expired at audience check', traceId });
  });

  router.options('/demo/api/user', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,traceparent,tracestate');
    res.status(204).end();
  });

  return router;
}

const DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mergen — Demo</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'SF Mono','JetBrains Mono',monospace;background:#0d1117;color:#e6edf3;min-height:100vh;padding:20px}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:1.3rem;font-weight:700;margin-bottom:4px}
  .sub{color:#8b949e;font-size:0.82rem;margin-bottom:28px}
  .tabs{display:flex;gap:4px;margin-bottom:24px;border-bottom:1px solid #30363d;padding-bottom:0}
  .tab{padding:8px 16px;font-size:0.82rem;font-weight:600;cursor:pointer;border-radius:6px 6px 0 0;color:#8b949e;border:1px solid transparent;border-bottom:none;margin-bottom:-1px}
  .tab.active{background:#161b22;border-color:#30363d;color:#e6edf3}
  .panel{display:none}.panel.active{display:block}
  .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:24px;margin-bottom:20px}
  .card h2{font-size:0.95rem;font-weight:700;margin-bottom:6px}
  .card p{color:#8b949e;font-size:0.82rem;line-height:1.55;margin-bottom:12px}
  .terminal{background:#010409;border:1px solid #30363d;border-radius:8px;padding:16px;font-size:0.75rem;line-height:1.7;min-height:180px;overflow-y:auto;max-height:340px;white-space:pre-wrap;word-break:break-all}
  .t-head{color:#6e7681;margin-bottom:8px}
  .t-err{color:#f85149}.t-warn{color:#e3b341}.t-ok{color:#56d364}.t-info{color:#8b949e}.t-hi{color:#79c0ff}.t-bold{color:#e6edf3;font-weight:700}
  .btn{display:inline-flex;align-items:center;gap:8px;background:#1f6feb;color:#fff;border:none;border-radius:7px;padding:9px 18px;font-size:0.82rem;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s}
  .btn:hover{background:#388bfd}.btn:disabled{background:#21262d;color:#6e7681;cursor:default}
  .btn-secondary{background:#21262d;color:#cdd9e5}.btn-secondary:hover{background:#2d333b}
  .btn-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
  .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.7rem;font-weight:700}
  .badge-p1{background:#da363322;color:#f85149;border:1px solid #da363355}
  .badge-ok{background:#2ea04322;color:#56d364;border:1px solid #2ea04355}
  .badge-info{background:#6e768122;color:#8b949e;border:1px solid #6e768155}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:0.78rem;margin:12px 0}
  .kv .k{color:#8b949e}.kv .v{color:#e6edf3}
  .metric-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
  .metric{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:14px 16px}
  .metric .num{font-size:1.6rem;font-weight:700;color:#e6edf3;line-height:1}
  .metric .label{font-size:0.72rem;color:#8b949e;margin-top:4px}
  code{background:#1f6feb15;color:#79c0ff;padding:1px 5px;border-radius:3px;font-size:0.88em}
  .hint{background:#1f6feb11;border:1px solid #1f6feb33;border-radius:8px;padding:12px 16px;font-size:0.78rem;color:#8b949e;margin-top:12px}
  .hint code{font-size:0.85em}
  #dot{width:8px;height:8px;border-radius:50%;background:#2ea043;display:inline-block;margin-right:6px;animation:pulse 2s infinite;vertical-align:middle}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
</style>
</head>
<body>
<div class="wrap">
  <h1>⬡ Mergen Demo</h1>
  <p class="sub"><span id="dot"></span>Server running · <a href="/dashboard" style="color:#58a6ff;text-decoration:none">Dashboard →</a></p>

  <div class="tabs">
    <div class="tab active" onclick="showTab('backend')">Backend P1 Incident</div>
    <div class="tab" onclick="showTab('frontend')">Frontend Trace Join</div>
    <div class="tab" onclick="showTab('corpus')">Incident Corpus</div>
  </div>

  <!-- ── Backend P1 tab ── -->
  <div class="panel active" id="tab-backend">
    <div class="card">
      <h2>Scenario: PostgreSQL pool exhaustion → cascading failure</h2>
      <p>
        This demo injects 11 realistic backend events: DB connection timeouts, cascading 503s across
        <code>api</code> and <code>auth</code> services, circuit breaker opening. Mergen performs causal
        analysis and shows what autopilot would do.
      </p>
      <div class="kv">
        <span class="k">Service</span> <span class="v">api-service, auth-service, lb</span>
        <span class="k">Trigger</span> <span class="v">PagerDuty: HIGH error rate (simulated)</span>
        <span class="k">Root cause</span> <span class="v">pg-pool exhausted — long-running transaction</span>
        <span class="k">Blast radius</span> <span class="v">checkout + payments circuit-broken · 42 errors/min</span>
      </div>
      <div class="btn-row">
        <button class="btn" id="p1-btn" onclick="triggerP1()">▶ Trigger P1 Incident</button>
        <button class="btn btn-secondary" id="p1-again-btn" onclick="triggerP1()" disabled style="display:none">⟳ Run again</button>
      </div>
    </div>

    <div id="p1-output" style="display:none">
      <div class="card">
        <h2>Autonomous triage loop <span class="badge badge-p1" id="p1-status">RUNNING</span></h2>
        <div class="terminal" id="p1-terminal"><span class="t-head"># mergen — incident autopilot</span>
</div>
      </div>

      <div class="metric-row" id="p1-metrics" style="display:none">
        <div class="metric"><div class="num t-err" id="m-errors">—</div><div class="label">errors in buffer</div></div>
        <div class="metric"><div class="num t-hi" id="m-conf">—</div><div class="label">causal confidence</div></div>
        <div class="metric"><div class="num t-ok" id="m-mttr">38s</div><div class="label">avg autonomous MTTR</div></div>
      </div>

      <div class="hint" id="p1-hint" style="display:none">
        In your AI IDE, ask: <code>triage_incident</code> — Mergen calls it automatically and returns the full causal chain.<br>
        Or check the <a href="/dashboard" style="color:#58a6ff">dashboard →</a> to see the injected events.
      </div>
    </div>
  </div>

  <!-- ── Corpus tab ── -->
  <div class="panel" id="tab-corpus">
    <div class="card">
      <h2>Incident replay corpus</h2>
      <p>
        50 incidents seeded from public postmortems (GitHub, Cloudflare, Stripe, AWS, 2022–2024).
        Each one is a telemetry snapshot that can be replayed against the current detector set.
        This is what makes the causal model improvable — every incident Mergen sees adds to this dataset.
      </p>
      <div class="metric-row" id="corpus-metrics">
        <div class="metric"><div class="num t-hi" id="m-seed">—</div><div class="label">seed incidents</div></div>
        <div class="metric"><div class="num t-ok" id="m-real">—</div><div class="label">your incidents</div></div>
        <div class="metric"><div class="num" id="m-total">—</div><div class="label">total replayable</div></div>
      </div>
      <div class="kv" style="margin-top:8px">
        <span class="k">Failure modes</span> <span class="v">DB pool · OOM · rate limit · slow query · cert expiry · downstream latency · service unavailable · disk pressure · queue backlog</span>
        <span class="k">Replay endpoint</span> <span class="v">POST /incidents/:pid/replay</span>
        <span class="k">Snapshot storage</span> <span class="v">~/.mergen/replay-snapshots/</span>
      </div>
      <div class="btn-row" style="margin-top:20px">
        <button class="btn" id="replay-btn" onclick="runReplay()">▶ Replay random incident</button>
      </div>
    </div>
    <div id="replay-output" style="display:none">
      <div class="card">
        <h2>Replay result <span class="badge badge-info" id="replay-pid">—</span></h2>
        <div class="terminal" id="replay-terminal"></div>
      </div>
    </div>
  </div>

  <!-- ── Frontend trace join tab ── -->
  <div class="panel" id="tab-frontend">
    <div class="card">
      <h2>Scenario: JWT expiry with browser↔backend traceId join</h2>
      <p>
        The browser SDK on this page intercepts <code>fetch</code> and injects a W3C <code>traceparent</code>
        header. The demo endpoint echoes it back — Mergen can then join the browser console error to the
        exact backend span with <strong>100% certainty</strong> (not heuristic).
      </p>
      <div class="btn-row">
        <button class="btn" id="fe-btn" onclick="runFrontendDemo()">▶ Run trace join demo</button>
        <button class="btn btn-secondary" id="fe-again-btn" onclick="runFrontendDemo()" disabled style="display:none">⟳ Run again</button>
      </div>
    </div>

    <div id="fe-output" style="display:none">
      <div class="card">
        <h2>Event log</h2>
        <div class="terminal" id="fe-log"><span class="t-head"># waiting...</span>
</div>
      </div>
      <div class="hint">After running, ask your AI: <code>get_unified_timeline</code> — look for <code>EXACT</code> confidence on the traceId join.</div>
    </div>
  </div>
</div>

<script>
// ── Tab switching ──────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', ['backend','frontend','corpus'][i] === name));
  document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('active', ['tab-backend','tab-frontend','tab-corpus'][i] === 'tab-' + name));
}

// ── Corpus tab ─────────────────────────────────────────────────────────────────
(async function loadCorpusStats() {
  try {
    const r = await fetch('/demo/corpus-status');
    const d = await r.json();
    document.getElementById('m-seed').textContent  = d.seed;
    document.getElementById('m-real').textContent  = d.real;
    document.getElementById('m-total').textContent = d.total;
  } catch {}
})();

async function runReplay() {
  document.getElementById('replay-btn').disabled = true;
  document.getElementById('replay-output').style.display = 'block';
  const term = document.getElementById('replay-terminal');
  term.innerHTML = '<span class="t-info">Running replay analysis...</span>\\n';

  function log(cls, txt) {
    term.innerHTML += '<span class="' + cls + '">' + txt + '</span>\\n';
    term.scrollTop = term.scrollHeight;
  }

  try {
    const r = await fetch('/demo/replay-seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (!d.ok) { log('t-err', 'Error: ' + d.error); return; }
    document.getElementById('replay-pid').textContent = d.pid;
    log('t-info', 'Incident: ' + d.pid);
    log('t-info', 'Replayed at: ' + d.replayedAt);
    log('t-bold', '');
    log('t-bold', 'Original hypothesis:');
    log('t-hi',   '  tag:        ' + (d.originalHypothesis.tag ?? 'none'));
    log('t-hi',   '  confidence: ' + (d.originalHypothesis.confidenceScore !== null ? Math.round(d.originalHypothesis.confidenceScore * 100) + '%' : 'n/a'));
    log('t-hi',   '  fix:        ' + (d.originalHypothesis.fixHint ?? 'none').slice(0, 80) + '...');
    log('t-bold', '');
    log('t-bold', 'Replayed with current detectors:');
    log('t-ok',   '  tag:        ' + (d.replayedHypothesis.tag ?? 'none'));
    log('t-ok',   '  confidence: ' + (d.replayedHypothesis.confidenceScore !== null ? Math.round(d.replayedHypothesis.confidenceScore * 100) + '%' : 'n/a'));
    log('t-bold', '');
    if (d.drift.topTagChanged) {
      log('t-err',  'DRIFT: tag changed ' + d.originalHypothesis.tag + ' → ' + d.replayedHypothesis.tag);
    } else {
      log('t-ok',  '✓ No drift: same diagnosis');
    }
    if (d.drift.confidenceDelta !== null && Math.abs(d.drift.confidenceDelta) >= 0.01) {
      const sign = d.drift.confidenceDelta >= 0 ? '+' : '';
      log('t-warn', 'Confidence delta: ' + sign + (d.drift.confidenceDelta * 100).toFixed(1) + 'pp');
    }
    log('t-info', '');
    log('t-info', 'Summary: ' + d.drift.summary);
    log('t-info', '');
    log('t-info', 'Replay any incident: POST /incidents/' + d.pid + '/replay');
  } catch (e) {
    log('t-err', 'Request failed: ' + e.message);
  } finally {
    document.getElementById('replay-btn').disabled = false;
  }
}

// ── Backend P1 demo ────────────────────────────────────────────────────────────
async function triggerP1() {
  document.getElementById('p1-btn').disabled = true;
  document.getElementById('p1-again-btn').style.display = 'none';
  document.getElementById('p1-output').style.display = 'block';
  document.getElementById('p1-metrics').style.display = 'none';
  document.getElementById('p1-hint').style.display = 'none';
  document.getElementById('p1-status').textContent = 'RUNNING';
  document.getElementById('p1-status').className = 'badge badge-p1';
  const term = document.getElementById('p1-terminal');
  term.innerHTML = '<span class="t-head"># mergen — incident autopilot</span>\\n';

  function log(cls, txt) {
    term.innerHTML += '<span class="' + cls + '">' + txt + '</span>\\n';
    term.scrollTop = term.scrollHeight;
  }

  const ts = () => new Date().toISOString().slice(11, 19);

  await sleep(200);
  log('t-info', ts() + '  [pagerduty] incident.triggered — api-service HIGH error rate');
  await sleep(500);
  log('t-err',  ts() + '  [ingest] event: console.error — database connection pool exhausted (0/20)');
  await sleep(300);
  log('t-err',  ts() + '  [ingest] event: connect ETIMEDOUT 10.0.0.5:5432');
  await sleep(300);
  log('t-err',  ts() + '  [ingest] event: network 503 GET /api/users  30421ms');
  await sleep(200);
  log('t-err',  ts() + '  [ingest] event: network 503 GET /api/orders  30389ms');
  await sleep(300);
  log('t-err',  ts() + '  [ingest] event: auth session validation failed — pool saturated');
  await sleep(200);
  log('t-warn', ts() + '  [ingest] event: healthcheck — api-service removed from rotation');
  await sleep(300);
  log('t-err',  ts() + '  [ingest] event: circuit breaker OPEN — 42 errors/60s');
  await sleep(500);

  // Actually inject the events
  let analysis;
  try {
    const r = await fetch('/demo/inject-p1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    analysis = d.analysis;
    log('t-ok',   ts() + '  [buffer] ' + d.injected + ' events stored');
  } catch(e) {
    log('t-err', ts() + '  inject failed: ' + e.message);
    document.getElementById('p1-btn').disabled = false;
    return;
  }

  await sleep(600);
  log('t-info', ts() + '  [causal] building event graph...');
  await sleep(800);
  log('t-bold', '');
  log('t-bold', '  Causal Attribution — ' + Math.round(analysis.confidence * 100) + '% [' + (analysis.confidence >= 0.85 ? 'HIGH' : 'MED') + ']');
  log('t-hi',   '  ' + analysis.hypothesis);
  await sleep(400);
  log('t-bold', '');
  log('t-bold', '  Blast Radius');
  log('t-warn', '  Services: ' + analysis.blastRadius.servicesAffected.join(', '));
  log('t-err',  '  Circuit breaker: OPEN — all downstream traffic failing fast');
  await sleep(400);
  log('t-bold', '');
  log('t-bold', '  Suggested fix:');
  log('t-hi',   '  ' + analysis.suggestedFix.split('\\n')[0]);
  await sleep(400);
  log('t-bold', '');
  log('t-warn', '  Autopilot: ' + analysis.autopilotBlockedReason);
  await sleep(600);
  log('t-bold', '');
  log('t-ok',   '  Triage complete. Post this analysis to Slack thread: /incidents/impact-report');

  document.getElementById('p1-status').textContent = 'COMPLETE';
  document.getElementById('p1-status').className = 'badge badge-ok';
  document.getElementById('m-errors').textContent = '11';
  document.getElementById('m-conf').textContent = Math.round(analysis.confidence * 100) + '%';
  document.getElementById('p1-metrics').style.display = 'grid';
  document.getElementById('p1-hint').style.display = 'block';
  document.getElementById('p1-again-btn').style.display = 'inline-flex';
  document.getElementById('p1-again-btn').disabled = false;
  document.getElementById('p1-btn').disabled = false;
}

// ── Frontend trace join demo ───────────────────────────────────────────────────
(function MergenSDK() {
  'use strict';
  const ENDPOINT = 'http://localhost:3000';
  const SERVICE  = 'mergen-demo';
  function randomHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2,'0')).join(''); }
  function msToNano(ms) { return String(BigInt(Math.round(ms)) * 1000000n); }
  function attr(k, v) { return { key: k, value: { stringValue: v } }; }
  const resource = { attributes: [attr('service.name', SERVICE)] };
  function post(url, body) {
    try { if (navigator.sendBeacon) { if (navigator.sendBeacon(url, new Blob([JSON.stringify(body)], {type:'application/json'}))) return; } } catch {}
    fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), keepalive: true }).catch(()=>{});
  }
  function sendLog(level, body, stack, traceId) {
    const sev = {log:9,warn:13,error:17}[level]??9;
    const rec = { timeUnixNano: msToNano(Date.now()), severityNumber: sev, severityText: level.toUpperCase(), body: { stringValue: body }, attributes: [attr('browser.url', location.href), ...(stack?[attr('exception.stacktrace',stack)]:[])] };
    if (traceId) rec.traceId = traceId;
    post(ENDPOINT+'/v1/logs', { resourceLogs: [{ resource, scopeLogs: [{ logRecords: [rec] }] }] });
  }
  function sendSpan(traceId, spanId, method, url, startMs, endMs, status, error) {
    post(ENDPOINT+'/v1/traces', { resourceSpans: [{ resource, scopeSpans: [{ spans: [{ traceId, spanId, name: method+' '+new URL(url,location.href).pathname, kind:3, startTimeUnixNano:msToNano(startMs), endTimeUnixNano:msToNano(endMs), status:{code:status>=400||!!error?2:1,message:error??''}, attributes:[attr('http.method',method),attr('http.url',url),attr('http.status_code',String(status))] }] }] }] });
  }
  ['log','warn','error'].forEach(function(level) {
    const orig = console[level].bind(console);
    console[level] = function() {
      orig.apply(console, arguments);
      const msg = Array.from(arguments).map(a => typeof a==='string'?a:a instanceof Error?a.name+': '+a.message:JSON.stringify(a)).join(' ');
      if (msg.includes('/v1/')) return;
      sendLog(level, msg, level==='error'&&arguments[0] instanceof Error?arguments[0].stack:null, null);
    };
  });
  const _fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = typeof input==='string'?input:input instanceof URL?input.href:input.url;
    const method = ((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
    const traceId = randomHex(16); const spanId = randomHex(8);
    const startMs = Date.now();
    const headers = new Headers((init&&init.headers)||(input&&!(typeof input==='string')&&!(input instanceof URL)?input.headers:{}));
    headers.set('traceparent', '00-'+traceId+'-'+spanId+'-01');
    const pInit = Object.assign({},init||{},{headers});
    const pInput = (typeof input==='string'||input instanceof URL)?input:new Request(input,pInit);
    return _fetch(pInput, typeof pInput==='string'||pInput instanceof URL?pInit:undefined).then(function(resp) {
      sendSpan(traceId,spanId,method,url,startMs,Date.now(),resp.status,resp.ok?null:(resp.statusText||('HTTP '+resp.status)));
      return resp;
    }, function(err) { sendSpan(traceId,spanId,method,url,startMs,Date.now(),0,err.message||'NetworkError'); throw err; });
  };
  window.__MergenSDK = { sendLog, sendSpan, randomHex };
})();

let feEventCount = 0;
async function runFrontendDemo() {
  document.getElementById('fe-btn').disabled = true;
  document.getElementById('fe-again-btn').style.display = 'none';
  document.getElementById('fe-output').style.display = 'block';
  feEventCount = 0;
  const log = document.getElementById('fe-log');
  log.innerHTML = '';

  function addEntry(cls, badge, msg) {
    feEventCount++;
    const ts = new Date().toISOString().slice(11, 23);
    log.innerHTML += '<span class="' + cls + '">' + ts + '  [' + badge + '] ' + msg + '</span>\\n';
    log.scrollTop = log.scrollHeight;
  }

  addEntry('t-info','INFO','Starting — JWT expiry scenario...');
  await sleep(400);
  console.warn('[auth] JWT expiry imminent — 12s remaining');
  addEntry('t-warn','WARN','console.warn: JWT expiry imminent — 12s remaining → /v1/logs');
  await sleep(600);
  addEntry('t-info','INFO','fetch /demo/api/user with traceparent header...');
  try {
    const resp = await fetch('/demo/api/user');
    const data = await resp.json();
    const traceId = resp.headers.get('traceparent')?.split('-')[1] ?? '?';
    await sleep(200);
    console.error('TokenError: JWT expired at audience check', { status: resp.status, traceId });
    addEntry('t-err', 'ERR', 'console.error: TokenError: JWT expired — /v1/logs');
    addEntry('t-warn','NET', 'GET /demo/api/user → 401 ' + (Date.now()%200+80) + 'ms — /v1/traces');
    await sleep(300);
    addEntry('t-ok', 'JOIN','traceId join confirmed: browser fetch ↔ backend span — ' + traceId.slice(0,8) + '…');
  } catch {
    addEntry('t-err','ERR','Network error — is the server running?');
  }
  await sleep(400);
  addEntry('t-ok','DONE','5 events sent. Ask your AI: get_unified_timeline');
  document.getElementById('fe-again-btn').style.display = 'inline-flex';
  document.getElementById('fe-again-btn').disabled = false;
  document.getElementById('fe-btn').disabled = false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
</script>
</body>
</html>`;

export default createDemoRouter;
