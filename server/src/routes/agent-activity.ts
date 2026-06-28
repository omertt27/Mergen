/**
 * routes/agent-activity.ts — Live agent activity dashboard.
 *
 *   GET /agent-activity   Real-time HTML dashboard (SSE-powered)
 *
 * Shows every agent tool call as it happens: who, what, verdict, latency.
 * Designed for team leads who need situational awareness before granting
 * agents write access to production systems.
 */

import { randomUUID } from 'crypto';
import { Router } from 'express';

export function createAgentActivityRouter(): Router {
  const router = Router();

  router.get('/agent-activity', (_req, res) => {
    const nonce = randomUUID().replace(/-/g, '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',
      `default-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'`);
    res.send(buildActivityHtml(nonce));
  });

  return router;
}

function buildActivityHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Activity · Mergen</title>
<style>
  :root{--bg:#0f1117;--surface:#1a1d26;--border:#2a2d3a;--text:#e2e8f0;--muted:#64748b;
    --green:#22c55e;--yellow:#f59e0b;--red:#ef4444;--blue:#3b82f6;--purple:#a78bfa;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'SF Mono',ui-monospace,monospace;font-size:12px;line-height:1.5;height:100vh;display:flex;flex-direction:column;overflow:hidden}
  header{padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:16px;flex-shrink:0;background:var(--surface)}
  header h1{font-size:14px;font-weight:700;letter-spacing:.02em}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .stats{display:flex;gap:16px;margin-left:auto;font-size:11px}
  .stat{display:flex;align-items:center;gap:6px;color:var(--muted)}
  .stat b{color:var(--text)}
  .nav{display:flex;gap:12px;font-size:11px;padding:0 20px;border-bottom:1px solid var(--border);background:var(--surface)}
  .nav a{color:var(--muted);text-decoration:none;padding:8px 0;display:block}
  .nav a:hover{color:var(--blue)}
  .filters{padding:10px 20px;border-bottom:1px solid var(--border);display:flex;gap:12px;flex-shrink:0;background:#13151e}
  .filter-btn{padding:3px 10px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--muted);font-size:10px;font-weight:700;cursor:pointer;letter-spacing:.04em}
  .filter-btn.active{border-color:currentColor}
  .filter-btn.all.active{color:var(--text);border-color:var(--text)}
  .filter-btn.pass.active{color:var(--green);border-color:var(--green)}
  .filter-btn.block.active{color:var(--red);border-color:var(--red)}
  .filter-btn.hold.active{color:var(--yellow);border-color:var(--yellow)}
  #feed{flex:1;overflow-y:auto;padding:0}
  .event{display:grid;grid-template-columns:120px 60px 160px 1fr 80px;align-items:center;gap:12px;padding:8px 20px;border-bottom:1px solid rgba(42,45,58,.4);cursor:default;transition:.1s}
  .event:hover{background:rgba(255,255,255,.03)}
  .event.new{animation:slideIn .25s ease-out}
  @keyframes slideIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .ts{color:var(--muted);font-size:10px}
  .verdict{font-size:10px;font-weight:700;letter-spacing:.06em;padding:2px 8px;border-radius:8px;text-align:center}
  .verdict.PASS{background:rgba(34,197,94,.12);color:var(--green)}
  .verdict.BLOCK{background:rgba(239,68,68,.12);color:var(--red)}
  .verdict.HOLD{background:rgba(245,158,11,.12);color:var(--yellow)}
  .tool{color:var(--purple);font-size:11px}
  .cmd{color:var(--text);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rules{color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .empty{text-align:center;color:var(--muted);padding:60px 20px;font-size:13px}
  .conn-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:rgba(34,197,94,.1);color:var(--green)}
  .conn-badge.disconnected{background:rgba(239,68,68,.1);color:var(--red)}
  .header-row{display:grid;grid-template-columns:120px 60px 160px 1fr 80px;gap:12px;padding:6px 20px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);flex-shrink:0;background:#13151e}
</style>
</head>
<body>
<header>
  <div class="dot" id="status-dot"></div>
  <h1>Agent Activity — Live</h1>
  <div class="stats">
    <div class="stat">PASS <b id="cnt-pass">0</b></div>
    <div class="stat">BLOCK <b id="cnt-block">0</b></div>
    <div class="stat">HOLD <b id="cnt-hold">0</b></div>
  </div>
  <span class="conn-badge" id="conn-badge">CONNECTING</span>
</header>
<div class="nav">
  <a href="/dashboard">← Dashboard</a>
  <a href="/policies">Policy Editor</a>
  <a href="/agent-blunders">Blunder Log</a>
  <a href="/agent-activity">Live Activity</a>
</div>
<div class="filters">
  <button class="filter-btn all active" onclick="setFilter('all',this)">ALL</button>
  <button class="filter-btn pass" onclick="setFilter('PASS',this)">PASS</button>
  <button class="filter-btn block" onclick="setFilter('BLOCK',this)">BLOCK</button>
  <button class="filter-btn hold" onclick="setFilter('HOLD',this)">HOLD</button>
</div>
<div class="header-row">
  <span>TIME</span><span>VERDICT</span><span>TOOL</span><span>COMMAND / ARGS</span><span>RULES</span>
</div>
<div id="feed"><div class="empty" id="empty-msg">Waiting for agent activity…<br><span style="font-size:11px;margin-top:8px;display:block">Tool calls will appear here in real time as agents make them.</span></div></div>

<script nonce="${nonce}">
let filter = 'all';
let counts = {PASS:0, BLOCK:0, HOLD:0};
const MAX_ROWS = 200;

function setFilter(f, btn) {
  filter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.event').forEach(row => {
    row.style.display = (filter === 'all' || row.dataset.verdict === filter) ? '' : 'none';
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}) +
    '.' + String(d.getMilliseconds()).padStart(3,'0');
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function addEvent(ev) {
  const empty = document.getElementById('empty-msg');
  if (empty) empty.remove();

  counts[ev.verdict] = (counts[ev.verdict]||0) + 1;
  document.getElementById('cnt-pass').textContent  = counts['PASS']  || 0;
  document.getElementById('cnt-block').textContent = counts['BLOCK'] || 0;
  document.getElementById('cnt-hold').textContent  = counts['HOLD']  || 0;

  const feed = document.getElementById('feed');
  const row = document.createElement('div');
  row.className = 'event new';
  row.dataset.verdict = ev.verdict;
  if (filter !== 'all' && ev.verdict !== filter) row.style.display = 'none';

  const rulesText = (ev.ruleNames||[]).join(', ') || (ev.triggeredRules||[]).join(', ') || '—';
  row.innerHTML = \`
    <span class="ts">\${fmtTime(ev.timestamp)}</span>
    <span class="verdict \${esc(ev.verdict)}">\${esc(ev.verdict)}</span>
    <span class="tool">\${esc(ev.toolName)}</span>
    <span class="cmd" title="\${esc(ev.commandArg)}">\${esc(ev.commandArg||'—')}</span>
    <span class="rules" title="\${esc(rulesText)}">\${esc(rulesText)}</span>
  \`;
  feed.insertBefore(row, feed.firstChild);

  // Prune old rows
  const rows = feed.querySelectorAll('.event');
  if (rows.length > ${200}) rows[rows.length-1].remove();
}

function connect() {
  const badge = document.getElementById('conn-badge');
  const dot   = document.getElementById('status-dot');
  const es = new EventSource('/activity-feed/stream');

  es.onopen = () => {
    badge.textContent = 'LIVE';
    badge.className = 'conn-badge';
    dot.style.background = 'var(--green)';
  };

  es.onmessage = (e) => {
    try { addEvent(JSON.parse(e.data)); } catch {}
  };

  es.onerror = () => {
    badge.textContent = 'RECONNECTING';
    badge.className = 'conn-badge disconnected';
    dot.style.background = 'var(--red)';
    es.close();
    setTimeout(connect, 3000);
  };
}

// Also hydrate with recent events
fetch('/activity-feed?limit=50').then(r=>r.json()).then(d => {
  if (d.events && d.events.length > 0) {
    // events are newest-first; add oldest first so they stack correctly
    [...d.events].reverse().forEach(addEvent);
  }
}).catch(()=>{});

connect();
</script>
</body>
</html>`;
}
