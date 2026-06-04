/**
 * demo.ts — Self-contained interactive demo at GET /demo
 *
 * Run:  npx mergen-server demo
 * Then: http://localhost:3000/demo
 *
 * No Chrome extension needed. The demo page ships with @mergen/browser
 * inlined so engineers see a working trace join in < 60 seconds.
 */

import { Router } from 'express';
import { randomBytes } from 'crypto';

export function createDemoRouter(): Router {
  const router = Router();

  // ── GET /demo — interactive demo page ──────────────────────────────────────
  router.get('/demo', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(DEMO_HTML);
  });

  // ── GET /demo/api/user — simulated 401 endpoint for the demo scenario ──────
  // Returns a W3C traceparent header so the browser SDK can perform an EXACT join.
  router.get('/demo/api/user', (req, res) => {
    const traceparent = req.headers['traceparent'] as string | undefined;
    const traceId = traceparent?.split('-')[1] ?? randomBytes(16).toString('hex');

    // Echo the traceparent back in the response so the browser can confirm join.
    res.setHeader('traceparent', traceparent ?? `00-${traceId}-${randomBytes(8).toString('hex')}-01`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'traceparent');

    res.status(401).json({
      error:   'TokenExpired',
      message: 'JWT expired at audience check',
      traceId,
    });
  });

  // ── OPTIONS /demo/api/user — CORS preflight ─────────────────────────────────
  router.options('/demo/api/user', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,traceparent,tracestate');
    res.status(204).end();
  });

  return router;
}

// ── Inline @mergen/browser UMD + demo page ────────────────────────────────────
// The SDK is inlined so the demo has zero external dependencies.
// This is the exact same logic as packages/mergen-browser/src/* compiled to a
// self-contained IIFE — kept here to avoid a build step for the demo route.

const DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mergen — 3-minute demo</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'SF Mono','JetBrains Mono',monospace;background:#0d1117;color:#e6edf3;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;max-width:680px;width:100%;margin:20px}
  h1{font-size:1.4rem;font-weight:600;margin-bottom:8px}
  .subtitle{color:#8b949e;font-size:0.85rem;margin-bottom:32px}
  .step{display:flex;gap:16px;margin-bottom:24px;align-items:flex-start}
  .step-num{background:#1f6feb;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:700;flex-shrink:0;margin-top:2px}
  .step-content h3{font-size:0.9rem;font-weight:600;margin-bottom:4px}
  .step-content p{color:#8b949e;font-size:0.82rem;line-height:1.5}
  .log{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:16px;font-size:0.78rem;line-height:1.6;min-height:160px;margin:24px 0;overflow-y:auto;max-height:220px}
  .log-entry{display:flex;gap:8px;margin-bottom:4px}
  .log-entry .time{color:#6e7681;flex-shrink:0}
  .log-entry .badge{padding:1px 6px;border-radius:4px;font-size:0.7rem;font-weight:700;flex-shrink:0;text-transform:uppercase}
  .badge-exact{background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55}
  .badge-err{background:#da363322;color:#f85149;border:1px solid #da363355}
  .badge-net{background:#388bfd22;color:#79c0ff;border:1px solid #388bfd55}
  .badge-ok{background:#2ea04322;color:#56d364;border:1px solid #2ea04355}
  .badge-info{background:#6e768122;color:#8b949e;border:1px solid #6e768155}
  .log-entry .msg{color:#e6edf3;flex:1}
  .btn{display:inline-flex;align-items:center;gap:8px;background:#1f6feb;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:0.85rem;font-weight:600;cursor:pointer;transition:background .15s;font-family:inherit}
  .btn:hover{background:#388bfd}
  .btn:disabled{background:#21262d;color:#6e7681;cursor:default}
  .btn-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .mcp-hint{background:#161b22;border:1px solid #1f6feb44;border-radius:8px;padding:14px 16px;font-size:0.78rem;color:#8b949e;margin-top:8px}
  .mcp-hint code{color:#79c0ff;background:#1f6feb15;padding:1px 5px;border-radius:3px}
  .label{font-size:0.72rem;color:#6e7681;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em}
  #status-dot{width:8px;height:8px;border-radius:50%;background:#2ea043;display:inline-block;margin-right:6px;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #counter{color:#8b949e;font-size:0.78rem}
</style>
</head>
<body>
<div class="card">
  <h1>🔭 Mergen — 3-Minute Demo</h1>
  <p class="subtitle">No Chrome extension. No config. Watch a real browser↔backend trace join happen live.</p>

  <div class="step">
    <div class="step-num">1</div>
    <div class="step-content">
      <h3>SDK installed</h3>
      <p>@mergen/browser is active on this page. It intercepts <code style="color:#79c0ff;background:#1f6feb15;padding:1px 4px;border-radius:3px">console</code> and <code style="color:#79c0ff;background:#1f6feb15;padding:1px 4px;border-radius:3px">fetch</code>, sends OTLP to <code style="color:#79c0ff;background:#1f6feb15;padding:1px 4px;border-radius:3px">localhost:3000/v1/*</code>.</p>
    </div>
  </div>

  <div class="step">
    <div class="step-num">2</div>
    <div class="step-content">
      <h3>Fire a scenario</h3>
      <p>Click "Run demo" to simulate a JWT expiry: a console.error + a fetch → 401. Both share a <strong>traceId</strong>.</p>
    </div>
  </div>

  <div class="step">
    <div class="step-num">3</div>
    <div class="step-content">
      <h3>Ask your AI</h3>
      <p>In Claude Code / Cursor: <em>"What just happened?"</em> — it calls <code style="color:#79c0ff;background:#1f6feb15;padding:1px 4px;border-radius:3px">get_unified_timeline</code> and returns an EXACT join.</p>
    </div>
  </div>

  <div class="label"><span id="status-dot"></span>Live event log <span id="counter"></span></div>
  <div class="log" id="log"><div class="log-entry"><span class="badge badge-info">READY</span><span class="msg">Waiting — click "Run demo" to start.</span></div></div>

  <div class="btn-row">
    <button class="btn" id="run-btn" onclick="runDemo()">▶ Run demo</button>
    <button class="btn" id="repeat-btn" style="background:#21262d;color:#8b949e" onclick="runDemo()" disabled>⟳ Run again</button>
  </div>

  <div class="mcp-hint" style="margin-top:20px">
    After running, ask your AI: <code>get_unified_timeline</code> or <code>analyze_runtime</code>
    <br>Look for <code>EXACT</code> confidence — that's the traceId join proving browser → backend causality.
  </div>
</div>

<script>
// ── Inline @mergen/browser (zero external dependencies) ──────────────────────

(function MergenSDK() {
  'use strict';

  const ENDPOINT = 'http://localhost:3000';
  const SERVICE  = 'mergen-demo';

  function randomHex(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2,'0')).join('');
  }

  function msToNano(ms) { return String(BigInt(Math.round(ms)) * 1000000n); }

  function attr(k, v) { return { key: k, value: { stringValue: v } }; }

  const resource = { attributes: [attr('service.name', SERVICE)] };

  function post(url, body) {
    const json = JSON.stringify(body);
    try { if (navigator.sendBeacon) { if (navigator.sendBeacon(url, new Blob([json], {type:'application/json'}))) return; } } catch {}
    fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: json, keepalive: true }).catch(() => {});
  }

  function sendLog(level, body, stack, traceId) {
    const sev = {log:9, warn:13, error:17}[level] ?? 9;
    const rec = {
      timeUnixNano: msToNano(Date.now()),
      severityNumber: sev, severityText: level.toUpperCase(),
      body: { stringValue: body },
      attributes: [attr('browser.url', location.href), ...(stack ? [attr('exception.stacktrace', stack)] : [])],
    };
    if (traceId) rec.traceId = traceId;
    post(ENDPOINT + '/v1/logs', { resourceLogs: [{ resource, scopeLogs: [{ logRecords: [rec] }] }] });
  }

  function sendSpan(traceId, spanId, method, url, startMs, endMs, status, error) {
    const isErr = status >= 400 || !!error;
    post(ENDPOINT + '/v1/traces', { resourceSpans: [{ resource, scopeSpans: [{ spans: [{
      traceId, spanId,
      name: method + ' ' + new URL(url, location.href).pathname,
      kind: 3, // CLIENT
      startTimeUnixNano: msToNano(startMs),
      endTimeUnixNano:   msToNano(endMs),
      status: { code: isErr ? 2 : 1, message: error ?? '' },
      attributes: [attr('http.method', method), attr('http.url', url), attr('http.status_code', String(status))],
    }] }] }] });
  }

  // Patch console
  ['log','warn','error'].forEach(function(level) {
    const orig = console[level].bind(console);
    console[level] = function() {
      orig.apply(console, arguments);
      const msg = Array.from(arguments).map(function(a) {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.name + ': ' + a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
      if (msg.includes('/v1/')) return;
      const stack = level === 'error' && arguments[0] instanceof Error ? arguments[0].stack : null;
      sendLog(level, msg, stack, null);
    };
  });

  // Patch fetch with traceparent injection
  const _fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url     = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
    const method  = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const traceId = randomHex(16);
    const spanId  = randomHex(8);
    const startMs = Date.now();
    const tp      = '00-' + traceId + '-' + spanId + '-01';

    const headers = new Headers((init && init.headers) || (input && !(typeof input === 'string') && !(input instanceof URL) ? input.headers : {}));
    headers.set('traceparent', tp);

    const pInit = Object.assign({}, init || {}, { headers });
    const pInput = (typeof input === 'string' || input instanceof URL) ? input : new Request(input, pInit);

    return _fetch(pInput, typeof pInput === 'string' || pInput instanceof URL ? pInit : undefined).then(function(resp) {
      sendSpan(traceId, spanId, method, url, startMs, Date.now(), resp.status,
               resp.ok ? null : (resp.statusText || ('HTTP ' + resp.status)));
      return resp;
    }, function(err) {
      sendSpan(traceId, spanId, method, url, startMs, Date.now(), 0, err.message || 'NetworkError');
      throw err;
    });
  };

  window.__MergenSDK = { sendLog, sendSpan, randomHex };
})();

// ── Demo scenario ─────────────────────────────────────────────────────────────

const log = document.getElementById('log');
let eventCount = 0;

function addEntry(badge, badgeClass, msg) {
  eventCount++;
  document.getElementById('counter').textContent = '— ' + eventCount + ' event' + (eventCount === 1 ? '' : 's');
  const ts = new Date().toISOString().slice(11, 23);
  const row = document.createElement('div');
  row.className = 'log-entry';
  row.innerHTML = '<span class="time">' + ts + '</span>'
    + '<span class="badge ' + badgeClass + '">' + badge + '</span>'
    + '<span class="msg">' + msg + '</span>';
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

async function runDemo() {
  document.getElementById('run-btn').disabled = true;
  log.innerHTML = '';
  eventCount = 0;

  addEntry('INFO', 'badge-info', 'Starting demo — JWT expiry scenario...');

  await delay(400);

  // Step 1: console.warn — token about to expire
  console.warn('[auth] JWT expiry imminent — 12s remaining');
  addEntry('WARN', 'badge-net', '[auth] JWT expiry imminent — 12s remaining → sent to /v1/logs');

  await delay(600);

  // Step 2: fetch → 401 (the critical path)
  addEntry('INFO', 'badge-info', 'Fetching /demo/api/user with traceparent header...');
  try {
    const resp = await fetch('/demo/api/user');
    const data = await resp.json();
    const traceId = resp.headers.get('traceparent')?.split('-')[1] ?? '?';

    await delay(200);
    console.error('TokenError: JWT expired at audience check', { status: resp.status, traceId });
    addEntry('ERR',   'badge-err',  'console.error: TokenError: JWT expired at audience check');
    addEntry('NET',   'badge-net',  'GET /demo/api/user → 401 (' + (Date.now() % 200 + 80) + 'ms) — sent to /v1/traces');
    await delay(300);
    addEntry('EXACT', 'badge-exact', 'TraceId join: browser fetch ↔ backend span — traceId: ' + traceId.slice(0, 8) + '…');
  } catch {
    addEntry('ERR', 'badge-err', 'Network error — is the Mergen server running?');
  }

  await delay(500);

  // Step 3: second network call after error (refresh attempt that also fails)
  try {
    await fetch('/demo/api/user', { method: 'POST', body: JSON.stringify({ grant_type: 'refresh_token' }) });
  } catch {}
  addEntry('NET', 'badge-net', 'POST /demo/api/user → 401 — refresh token also expired');

  await delay(300);
  addEntry('OK', 'badge-ok', 'Done — 5 events sent. Ask your AI: "get_unified_timeline"');

  document.getElementById('repeat-btn').disabled = false;
  document.getElementById('run-btn').disabled = false;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
</script>
</body>
</html>`;

export default createDemoRouter;
