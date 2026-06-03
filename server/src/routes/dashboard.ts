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
  /* Timeline */
  .tl-row{display:flex;align-items:baseline;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px}
  .tl-row:last-child{border-bottom:none}
  .tl-time{flex-shrink:0;color:var(--muted);font-variant-numeric:tabular-nums;width:60px}
  .tl-icon{flex-shrink:0;width:18px;text-align:center}
  .tl-src{flex-shrink:0;font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:1px 5px;border-radius:3px;background:rgba(100,116,139,.15);color:var(--muted)}
  .tl-src.ci{background:rgba(59,130,246,.15);color:var(--blue)}
  .tl-src.deploy{background:rgba(34,197,94,.15);color:var(--green)}
  .tl-src.backend{background:rgba(249,115,22,.15);color:var(--orange)}
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
  a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
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
    <div>Buffered: <span id="h-buf" style="color:var(--text)">—</span></div>
  </div>
</header>

<main>
  <div id="rc-box" style="display:none" class="rc">
    <div class="rc-label">Root Cause · <span id="rc-pct"></span></div>
    <div class="rc-hyp" id="rc-hyp"></div>
    <div class="rc-fix" id="rc-fix"></div>
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

      <div class="card">
        <div class="card-title">Connect more signals</div>
        <div style="font-size:11px;color:var(--muted);line-height:1.8">
          Stream backend: <code style="color:var(--text)">mergen-server watch npm start</code><br>
          CI results: <code style="color:var(--text)">POST /ci/github</code><br>
          Deployments: <code style="color:var(--text)">POST /deployments</code><br>
          Docker logs: <code style="color:var(--text)">MERGEN_DOCKER_LOGS=true</code>
        </div>
      </div>
    </div>
  </div>
</main>

<div class="refresh" id="refresh-bar">Refreshing…</div>

<script nonce="${nonce}">
const ICON = {
  error:'🔴',warn:'🟡',log:'⬜',request:'🟠',context:'⬜',
  terminal:'💻',process_exit:'💥',ci_failure:'❌',ci_success:'✅',deployment:'🚀',
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
    if(rc&&rc.confidence>=0.7){
      rcBox.style.display='block';
      document.getElementById('rc-pct').textContent=Math.round(rc.confidence*100)+'% confidence';
      document.getElementById('rc-hyp').textContent=rc.hypothesis;
      const fix=document.getElementById('rc-fix');
      if(rc.fixHint){fix.textContent='💡 '+rc.fixHint;fix.style.display='block';}else{fix.style.display='none';}
      ensureIncident(rc);
    }else{rcBox.style.display='none';}

    // Timeline
    const rows=unified.rows??[];
    const tlList=document.getElementById('tl-list');
    document.getElementById('tl-window').textContent='· last 5m · '+rows.length+' events';
    if(rows.length===0){
      tlList.innerHTML='<div class="empty">No significant events. Open your app in the browser with the Mergen extension active.</div>';
    }else{
      tlList.innerHTML=rows.slice(-30).reverse().map(r=>{
        const src=r.source||'';
        const sha=r.sha?'<span class="tl-sha">['+esc(r.sha)+']</span>':'';
        return '<div class="tl-row">'+
          '<span class="tl-time">'+time(r.isoTs)+'</span>'+
          '<span class="tl-icon">'+(ICON[r.kind]||'⬜')+'</span>'+
          (src?'<span class="tl-src '+src+'">'+src+'</span>':'')+
          '<span class="tl-summary">'+esc(r.summary)+'</span>'+
          sha+
        '</div>';
      }).join('');
    }

    // Buffer stats
    document.getElementById('stats-list').innerHTML=[
      ['Errors',health.errors??0,'red'],
      ['Warnings',health.warnings??0,'yellow'],
      ['Net errors',health.networkErrors??0,'red'],
      ['Buffered',health.buffered??0,''],
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

    document.getElementById('refresh-bar').textContent='Updated '+new Date().toLocaleTimeString();
  }catch(e){
    document.getElementById('dot').className='dot err';
    document.getElementById('refresh-bar').textContent='Server unreachable — retrying…';
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

poll();
setInterval(poll,5000);
</script>
</body></html>`;
}
