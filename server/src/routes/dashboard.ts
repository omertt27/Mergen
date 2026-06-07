/**
 * dashboard.ts — Read-only web dashboard served at GET /dashboard (and GET /).
 *
 * Anyone on the team can open http://team-mergen:3000/dashboard in a browser
 * to see the unified timeline, root cause hypothesis, and CI/deploy status —
 * no CLI, no VS Code extension, no install.
 *
 * Polls the server's own endpoints every 5 seconds via client-side JS.
 * Completely self-contained HTML — no external CDN dependencies.
 */

import { randomUUID } from 'crypto';
import { Router } from 'express';

export function createDashboardRouter(serverVersion: string): Router {
  const router = Router();

  router.get('/dashboard', (_req, res) => {
    const nonce = randomUUID().replace(/-/g, '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',
      `default-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'`);
    res.send(buildDashboardHtml(serverVersion, nonce));
  });

  // Also serve at root for team instances where /dashboard is the primary UI
  router.get('/', (_req, res) => {
    const nonce = randomUUID().replace(/-/g, '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',
      `default-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'`);
    res.send(buildDashboardHtml(serverVersion, nonce));
  });

  return router;
}

function buildDashboardHtml(version: string, nonce: string): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mergen Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0f1117;--surface:#1a1d26;--border:#2a2d3a;
    --text:#e2e8f0;--muted:#64748b;--red:#ef4444;--yellow:#f59e0b;
    --green:#22c55e;--blue:#3b82f6;--orange:#f97316;
    --radius:8px;--font:system-ui,-apple-system,sans-serif;
  }
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.5;min-height:100vh}
  header{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:10}
  .logo{font-weight:700;font-size:16px;letter-spacing:.02em}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0}
  .dot.ok{background:var(--green);box-shadow:0 0 6px var(--green)}
  .dot.err{background:var(--red);box-shadow:0 0 6px var(--red)}
  .header-stats{display:flex;gap:16px;margin-left:auto;font-size:12px;color:var(--muted)}
  .header-stats span{color:var(--text)}
  .badge{font-size:11px;padding:2px 8px;border-radius:4px;font-weight:600}
  .badge-red{background:rgba(239,68,68,.15);color:var(--red)}
  .badge-green{background:rgba(34,197,94,.15);color:var(--green)}
  .badge-muted{background:rgba(100,116,139,.15);color:var(--muted)}
  main{max-width:1100px;margin:0 auto;padding:24px}
  .grid{display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start}
  @media(max-width:768px){.grid{grid-template-columns:1fr}}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:16px}
  .card-title{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
  /* Root cause */
  .rc{border-left:3px solid var(--red);background:rgba(239,68,68,.06);padding:12px 14px;border-radius:0 var(--radius) var(--radius) 0;margin-bottom:16px}
  .rc-label{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--red);margin-bottom:4px}
  .rc-hyp{font-size:14px;font-weight:600;color:var(--text);line-height:1.4}
  .rc-fix{font-size:12px;color:var(--muted);margin-top:6px}
  .rc-conf{font-size:11px;color:var(--red);margin-top:4px;font-weight:600}
  .rc-feedback{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px;color:var(--muted)}
  .btn-verdict{padding:2px 8px;border:1px solid rgba(255,255,255,.1);border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit;background:transparent;transition:background .15s}
  .btn-verdict:hover{background:rgba(255,255,255,.08)}
  .btn-verdict.yes{color:var(--green)}.btn-verdict.no{color:var(--red)}.btn-verdict.partial{color:var(--yellow)}
  /* Timeline */
  .tl-row{display:flex;align-items:baseline;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px}
  .tl-row:last-child{border-bottom:none}
  .tl-time{flex-shrink:0;color:var(--muted);font-variant-numeric:tabular-nums;width:60px}
  .tl-icon{flex-shrink:0;width:18px;text-align:center}
  .tl-src{flex-shrink:0;font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:1px 5px;border-radius:3px;background:rgba(100,116,139,.15);color:var(--muted)}
  .tl-src.ci{background:rgba(59,130,246,.15);color:var(--blue)}
  .tl-src.deploy{background:rgba(34,197,94,.15);color:var(--green)}
  .tl-src.backend{background:rgba(249,115,22,.15);color:var(--orange)}
  .tl-src.node{background:rgba(104,211,145,.15);color:#68d391}
  .tl-src.python{background:rgba(246,173,85,.15);color:#f6ad55}
  .tl-joined{font-size:9px;color:var(--green);flex-shrink:0;cursor:pointer;text-decoration:underline}
  /* Trace detail panel */
  #trace-panel{display:none;margin-bottom:16px}
  .trace-section{margin-bottom:10px}
  .trace-section-title{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
  .trace-row{font-size:11px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04);font-family:monospace}
  .trace-row:last-child{border-bottom:none}
  /* SDK card */
  .sdk-row{display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px}
  .sdk-row:last-child{border-bottom:none}
  .sdk-badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px}
  .sdk-badge.node{background:rgba(104,211,145,.15);color:#68d391}
  .sdk-badge.python{background:rgba(246,173,85,.15);color:#f6ad55}
  .tl-summary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tl-sha{flex-shrink:0;font-size:10px;color:var(--muted);font-family:monospace}
  /* Side stats */
  .stat{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)}
  .stat:last-child{border-bottom:none}
  .stat-label{color:var(--muted)}
  .stat-val{font-weight:600}
  .stat-val.red{color:var(--red)}
  .stat-val.green{color:var(--green)}
  .stat-val.yellow{color:var(--yellow)}
  /* CI/deploy table */
  .ci-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px}
  .ci-row:last-child{border-bottom:none}
  .ci-icon{flex-shrink:0;font-size:14px}
  .ci-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ci-sha{font-size:10px;color:var(--muted);font-family:monospace;flex-shrink:0}
  /* Refresh bar */
  .refresh{position:fixed;bottom:16px;right:16px;font-size:11px;color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:4px 12px}
  .empty{text-align:center;padding:32px;color:var(--muted);font-size:12px}
  /* Fix validation */
  .vld-status{font-weight:700;font-size:13px}
  .vld-status.resolved{color:var(--green)}.vld-status.partial{color:var(--yellow)}.vld-status.wrong{color:var(--red)}
  .vld-watch{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-bottom:8px}
  .vld-watch-dot{width:6px;height:6px;border-radius:50%;background:var(--blue);box-shadow:0 0 4px var(--blue);animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
  /* Signal status bar */
  .signals-bar{display:flex;gap:16px;padding:7px 24px;background:var(--surface);border-bottom:1px solid var(--border);font-size:11px;flex-wrap:wrap;align-items:center}
  .sig{display:flex;align-items:center;gap:5px}
  .sig-dot{width:6px;height:6px;border-radius:50%;background:var(--muted);flex-shrink:0}
  .sig-dot.on{background:var(--green);box-shadow:0 0 4px var(--green)}
  .sig-lbl{color:var(--muted)}
  .sig-lbl.on{color:var(--text)}
  .sig-setup{margin-left:auto;font-size:10px;color:var(--muted);cursor:pointer;text-decoration:underline}
  /* Incident actions */
  .inc-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(59,130,246,.06);border-left:3px solid var(--blue);border-radius:0 var(--radius) var(--radius) 0;margin-bottom:16px}
  .inc-bar.acked{border-left-color:var(--yellow);background:rgba(245,158,11,.06)}
  .inc-bar.resolved{border-left-color:var(--green);background:rgba(34,197,94,.06)}
  .inc-status{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;flex-shrink:0}
  .inc-status.open{color:var(--blue)}.inc-status.acknowledged{color:var(--yellow)}.inc-status.resolved{color:var(--green)}
  .inc-actions{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
  .btn{padding:4px 10px;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit;transition:opacity .15s}
  .btn:hover{opacity:.85}
  .btn-ack{background:rgba(245,158,11,.2);color:var(--yellow)}
  .btn-resolve{background:rgba(34,197,94,.2);color:var(--green)}
  .btn-note{background:rgba(100,116,139,.2);color:var(--muted)}
  .btn-assign{background:rgba(59,130,246,.2);color:var(--blue)}
  .note-input{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:4px 8px;font-size:11px;font-family:inherit;width:200px}
  .note-input:focus{outline:1px solid var(--blue)}
  /* War room */
  #war-room{display:none;margin-bottom:20px}
  .wr-grid{display:grid;grid-template-columns:1fr 1fr 300px;gap:16px;align-items:start}
  @media(max-width:900px){.wr-grid{grid-template-columns:1fr 1fr}}
  @media(max-width:600px){.wr-grid{grid-template-columns:1fr}}
  .wr-active{border-left:3px solid var(--red);background:rgba(239,68,68,.06);padding:12px 14px;border-radius:0 var(--radius) var(--radius) 0;margin-bottom:12px}
  .wr-active-title{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--red);margin-bottom:4px}
  .wr-active-body{font-size:13px;font-weight:600;line-height:1.4}
  .wr-active-meta{font-size:11px;color:var(--muted);margin-top:4px}
  .conf-badge{display:inline-block;padding:1px 7px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:.04em}
  .conf-badge.HIGH{background:rgba(34,197,94,.18);color:var(--green)}
  .conf-badge.MEDIUM{background:rgba(245,158,11,.18);color:var(--yellow)}
  .conf-badge.LOW{background:rgba(100,116,139,.18);color:var(--muted)}
  .acc-table{width:100%;border-collapse:collapse;font-size:12px}
  .acc-table th{text-align:left;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:4px 0;border-bottom:1px solid var(--border)}
  .acc-table td{padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
  .acc-table tr:last-child td{border-bottom:none}
  .acc-bar-wrap{background:rgba(255,255,255,.06);border-radius:2px;height:4px;width:80px;overflow:hidden;display:inline-block;vertical-align:middle;margin-left:6px}
  .acc-bar{height:4px;border-radius:2px;background:var(--green)}
  .inc-open-row{display:flex;align-items:baseline;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px}
  .inc-open-row:last-child{border-bottom:none}
  .inc-open-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .inc-open-svc{flex-shrink:0;font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,.18);color:var(--red)}
  .blast-stat{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px}
  .blast-stat:last-child{border-bottom:none}
  .blast-val{font-weight:600}
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <span class="logo">⬡ Mergen</span>
  <span style="color:var(--muted);font-size:11px">v${version}</span>
  <div class="header-stats">
    <div>Errors: <span id="h-errors" class="badge badge-muted">—</span></div>
    <div>Warnings: <span id="h-warns" class="badge badge-muted">—</span></div>
    <div>Net errors: <span id="h-net" class="badge badge-muted">—</span></div>
    <div>Captured: <span id="h-buf" style="color:var(--text)">—</span></div>
  </div>
</header>
<div class="signals-bar">
  <span class="sig"><span class="sig-dot" id="sig-browser"></span><span class="sig-lbl" id="sig-browser-lbl">Browser</span></span>
  <span class="sig"><span class="sig-dot" id="sig-backend"></span><span class="sig-lbl" id="sig-backend-lbl">Backend</span></span>
  <span class="sig"><span class="sig-dot" id="sig-ci"></span><span class="sig-lbl" id="sig-ci-lbl">CI/CD</span></span>
  <span class="sig"><span class="sig-dot" id="sig-process"></span><span class="sig-lbl" id="sig-process-lbl">Process</span></span>
  <span class="sig-setup" id="sig-setup-hint" style="display:none" onclick="window.open('http://127.0.0.1:3000/setup','_blank')"></span>
</div>

<div id="war-room" style="background:var(--surface);border-bottom:1px solid var(--border);padding:16px 24px">
  <div style="max-width:1100px;margin:0 auto">
    <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:12px">⚔ War Room</div>
    <div id="wr-active-box"></div>
    <div class="wr-grid">
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px">Open Incidents</div>
        <div id="wr-open-list"><span style="font-size:11px;color:var(--muted)">No open incidents</span></div>
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px">Attribution Accuracy</div>
        <table class="acc-table">
          <thead><tr><th>Band</th><th>Correct</th><th>Total</th><th>Rate</th></tr></thead>
          <tbody id="wr-accuracy-body"><tr><td colspan="4" style="color:var(--muted);padding:8px 0">No validated incidents yet</td></tr></tbody>
        </table>
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px">Blast Radius</div>
        <div id="wr-blast-list"><span style="font-size:11px;color:var(--muted)">No active incident</span></div>
      </div>
    </div>
  </div>
</div>

<main>
  <div id="rc-box" style="display:none" class="rc">
    <div class="rc-label">Root Cause · <span id="rc-pct"></span></div>
    <div class="rc-hyp" id="rc-hyp"></div>
    <div class="rc-fix" id="rc-fix"></div>
    <div id="rc-feedback" class="rc-feedback" style="display:none">
      Did this fix it?
      <button class="btn-verdict yes"     data-verdict="correct">✓ Yes</button>
      <button class="btn-verdict partial" data-verdict="partial">~ Partially</button>
      <button class="btn-verdict no"      data-verdict="wrong">✗ No</button>
    </div>
  </div>

  <div id="inc-bar" style="display:none" class="inc-bar">
    <span class="inc-status" id="inc-status">OPEN</span>
    <span id="inc-assignee" style="font-size:11px;color:var(--muted)"></span>
    <div class="inc-actions">
      <button class="btn btn-ack"     id="btn-ack">Acknowledge</button>
      <button class="btn btn-assign"  id="btn-assign">Assign to me</button>
      <button class="btn btn-resolve" id="btn-resolve">Resolve</button>
      <input  class="note-input" id="note-input" placeholder="Add note…" style="display:none">
      <button class="btn btn-note"    id="btn-note">+ Note</button>
    </div>
  </div>

  <div class="grid">
    <div>
      <div class="card" id="trace-panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div class="card-title" style="margin:0">Trace Detail <span id="trace-id-label" style="font-family:monospace;font-size:10px;font-weight:400;letter-spacing:0;text-transform:none"></span></div>
          <button onclick="closeTrace()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px">✕</button>
        </div>
        <div id="trace-content"></div>
      </div>

      <div class="card">
        <div class="card-title">Unified Timeline <span style="font-weight:400;text-transform:none;letter-spacing:0" id="tl-window"></span></div>
        <div id="tl-list"><div class="empty">Connecting…</div></div>
      </div>
    </div>

    <div>
      <div class="card">
        <div class="card-title">Buffer</div>
        <div id="stats-list"></div>
      </div>

      <div class="card" id="ci-card" style="display:none">
        <div class="card-title">CI / Deployments</div>
        <div id="ci-list"></div>
      </div>

      <div class="card" id="sdk-card">
        <div class="card-title">Backend SDKs</div>
        <div id="sdk-list"><div style="font-size:11px;color:var(--muted)">No SDK connections yet.</div></div>
      </div>

      <div class="card" id="validate-card" style="display:none">
        <div class="card-title">Fix Validation</div>
        <div id="validate-list"></div>
      </div>

      <div class="card" id="calib-card">
        <div class="card-title">Calibration Health</div>
        <div id="calib-list"><div style="font-size:11px;color:var(--muted)">Loading…</div></div>
      </div>

      <div class="card" id="mttr-card">
        <div class="card-title">MTTR / Autonomous Resolution</div>
        <div id="mttr-content"><div style="font-size:11px;color:var(--muted)">Loading…</div></div>
      </div>

      <div class="card" id="corpus-card">
        <div class="card-title">Accuracy Gate</div>
        <div id="corpus-progress">
          <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
            HIGH-confidence verdicts toward partner corpus target
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <div style="flex:1;background:rgba(255,255,255,.06);border-radius:3px;height:6px;overflow:hidden">
              <div id="corpus-bar" style="height:6px;border-radius:3px;background:var(--green);width:0%;transition:width .4s"></div>
            </div>
            <span id="corpus-count" style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap">0 / 20</span>
          </div>
          <div id="corpus-status" style="font-size:11px;color:var(--muted)">Loading…</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Connect more signals</div>
        <div style="font-size:11px;color:var(--muted);line-height:1.8">
          Node.js: <code style="color:var(--text)">npm install mergen-node</code><br>
          Python: <code style="color:var(--text)">pip install mergen-python</code><br>
          Stream backend: <code style="color:var(--text)">mergen-server watch npm start</code><br>
          CI results: <code style="color:var(--text)">POST /ci/github</code><br>
          Docker logs: <code style="color:var(--text)">MERGEN_DOCKER_LOGS=true</code>
        </div>
      </div>
    </div>
  </div>
</main>

<div class="refresh" id="refresh-bar">Refreshing…</div>

<script nonce="${nonce}">
// Fetch local secret once — used for mutating endpoints (/feedback, /clear).
// The /local-secret endpoint is protected by the Host-header check so only
// callers on 127.0.0.1:<port> can read it.
let _localSecret = '';
let _sdkServices = {};

function setSignal(id, on, label) {
  const dot = document.getElementById('sig-' + id);
  const lbl = document.getElementById('sig-' + id + '-lbl');
  if (!dot || !lbl) return;
  dot.className = 'sig-dot' + (on ? ' on' : '');
  lbl.className = 'sig-lbl' + (on ? ' on' : '');
  lbl.textContent = label;
}

function updateSignalStatus(health, sdkServices, rows) {
  const browserOn = health && (health.buffered > 0 || (health.lastEventAt && Date.now() - health.lastEventAt < 300000));
  setSignal('browser', browserOn, 'Browser' + (browserOn ? '' : ' — inactive'));

  const backendKeys = Object.keys(sdkServices || {});
  const backendOn = backendKeys.length > 0;
  setSignal('backend', backendOn, backendOn ? 'Backend (' + backendKeys.length + ')' : 'Backend — not connected');

  const ciOn = (rows || []).some(r => r.kind === 'ci_failure' || r.kind === 'ci_success' || r.kind === 'deployment');
  setSignal('ci', ciOn, ciOn ? 'CI/CD' : 'CI/CD — not connected');

  const processOn = (rows || []).some(r => r.kind === 'terminal');
  setSignal('process', processOn, processOn ? 'Process' : 'Process — not connected');

  const inactive = [];
  if (!backendOn) inactive.push('backend');
  if (!ciOn) inactive.push('CI/CD');
  if (!processOn) inactive.push('process');
  const hint = document.getElementById('sig-setup-hint');
  if (inactive.length > 0) {
    hint.textContent = 'Connect: ' + inactive.join(', ') + ' →';
    hint.style.display = '';
  } else {
    hint.style.display = 'none';
  }
}
fetch('/local-secret').then(r=>r.json()).then(d=>{ _localSecret=d.secret||''; }).catch(()=>{});

// Track which pids the user has already rated to avoid double-submission.
const _ratedPids = new Set(JSON.parse(localStorage.getItem('mergenRated')||'[]'));

document.getElementById('rc-feedback').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-verdict]');
  if (!btn || !_currentPid || _ratedPids.has(_currentPid)) return;
  const verdict = btn.dataset.verdict;
  try {
    const r = await fetch('/feedback', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-mergen-secret':_localSecret},
      body: JSON.stringify({ pid: _currentPid, verdict }),
    });
    if (r.ok || r.status === 207) {
      _ratedPids.add(_currentPid);
      localStorage.setItem('mergenRated', JSON.stringify([..._ratedPids]));
      const fb = document.getElementById('rc-feedback');
      fb.innerHTML = '<span style="color:var(--muted)">Thanks — this improves future diagnoses.</span>';
    }
  } catch {}
});

const ICON = {
  error:'🔴',warn:'🟡',log:'⬜',request:'🟠',context:'⬜',
  terminal:'💻',process_exit:'💥',ci_failure:'❌',ci_success:'✅',deployment:'🚀',
  backend_span:'🔷',
};

function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function rel(ms){
  const d=Date.now()-ms;
  if(d<60000) return Math.max(1,Math.floor(d/1000))+'s';
  if(d<3600000) return Math.floor(d/60000)+'m';
  return Math.floor(d/3600000)+'h';
}

function time(iso){return iso.slice(11,19);}

async function pollSdkStatus(){
  try{
    const {services} = await fetch('/sdk-status').then(r=>r.json());
    _sdkServices = services || {};
    updateSignalStatus(null, _sdkServices, null);
    const keys = Object.keys(services||{});
    const el = document.getElementById('sdk-list');
    if(keys.length===0){
      el.innerHTML='<div style="font-size:11px;color:var(--muted)">No SDK connections yet.<br>Install <code>mergen-node</code> or <code>mergen-python</code>.</div>';
      return;
    }
    el.innerHTML=keys.map(k=>{
      const s=services[k];
      const ago=rel(s.lastSeen);
      const errBadge=s.errorCount>0?'<span class="badge badge-red">'+s.errorCount+' err</span>':'';
      return '<div class="sdk-row">'+
        '<span><span class="sdk-badge '+s.sdk+'">'+s.sdk+'</span> '+esc(k.split('/')[1]||k)+'</span>'+
        '<span style="display:flex;align-items:center;gap:6px">'+errBadge+'<span style="font-size:10px;color:var(--muted)">'+ago+' ago</span></span>'+
      '</div>';
    }).join('');
  }catch(e){}
}

async function showTrace(traceId){
  try{
    const data = await fetch('/trace/'+traceId).then(r=>r.json());
    const panel = document.getElementById('trace-panel');
    const content = document.getElementById('trace-content');
    document.getElementById('trace-id-label').textContent = traceId;
    panel.style.display='block';

    let html='';
    if(data.browserNet&&data.browserNet.length>0){
      html+='<div class="trace-section"><div class="trace-section-title">Browser (fetch/XHR)</div>';
      html+=data.browserNet.map(n=>'<div class="trace-row">'+esc(n.method)+' '+esc(n.url)+' → '+n.status+' ('+n.duration+'ms)'+(n.error?' — '+esc(n.error):'')+'</div>').join('');
      html+='</div>';
    }
    if(data.backendSpans&&data.backendSpans.length>0){
      html+='<div class="trace-section"><div class="trace-section-title">Backend Spans</div>';
      html+=data.backendSpans.map(s=>'<div class="trace-row"><span class="sdk-badge '+s.sdk+'" style="margin-right:4px">'+s.sdk+'</span>'+esc(s.service)+' — '+esc(s.method)+' '+esc(s.route)+' → '+s.statusCode+' ('+s.durationMs+'ms)'+(s.error?' — '+esc(s.error):'')+'</div>').join('');
      html+='</div>';
    }
    if(data.backendLogs&&data.backendLogs.length>0){
      html+='<div class="trace-section"><div class="trace-section-title">Backend Logs (traceId in stdout)</div>';
      html+=data.backendLogs.map(t=>'<div class="trace-row">'+esc('['+t.terminalName+'] '+t.data.slice(0,200))+'</div>').join('');
      html+='</div>';
    }
    const joined = (data.browserNet&&data.browserNet.length>0)&&(data.backendSpans&&data.backendSpans.length>0);
    html+='<div style="font-size:11px;margin-top:8px;color:'+(joined?'var(--green)':'var(--yellow)')+'">'+
      (joined?'✅ EXACT JOIN — browser request matched to backend span':'⚠ Partial — check SDK instrumentation')+'</div>';
    content.innerHTML=html;
  }catch(e){ console.warn('trace fetch failed',e); }
}

function closeTrace(){
  document.getElementById('trace-panel').style.display='none';
}

async function poll(){
  try{
    const [unified,health]=await Promise.all([
      fetch('/timeline/unified?seconds=300&limit=30').then(r=>r.json()),
      fetch('/health').then(r=>r.json()),
    ]);

    // Header
    const dot=document.getElementById('dot');
    dot.className='dot ok';
    document.getElementById('h-errors').textContent=health.errors??0;
    document.getElementById('h-errors').className='badge '+(health.errors>0?'badge-red':'badge-muted');
    document.getElementById('h-warns').textContent=health.warnings??0;
    document.getElementById('h-net').textContent=health.networkErrors??0;
    document.getElementById('h-buf').textContent=health.buffered??0;

    // Root cause
    const rc=unified.rootCause;
    const rcBox=document.getElementById('rc-box');
    if(rc&&rc.confidence>=0.45){
      rcBox.style.display='block';
      const lowConf=rc.confidence<0.7;
      rcBox.style.opacity=lowConf?'0.6':'1';
      document.getElementById('rc-pct').textContent=Math.round(rc.confidence*100)+'% confidence'+(lowConf?' (low)':'');
      document.getElementById('rc-hyp').textContent=rc.hypothesis;
      const fix=document.getElementById('rc-fix');
      if(rc.fixHint){fix.textContent='💡 '+rc.fixHint;fix.style.display='block';}else{fix.style.display='none';}
      // Show feedback buttons for new pids; hide if already rated
      const fb=document.getElementById('rc-feedback');
      if(rc.pid && !_ratedPids.has(rc.pid)){
        fb.style.display='flex';
        const hypSnippet=rc.hypothesis?rc.hypothesis.slice(0,60)+(rc.hypothesis.length>60?'…':''):'';
        fb.innerHTML='Did this fix it?'+(hypSnippet?' <span style="color:var(--muted);font-size:10px">('+esc(hypSnippet)+')</span>':'')+' <button class="btn-verdict yes" data-verdict="correct">✓ Yes</button><button class="btn-verdict partial" data-verdict="partial">~ Partially</button><button class="btn-verdict no" data-verdict="wrong">✗ No</button>';
      }else if(rc.pid){
        fb.style.display='none';
      }
      if(!lowConf)ensureIncident(rc);
    }else{rcBox.style.display='none';}

    // Timeline
    const rows=unified.rows??[];
    const tlList=document.getElementById('tl-list');
    document.getElementById('tl-window').textContent='· last 5m · '+rows.length+' events';
    if(rows.length===0){
      tlList.innerHTML='<div class="empty">No events yet. Send telemetry via OpenTelemetry (:4318/v1/traces), trigger a PagerDuty test, or stream Docker logs. See <a href="/setup" style="color:var(--blue)">setup guide</a>.</div>';
    }else{
      tlList.innerHTML=rows.slice(-30).reverse().map(r=>{
        const src=r.source||'';
        const sha=r.sha?'<span class="tl-sha">['+esc(r.sha)+']</span>':'';
        // For backend spans, show sdk badge instead of generic "backend"
        let srcBadge='';
        if(r.kind==='backend_span'&&r.summary){
          const sdkMatch=r.summary.match(/^\[(node|python):/);
          const sdkName=sdkMatch?sdkMatch[1]:null;
          srcBadge=sdkName?'<span class="tl-src '+sdkName+'">'+sdkName+'</span>':'<span class="tl-src backend">backend</span>';
        }else if(src){
          srcBadge='<span class="tl-src '+src+'">'+src+'</span>';
        }
        const confBadge=r.confidence>=1.0
          ?'<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(34,197,94,.15);color:var(--green);flex-shrink:0">EXACT</span>'
          :r.confidence>=0.8
            ?'<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(59,130,246,.12);color:var(--blue);flex-shrink:0">LINKED</span>'
            :'';
        const joinedLink=r.traceId&&r.confidence>=1.0
          ?'<span class="tl-joined" onclick="showTrace(\''+esc(r.traceId)+'\')">trace</span>'
          :r.traceId
            ?'<span class="tl-joined" style="color:var(--muted)" onclick="showTrace(\''+esc(r.traceId)+'\')">trace</span>'
            :'';
        return '<div class="tl-row">'+
          '<span class="tl-time">'+time(r.isoTs)+'</span>'+
          '<span class="tl-icon">'+(ICON[r.kind]||'⬜')+'</span>'+
          srcBadge+
          '<span class="tl-summary">'+esc(r.summary)+'</span>'+
          sha+confBadge+joinedLink+
        '</div>';
      }).join('');
    }

    // Buffer stats
    document.getElementById('stats-list').innerHTML=[
      ['Errors',health.errors??0,'red'],
      ['Warnings',health.warnings??0,'yellow'],
      ['Net errors',health.networkErrors??0,'red'],
      ['Captured',health.buffered??0,''],
      ['Last event',health.lastEventAt?rel(health.lastEventAt)+' ago':'—',''],
    ].map(([l,v,c])=>'<div class="stat"><span class="stat-label">'+l+'</span><span class="stat-val '+(c||'')+'">'+v+'</span></div>').join('');

    // CI/deployments from unified rows
    const ciRows=rows.filter(r=>r.kind==='ci_failure'||r.kind==='ci_success'||r.kind==='deployment').slice(-6).reverse();
    const ciCard=document.getElementById('ci-card');
    if(ciRows.length>0){
      ciCard.style.display='block';
      document.getElementById('ci-list').innerHTML=ciRows.map(r=>{
        const sha=r.sha?'<span class="ci-sha">'+esc(r.sha)+'</span>':'';
        return '<div class="ci-row">'+
          '<span class="ci-icon">'+(ICON[r.kind]||'⬜')+'</span>'+
          '<span class="ci-label">'+esc(r.summary)+'</span>'+
          sha+
        '</div>';
      }).join('');
    }else{ciCard.style.display='none';}

    updateSignalStatus(health, _sdkServices, rows);
    document.getElementById('refresh-bar').textContent='Updated '+new Date().toLocaleTimeString();
  }catch(e){
    document.getElementById('dot').className='dot err';
    document.getElementById('refresh-bar').textContent='Server unreachable — run: cd server && npm start';
  }
}

// ── Incident actions ─────────────────────────────────────────────────────────
let _currentPid = null;
let _userName = localStorage.getItem('mergenUser') || '';

async function incidentAction(action, body={}) {
  if (!_currentPid) return;
  try {
    await fetch('/incidents/'+encodeURIComponent(_currentPid)+'/'+action, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
    });
    await refreshIncident();
  } catch(e) { console.warn('incident action failed', e); }
}

async function refreshIncident() {
  if (!_currentPid) return;
  try {
    const r = await fetch('/incidents/'+encodeURIComponent(_currentPid));
    if (!r.ok) return;
    const {incident} = await r.json();
    renderIncidentBar(incident);
  } catch {}
}

function renderIncidentBar(inc) {
  const bar = document.getElementById('inc-bar');
  if (!inc || !bar) return;
  bar.style.display='flex';
  bar.className='inc-bar'+(inc.status==='acknowledged'?' acked':inc.status==='resolved'?' resolved':'');
  document.getElementById('inc-status').textContent=inc.status.toUpperCase();
  document.getElementById('inc-status').className='inc-status '+inc.status;
  const aEl = document.getElementById('inc-assignee');
  aEl.textContent = inc.assignee ? 'Assigned: '+inc.assignee : (inc.acknowledgedBy ? 'Acked by: '+inc.acknowledgedBy : '');
  document.getElementById('btn-ack').style.display = inc.status==='open' ? '' : 'none';
  document.getElementById('btn-assign').style.display = inc.status==='resolved' ? 'none' : '';
  document.getElementById('btn-resolve').style.display = inc.status==='resolved' ? 'none' : '';
}

document.getElementById('btn-ack').addEventListener('click', async () => {
  const by = _userName || prompt('Your name (optional):') || '';
  if (by && !_userName) { _userName=by; localStorage.setItem('mergenUser',by); }
  await incidentAction('acknowledge', {by});
});

document.getElementById('btn-assign').addEventListener('click', async () => {
  const to = _userName || prompt('Assign to (name/email):');
  if (!to) return;
  if (!_userName) { _userName=to; localStorage.setItem('mergenUser',to); }
  await incidentAction('assign', {to});
});

document.getElementById('btn-resolve').addEventListener('click', async () => {
  const note = document.getElementById('note-input').value.trim();
  await incidentAction('resolve', {by: _userName, note: note||undefined});
});

document.getElementById('btn-note').addEventListener('click', () => {
  const inp = document.getElementById('note-input');
  if (inp.style.display==='none') { inp.style.display=''; inp.focus(); return; }
  const text = inp.value.trim();
  if (!text) { inp.style.display='none'; return; }
  incidentAction('note', {text, author: _userName}).then(()=>{ inp.value=''; inp.style.display='none'; });
});

// ── Wire incident bar to root-cause hypothesis ────────────────────────────────
async function ensureIncident(rc) {
  if (!rc || !rc.pid) return;
  if (_currentPid === rc.pid) return;
  _currentPid = rc.pid;
  // Upsert the incident record
  try {
    await fetch('/incidents', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ pid: rc.pid, hypothesis: rc.hypothesis, tag: rc.tag, confidence: rc.confidence }),
    });
    await refreshIncident();
  } catch {}
}

async function pollValidateState() {
  try {
    const state = await fetch('/validate/state').then(r=>r.json());
    const card = document.getElementById('validate-card');
    const list = document.getElementById('validate-list');
    if (!state.watching && !state.lastValidation) { card.style.display='none'; return; }
    card.style.display = 'block';
    let html = '';
    if (state.watching) {
      const n = state.paths ? state.paths.length : 0;
      html += '<div class="vld-watch"><span class="vld-watch-dot"></span>Watching '+n+' file'+(n!==1?'s':'')+'…</div>';
    }
    if (state.lastValidation) {
      const v = state.lastValidation;
      const cls = v.verdict==='correct'?'resolved':v.verdict==='partial'?'partial':'wrong';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'+
        '<span class="vld-status '+cls+'">'+esc(v.status)+'</span>'+
        '<span style="font-size:10px;color:var(--muted)">'+rel(v.timestamp)+' ago</span>'+
        '</div>'+
        '<div style="font-size:11px;color:var(--muted)">'+
        'Before: <strong>'+v.errsBefore+'</strong> error'+(v.errsBefore!==1?'s':'')+
        ' &nbsp;→&nbsp; After: <strong>'+v.errsAfter+'</strong>'+
        '</div>';
    }
    list.innerHTML = html;
  } catch(e) {}
}

async function pollCalibrationHealth() {
  try {
    const [sm, cal, unc] = await Promise.all([
      fetch('/session-metrics').then(r => r.json()),
      fetch('/calibration').then(r => r.json()),
      fetch('/calibration/unclassified?minCount=3').then(r => r.json()),
    ]);
    const el = document.getElementById('calib-list');
    if (!el) return;
    let html = '';

    // First-attempt fix success rate
    const rate = sm.firstAttemptSuccessRate;
    const rateStr = rate !== null && rate !== undefined
      ? Math.round(rate * 100) + '%'
      : sm.withOutcome < 3 ? 'n/a (' + sm.withOutcome + ' sessions)' : '—';
    const rateColor = rate === null ? 'var(--muted)' : rate >= 0.6 ? 'var(--green)' : rate >= 0.4 ? 'var(--yellow)' : 'var(--red)';
    html += '<div class="stat"><span class="stat-label">1st-attempt success</span><span class="stat-val" style="color:' + rateColor + '">' + esc(rateStr) + '</span></div>';
    html += '<div class="stat"><span class="stat-label">Total sessions</span><span class="stat-val">' + (sm.total || 0) + '</span></div>';

    // Overall calibration accuracy
    if (cal.overallAccuracy !== null && cal.overallAccuracy !== undefined) {
      const acc = Math.round(cal.overallAccuracy * 100);
      const accColor = acc >= 70 ? 'var(--green)' : acc >= 50 ? 'var(--yellow)' : 'var(--red)';
      html += '<div class="stat"><span class="stat-label">Detector accuracy</span><span class="stat-val" style="color:' + accColor + '">' + acc + '%</span></div>';
    }
    html += '<div class="stat"><span class="stat-label">Trusted detectors</span><span class="stat-val">' + (cal.trustedDetectors || 0) + ' / ' + (cal.totalDetectors || 0) + '</span></div>';

    // Unclassified clusters
    if (unc.total > 0) {
      html += '<div class="stat"><span class="stat-label" style="color:var(--yellow)">Unclassified patterns</span><span class="stat-val" style="color:var(--yellow)">' + unc.total + '</span></div>';
    }

    // Per-detector breakdown (top 5 trusted)
    const trusted = (cal.perDetector || []).filter(d => d.trusted).slice(0, 5);
    if (trusted.length > 0) {
      html += '<div style="margin-top:8px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Detectors</div>';
      for (const d of trusted) {
        const acc = Math.round(d.accuracy * 100);
        const trend = d.trendDelta !== null ? (d.trendDelta > 0 ? ' ↑' : d.trendDelta < 0 ? ' ↓' : '') : '';
        const color = acc >= 70 ? 'var(--green)' : acc >= 50 ? 'var(--yellow)' : 'var(--red)';
        html += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:11px">'
          + '<span style="color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px" title="' + esc(d.tag) + '">' + esc(d.tag.replace(/_/g,' ')) + '</span>'
          + '<span style="color:' + color + ';flex-shrink:0">' + acc + '%' + esc(trend) + '</span>'
          + '</div>';
      }
    }

    el.innerHTML = html;
  } catch(e) {}
}

// ── War Room ──────────────────────────────────────────────────────────────────
function fmtRelTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.round(diff/60000)+'m ago';
  return Math.round(diff/3600000)+'h ago';
}
function fmtDurationMs(ms) {
  if (!ms) return '—';
  if (ms < 60000) return Math.round(ms/1000)+'s';
  if (ms < 3600000) return Math.round(ms/60000)+'m';
  return (ms/3600000).toFixed(1)+'h';
}
async function pollWarRoom() {
  try {
    const d = await fetch('/api/war-room').then(r=>r.json());
    if (!d.ok) return;

    const wr = document.getElementById('war-room');
    if (!wr) return;

    const hasActivity = d.activeIncident || (d.openIncidents && d.openIncidents.length > 0)
      || (d.mttrHistory && d.mttrHistory.length > 0);
    wr.style.display = hasActivity ? '' : 'none';

    // Active incident banner
    const activeBox = document.getElementById('wr-active-box');
    if (d.activeIncident && activeBox) {
      const a = d.activeIncident;
      const conf = a.blameConfidence !== null ? Math.round(a.blameConfidence*100)+'%' : null;
      const label = a.blameLabel || '';
      activeBox.innerHTML = '<div class="wr-active">'
        + '<div class="wr-active-title">🔴 Active — ' + esc(a.service) + '</div>'
        + '<div class="wr-active-body">' + esc(a.alertTitle) + '</div>'
        + '<div class="wr-active-meta">Fired '+ fmtRelTime(a.firedAt)
        + (a.blameSha ? ' · Deploy <code style="font-family:monospace">'+esc(a.blameSha)+'</code>' : '')
        + (conf ? ' · <span class="conf-badge '+esc(label)+'">'+conf+' '+esc(label)+'</span>' : '')
        + (a.blameExplanation ? '<br><span style="font-size:10px;color:var(--muted)">'+esc(a.blameExplanation)+'</span>' : '')
        + '</div></div>';
    } else if (activeBox) {
      activeBox.innerHTML = '';
    }

    // Open incidents
    const openList = document.getElementById('wr-open-list');
    if (openList) {
      if (!d.openIncidents || d.openIncidents.length === 0) {
        openList.innerHTML = '<span style="font-size:11px;color:var(--muted)">No open incidents ✓</span>';
      } else {
        openList.innerHTML = d.openIncidents.map(inc => {
          const conf = inc.attributionConfidence !== null
            ? '<span class="conf-badge '+(inc.attributionConfidence>=.8?'HIGH':inc.attributionConfidence>=.6?'MEDIUM':'LOW')+'">'
              +Math.round(inc.attributionConfidence*100)+'%</span>' : '';
          return '<div class="inc-open-row">'
            + '<span class="inc-open-svc">'+esc(inc.service)+'</span>'
            + '<span class="inc-open-title" title="'+esc(inc.alertTitle)+'">'+esc(inc.alertTitle)+'</span>'
            + conf
            + '<span style="font-size:10px;color:var(--muted);flex-shrink:0">'+fmtRelTime(inc.firedAt)+'</span>'
            + '</div>';
        }).join('');
      }
    }

    // Attribution accuracy table
    const accBody = document.getElementById('wr-accuracy-body');
    if (accBody && d.attributionAccuracy) {
      const acc = d.attributionAccuracy;
      const bands = [['HIGH','high','var(--green)'],['MEDIUM','medium','var(--yellow)'],['LOW','low','var(--muted)']];
      const rows = bands.map(([label,key,color]) => {
        const b = acc[key] || {correct:0,total:0,pct:null};
        if (b.total === 0) return '<tr><td><span class="conf-badge '+label+'">'+label+'</span></td><td style="color:var(--muted)">—</td><td style="color:var(--muted)">0</td><td style="color:var(--muted)">—</td></tr>';
        const pct = b.pct ?? 0;
        return '<tr><td><span class="conf-badge '+label+'">'+label+'</span></td>'
          +'<td style="color:'+color+'">'+b.correct+'</td>'
          +'<td style="color:var(--muted)">'+b.total+'</td>'
          +'<td><span style="color:'+color+'">'+pct+'%</span>'
          +'<span class="acc-bar-wrap"><span class="acc-bar" style="width:'+pct+'%;background:'+color+'"></span></span></td></tr>';
      });
      accBody.innerHTML = rows.join('');
    }

    // Blast radius panel
    const blastEl = document.getElementById('wr-blast-list');
    if (blastEl && d.blastRadius) {
      const br = d.blastRadius;
      if (!br.errorCount) {
        blastEl.innerHTML = '<span style="font-size:11px;color:var(--muted)">No active errors</span>';
      } else {
        let html = '';
        if (br.affectedSessions > 0) html += '<div class="blast-stat"><span style="color:var(--muted)">Sessions</span><span class="blast-val" style="color:var(--red)">'+br.affectedSessions+'</span></div>';
        if (br.affectedUsers > 0)    html += '<div class="blast-stat"><span style="color:var(--muted)">Users</span><span class="blast-val">'+br.affectedUsers+'</span></div>';
        html += '<div class="blast-stat"><span style="color:var(--muted)">Errors</span><span class="blast-val">'+br.errorCount+'</span></div>';
        if (br.durationMs) html += '<div class="blast-stat"><span style="color:var(--muted)">Duration</span><span class="blast-val">'+fmtDurationMs(br.durationMs)+'</span></div>';
        if (br.browserSegments) {
          const topBrowsers = Object.entries(br.browserSegments).sort((a,b)=>b[1]-a[1]).slice(0,3);
          if (topBrowsers.length > 0) html += '<div class="blast-stat"><span style="color:var(--muted)">Browsers</span><span class="blast-val" style="font-size:10px">'+topBrowsers.map(([b,n])=>b+':'+n).join(' ')+'</span></div>';
        }
        blastEl.innerHTML = html;
      }
    }
  } catch(e) {}
}

async function pollMttr() {
  try {
    const d = await fetch('/incidents/impact-report').then(r => r.json());
    if (!d.ok) return;
    const el = document.getElementById('mttr-content');
    if (!el) return;

    if (d.totalResolved === 0) {
      el.innerHTML = '<div style="font-size:11px;color:var(--muted)">No resolved incidents yet.</div>';
      return;
    }

    const autoRate = d.autonomousRate ?? 0;
    const barColor = autoRate >= 50 ? 'var(--green)' : autoRate >= 25 ? 'var(--yellow)' : 'var(--muted)';

    function fmtMs(ms) {
      if (!ms) return '—';
      if (ms < 60000) return Math.round(ms / 1000) + 's';
      if (ms < 3600000) return Math.round(ms / 60000) + 'm';
      return (ms / 3600000).toFixed(1) + 'h';
    }

    let html = '';
    // Autonomous rate bar
    html += '<div style="margin-bottom:10px">'
      + '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">'
      + '<span style="color:var(--muted)">Autonomous rate</span>'
      + '<span style="font-weight:700;color:' + barColor + '">' + autoRate + '%</span>'
      + '</div>'
      + '<div style="background:rgba(255,255,255,.06);border-radius:3px;height:6px;overflow:hidden">'
      + '<div style="height:6px;border-radius:3px;background:' + barColor + ';width:' + autoRate + '%;transition:width .4s"></div>'
      + '</div>'
      + '</div>';

    // MTTR comparison
    html += '<div class="stat"><span class="stat-label">Resolved total</span><span class="stat-val">' + d.totalResolved + '</span></div>';
    html += '<div class="stat"><span class="stat-label">Autonomous</span><span class="stat-val" style="color:var(--green)">' + d.autonomousResolutions + '</span></div>';
    html += '<div class="stat"><span class="stat-label">Manual</span><span class="stat-val" style="color:var(--muted)">' + d.manualResolutions + '</span></div>';

    if (d.mttr) {
      if (d.mttr.overallMs)    html += '<div class="stat"><span class="stat-label">MTTR overall</span><span class="stat-val">' + fmtMs(d.mttr.overallMs) + '</span></div>';
      if (d.mttr.autonomousMs) html += '<div class="stat"><span class="stat-label">MTTR autonomous</span><span class="stat-val" style="color:var(--green)">' + fmtMs(d.mttr.autonomousMs) + '</span></div>';
      if (d.mttr.manualMs)     html += '<div class="stat"><span class="stat-label">MTTR manual</span><span class="stat-val" style="color:var(--muted)">' + fmtMs(d.mttr.manualMs) + '</span></div>';
    }

    // Recent resolutions
    if (d.recentResolutions && d.recentResolutions.length > 0) {
      html += '<div style="margin-top:8px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Recent</div>';
      for (const r of d.recentResolutions.slice(0, 4)) {
        const icon = r.resolvedAutonomously ? '🤖' : '👤';
        const mttr = r.mttrMs ? fmtMs(r.mttrMs) : '—';
        html += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:11px">'
          + '<span>' + icon + ' ' + esc(r.tag ? r.tag.replace(/_/g,' ') : r.pid.slice(0,12)) + '</span>'
          + '<span style="color:var(--muted)">' + mttr + '</span>'
          + '</div>';
      }
    }

    el.innerHTML = html;
  } catch(e) {}
}

async function pollCorpusProgress() {
  try {
    const d = await fetch('/calibration/corpus-progress').then(r => r.json());
    if (!d.ok) return;
    const bar = document.getElementById('corpus-bar');
    const count = document.getElementById('corpus-count');
    const status = document.getElementById('corpus-status');
    if (bar) bar.style.width = d.pct + '%';
    if (count) count.textContent = d.highConfidentCorrect + ' / ' + d.target;
    if (status) {
      if (d.targetReached) {
        status.textContent = '✅ Gate reached — corpus ready to publish';
        status.style.color = 'var(--green)';
      } else {
        const remaining = d.target - d.highConfidentCorrect;
        status.textContent = remaining + ' more needed · ' + d.trustedDetectors + ' trusted detector' + (d.trustedDetectors !== 1 ? 's' : '') + ' · ' + d.totalVerdicts + ' total verdicts';
        status.style.color = 'var(--muted)';
      }
    }
  } catch {}
}

poll();
pollSdkStatus();
pollValidateState();
pollCalibrationHealth();
pollWarRoom();
pollCorpusProgress();
pollMttr();
setInterval(poll,5000);
setInterval(pollSdkStatus,10000);
setInterval(pollValidateState,5000);
setInterval(pollCalibrationHealth,30000);
setInterval(pollWarRoom,10000);
setInterval(pollCorpusProgress,30000);
setInterval(pollMttr,30000);
</script>
</body></html>`;
}
