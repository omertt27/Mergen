import { Router } from 'express';
import { z } from 'zod';
import {
  loadEnterprisePolicy,
  saveEnterprisePolicy,
  EnterprisePolicyRule,
  EnterprisePolicyConfig,
} from '../intelligence/enterprise-policy-engine.js';
import { getRuleFirings } from '../intelligence/gate-analytics.js';

export function createPoliciesRouter(): Router {
  const router = Router();

  // ── GET /policies — HTML UI ──────────────────────────────────────────────────
  router.get('/policies', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildPoliciesHtml());
  });

  // ── GET /policies/json — machine-readable policy + trigger counts ────────────
  router.get('/policies/json', (_req, res) => {
    const policy = loadEnterprisePolicy();
    const firings = getRuleFirings();
    res.json({
      ok: true,
      enabled: policy.enabled,
      rules: policy.rules.map(r => ({ ...r, triggerCount: firings.get(r.id) ?? 0 })),
    });
  });

  // ── PATCH /policies/enabled — toggle policy on/off ───────────────────────────
  router.patch('/policies/enabled', (req, res) => {
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'enabled (boolean) required' }); return; }
    const policy = loadEnterprisePolicy();
    try {
      saveEnterprisePolicy({ ...policy, enabled: body.data.enabled });
      res.json({ ok: true, enabled: body.data.enabled });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /policies/rules — create rule ───────────────────────────────────────
  router.post('/policies/rules', (req, res) => {
    const RuleSchema = z.object({
      id:          z.string().min(1),
      name:        z.string().min(1),
      description: z.string(),
      action:      z.enum(['block', 'warn', 'pass']),
      reason:      z.string(),
      conditions:  z.object({
        files:      z.array(z.string()).optional(),
        commands:   z.array(z.string()).optional(),
        actorType:  z.enum(['ai', 'human', 'all']).optional(),
        daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
        hourWindow: z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(24)]).optional(),
        services:   z.array(z.string()).optional(),
      }),
    });
    const parsed = RuleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
    const policy = loadEnterprisePolicy();
    if (policy.rules.some(r => r.id === parsed.data.id)) {
      res.status(409).json({ error: `Rule id '${parsed.data.id}' already exists` });
      return;
    }
    try {
      saveEnterprisePolicy({ ...policy, rules: [...policy.rules, parsed.data as EnterprisePolicyRule] });
      res.status(201).json({ ok: true, rule: parsed.data });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── PATCH /policies/rules/:id — update rule ──────────────────────────────────
  router.patch('/policies/rules/:id', (req, res) => {
    const { id } = req.params;
    const policy = loadEnterprisePolicy();
    const idx = policy.rules.findIndex(r => r.id === id);
    if (idx === -1) { res.status(404).json({ error: 'Rule not found' }); return; }
    const updated = { ...policy.rules[idx], ...req.body, id } as EnterprisePolicyRule;
    const rules = [...policy.rules];
    rules[idx] = updated;
    try {
      saveEnterprisePolicy({ ...policy, rules });
      res.json({ ok: true, rule: updated });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── DELETE /policies/rules/:id — remove rule ─────────────────────────────────
  router.delete('/policies/rules/:id', (req, res) => {
    const { id } = req.params;
    const policy = loadEnterprisePolicy();
    if (!policy.rules.some(r => r.id === id)) { res.status(404).json({ error: 'Rule not found' }); return; }
    try {
      saveEnterprisePolicy({ ...policy, rules: policy.rules.filter(r => r.id !== id) });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /policies/export — full policy JSON for sync ────────────────────────
  router.get('/policies/export', (_req, res) => {
    const policy = loadEnterprisePolicy();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.json(policy);
  });

  // ── POST /policies/import — replace or merge from remote/exported policy ─────
  router.post('/policies/import', (req, res) => {
    const body = z.object({
      policy: z.object({ enabled: z.boolean(), rules: z.array(z.any()) }),
      mode:   z.enum(['replace', 'merge']).optional().default('replace'),
    }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const incoming = body.data.policy as EnterprisePolicyConfig;
    const mode     = body.data.mode;
    let merged: EnterprisePolicyConfig;

    if (mode === 'merge') {
      const local = loadEnterprisePolicy();
      const existingIds = new Set(local.rules.map(r => r.id));
      const newRules = incoming.rules.filter(r => !existingIds.has(r.id));
      merged = { ...local, rules: [...local.rules, ...newRules] };
    } else {
      merged = incoming;
    }

    try {
      saveEnterprisePolicy(merged);
      res.json({ ok: true, ruleCount: merged.rules.length, mode });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  return router;
}

// ── HTML UI ──────────────────────────────────────────────────────────────────

function buildPoliciesHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Policy Editor · Mergen</title>
<style>
  :root{--bg:#0f1117;--surface:#1a1d26;--border:#2a2d3a;--text:#e2e8f0;--muted:#64748b;
    --green:#22c55e;--yellow:#f59e0b;--red:#ef4444;--blue:#3b82f6;--purple:#a78bfa;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;font-size:13px;line-height:1.6;padding:24px;max-width:1100px;margin:0 auto}
  h1{font-size:18px;font-weight:700;margin-bottom:4px}
  .subtitle{color:var(--muted);font-size:12px;margin-bottom:24px}
  .nav{display:flex;gap:16px;margin-bottom:24px;font-size:12px}
  .nav a{color:var(--blue);text-decoration:none}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px}
  .card-title{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:16px;display:flex;align-items:center;gap:8px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:0 8px 8px;border-bottom:1px solid var(--border)}
  td{padding:10px 8px;border-bottom:1px solid rgba(42,45,58,.6);vertical-align:middle;font-size:12px}
  tr:last-child td{border-bottom:none}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600}
  .badge-block{background:rgba(239,68,68,.15);color:var(--red)}
  .badge-warn{background:rgba(245,158,11,.15);color:var(--yellow)}
  .badge-pass{background:rgba(34,197,94,.15);color:var(--green)}
  .count{font-size:11px;font-weight:700;color:var(--purple);background:rgba(167,139,250,.12);padding:2px 6px;border-radius:6px}
  input,select,textarea{background:#0d0f18;border:1px solid var(--border);color:var(--text);border-radius:4px;padding:4px 8px;font-size:12px;font-family:inherit;width:100%}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--blue)}
  textarea{resize:vertical;min-height:60px}
  .btn{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;transition:.15s}
  .btn-save{background:rgba(59,130,246,.2);color:var(--blue)}
  .btn-save:hover{background:rgba(59,130,246,.35)}
  .btn-delete{background:rgba(239,68,68,.15);color:var(--red)}
  .btn-delete:hover{background:rgba(239,68,68,.3)}
  .btn-add{background:rgba(34,197,94,.15);color:var(--green);padding:6px 14px;font-size:12px}
  .btn-add:hover{background:rgba(34,197,94,.25)}
  .toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px}
  .toggle input{width:auto}
  .flash{position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:6px;font-size:12px;font-weight:600;z-index:999;opacity:0;transition:.3s}
  .flash.show{opacity:1}
  .flash.ok{background:#1a3a2a;border:1px solid var(--green);color:var(--green)}
  .flash.err{background:#3a1a1a;border:1px solid var(--red);color:var(--red)}
  .readonly-rule{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid rgba(42,45,58,.6)}
  .readonly-rule:last-child{border-bottom:none}
  .readonly-rule .name{font-weight:600;font-size:12px;min-width:220px}
  .readonly-rule .desc{color:var(--muted);font-size:11px}
  .section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
  .form-row.single{grid-template-columns:1fr}
  .form-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
</style>
</head>
<body>
<div class="nav"><a href="/dashboard">← Dashboard</a> <a href="/policies">Policy Editor</a></div>
<h1>Policy Editor</h1>
<p class="subtitle">Manage the rules that govern AI agent tool calls. Changes take effect immediately.</p>

<div id="flash" class="flash"></div>

<div class="card" id="toggle-card">
  <div class="card-title">Policy Status</div>
  <label class="toggle">
    <input type="checkbox" id="policy-enabled" onchange="toggleEnabled(this.checked)">
    <span id="enabled-label">Loading…</span>
  </label>
</div>

<div class="card">
  <div class="card-title">Enterprise Rules <span id="rule-count" style="font-weight:400;color:var(--muted);text-transform:none;letter-spacing:0;font-size:11px"></span></div>
  <table>
    <thead><tr>
      <th style="width:220px">Rule</th>
      <th style="width:80px">Action</th>
      <th style="width:60px">Triggers</th>
      <th>Description</th>
      <th style="width:120px"></th>
    </tr></thead>
    <tbody id="rules-body"><tr><td colspan="5" style="color:var(--muted);text-align:center;padding:20px">Loading…</td></tr></tbody>
  </table>
</div>

<div class="card">
  <div class="card-title">Add New Rule</div>
  <div class="form-row">
    <div><div class="form-label">Rule ID</div><input id="new-id" placeholder="e.g. block_prod_deletes" /></div>
    <div><div class="form-label">Name</div><input id="new-name" placeholder="Human-readable name" /></div>
  </div>
  <div class="form-row single"><div class="form-label">Description</div><input id="new-desc" placeholder="What this rule does and why" /></div>
  <div class="form-row">
    <div><div class="form-label">Action</div>
      <select id="new-action"><option value="block">block</option><option value="warn">warn (HITL)</option><option value="pass">pass</option></select>
    </div>
    <div><div class="form-label">Reason (shown in block message)</div><input id="new-reason" placeholder="Why this call is restricted" /></div>
  </div>
  <div class="form-row single"><div class="form-label">Command patterns (comma-separated)</div><textarea id="new-commands" placeholder="terraform destroy, kubectl delete, drop table"></textarea></div>
  <div class="form-row single"><div class="form-label">File patterns (comma-separated, optional)</div><input id="new-files" placeholder="auth, login, migration" /></div>
  <div class="form-row">
    <div><div class="form-label">Actor type</div>
      <select id="new-actor"><option value="">any</option><option value="ai">ai only</option><option value="human">human only</option></select>
    </div>
    <div></div>
  </div>
  <button class="btn btn-add" onclick="addRule()">+ Add Rule</button>
</div>

<div class="card">
  <div class="card-title">Hard Safety Rules <span style="font-weight:400;color:var(--muted);text-transform:none;letter-spacing:0;font-size:11px">(built-in autonomy guardrails — not editable)</span></div>
  <div id="hard-rules">
    <div class="readonly-rule"><div class="name">Blocked keywords</div><div class="desc">rm -rf, drop table, terraform destroy, kubectl delete, truncate, format c:, destroy, nuke, wipe — always blocked before execution, regardless of policy settings.</div></div>
    <div class="readonly-rule"><div class="name">Destructive service mutations</div><div class="desc">Commands that irreversibly mutate or delete cloud resources are blocked by the hard safety layer independent of enterprise policy.</div></div>
  </div>
</div>

<script>
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function flash(msg, ok=true){
  const el=document.getElementById('flash');
  el.textContent=msg; el.className='flash show '+(ok?'ok':'err');
  setTimeout(()=>{el.className='flash';},3000);
}

async function loadPolicy(){
  const d=await fetch('/policies/json').then(r=>r.json());
  document.getElementById('policy-enabled').checked=d.enabled;
  document.getElementById('enabled-label').textContent=d.enabled?'Policy active — gate is enforcing rules':'Policy disabled — all tool calls pass through';
  document.getElementById('rule-count').textContent='('+d.rules.length+' rules)';
  const tbody=document.getElementById('rules-body');
  if(!d.rules.length){tbody.innerHTML='<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:20px">No enterprise rules yet — add one below.</td></tr>';return;}
  tbody.innerHTML=d.rules.map(r=>\`
    <tr id="row-\${escHtml(r.id)}">
      <td><strong>\${escHtml(r.name)}</strong><br><span style="color:var(--muted);font-size:10px">\${escHtml(r.id)}</span></td>
      <td><select id="action-\${escHtml(r.id)}" style="width:auto">
        <option value="block" \${r.action==='block'?'selected':''}>block</option>
        <option value="warn" \${r.action==='warn'?'selected':''}>warn</option>
        <option value="pass" \${r.action==='pass'?'selected':''}>pass</option>
      </select></td>
      <td><span class="count">\${r.triggerCount||0}</span></td>
      <td><input id="desc-\${escHtml(r.id)}" value="\${escHtml(r.description)}" /></td>
      <td style="white-space:nowrap">
        <button class="btn btn-save" onclick="saveRule('\${escHtml(r.id)}')">Save</button>
        <button class="btn btn-delete" onclick="deleteRule('\${escHtml(r.id)}')">Delete</button>
      </td>
    </tr>
  \`).join('');
}

async function toggleEnabled(val){
  document.getElementById('enabled-label').textContent=val?'Policy active — gate is enforcing rules':'Policy disabled — all tool calls pass through';
  const r=await fetch('/policies/enabled',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:val})});
  flash(val?'Policy enabled':'Policy disabled', r.ok);
}

async function saveRule(id){
  const action=document.getElementById('action-'+id).value;
  const description=document.getElementById('desc-'+id).value;
  const r=await fetch('/policies/rules/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,description})});
  flash(r.ok?'Rule saved':'Save failed — '+await r.text(), r.ok);
}

async function deleteRule(id){
  if(!confirm('Delete rule "'+id+'"?')) return;
  const r=await fetch('/policies/rules/'+encodeURIComponent(id),{method:'DELETE'});
  if(r.ok){flash('Rule deleted'); await loadPolicy();}
  else flash('Delete failed','err');
}

async function addRule(){
  const id=document.getElementById('new-id').value.trim();
  const name=document.getElementById('new-name').value.trim();
  const desc=document.getElementById('new-desc').value.trim();
  const action=document.getElementById('new-action').value;
  const reason=document.getElementById('new-reason').value.trim();
  const cmds=document.getElementById('new-commands').value.split(',').map(s=>s.trim()).filter(Boolean);
  const files=document.getElementById('new-files').value.split(',').map(s=>s.trim()).filter(Boolean);
  const actor=document.getElementById('new-actor').value;
  if(!id||!name||!reason){flash('ID, name, and reason are required','err');return;}
  const conditions={};
  if(cmds.length) conditions.commands=cmds;
  if(files.length) conditions.files=files;
  if(actor) conditions.actorType=actor;
  const r=await fetch('/policies/rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name,description:desc,action,reason,conditions})});
  if(r.ok){
    flash('Rule added');
    ['new-id','new-name','new-desc','new-reason','new-commands','new-files'].forEach(f=>document.getElementById(f).value='');
    await loadPolicy();
  } else {
    const e=await r.json();
    flash('Error: '+JSON.stringify(e.error),'err');
  }
}

loadPolicy();
setInterval(loadPolicy, 30_000);
</script>
</body>
</html>`;
}
