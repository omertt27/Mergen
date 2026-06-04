#!/usr/bin/env node
/**
 * mergen — thin CLI wrapper for the Mergen MCP server.
 * Built from scripts/mergen.ts. Run: node scripts/mergen.mjs <command>
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_DIR  = path.resolve(__dirname, '../server');
const SERVER_DIST = path.join(SERVER_DIR, 'dist', 'index.js');
const PID_FILE    = path.join(os.homedir(), '.mergen', 'server.pid');
const PORT_START  = 3000;
const PORT_END    = 3010;

const args = process.argv.slice(2);
const cmd  = args[0] ?? 'help';

// ── Helpers ───────────────────────────────────────────────────────────────────

function findPort() {
  for (let p = PORT_START; p <= PORT_END; p++) {
    try {
      const result = execSync(
        `node -e "const h=require('http');const r=h.get('http://127.0.0.1:${p}/health',res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{if(res.statusCode===200){process.stdout.write(d);process.exit(0)}else process.exit(1)});});r.on('error',()=>process.exit(1));r.setTimeout(800,()=>process.exit(1));"`,
        { timeout: 1200, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString();
      const json = JSON.parse(result);
      if (json.ok) return p;
    } catch { /* try next */ }
  }
  return null;
}

function fetchJson(p, port) {
  const raw = execSync(
    `node -e "const h=require('http');const r=h.get('http://127.0.0.1:${port}${p}',res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{process.stdout.write(d);process.exit(0)});});r.on('error',e=>{console.error(e.message);process.exit(1)});r.setTimeout(3000,()=>process.exit(1));"`,
    { timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] },
  ).toString();
  return JSON.parse(raw);
}

function postEmpty(p, port) {
  execSync(
    `node -e "const h=require('http');const o={hostname:'127.0.0.1',port:${port},path:'${p}',method:'POST',headers:{'Content-Length':0}};const r=h.request(o,res=>{res.resume();res.on('end',()=>process.exit(0))});r.on('error',e=>{console.error(e.message);process.exit(1)});r.end();"`,
    { timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

function postJson(p, port, body) {
  const json = JSON.stringify(body);
  const raw = execSync(
    `node -e "const h=require('http');const b=${JSON.stringify(json)};const o={hostname:'127.0.0.1',port:${port},path:'${p}',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}};const r=h.request(o,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{process.stdout.write(d);process.exit(0)})});r.on('error',e=>{console.error(e.message);process.exit(1)});r.setTimeout(8000,()=>process.exit(1));r.write(b);r.end();"`,
    { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
  ).toString();
  return JSON.parse(raw);
}

function deleteReq(p, port) {
  const raw = execSync(
    `node -e "const h=require('http');const o={hostname:'127.0.0.1',port:${port},path:'${p}',method:'DELETE'};const r=h.request(o,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{process.stdout.write(d);process.exit(0)})});r.on('error',e=>{console.error(e.message);process.exit(1)});r.end();"`,
    { timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] },
  ).toString();
  return JSON.parse(raw);
}

const dim    = s => `\x1b[2m${s}\x1b[0m`;
const bold   = s => `\x1b[1m${s}\x1b[0m`;
const green  = s => `\x1b[32m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const blue   = s => `\x1b[34m${s}\x1b[0m`;

function creditBar(used, total) {
  const pct    = Math.min(1, used / total);
  const filled = Math.round(pct * 10);
  const color  = pct >= 1 ? red : pct >= 0.8 ? yellow : green;
  return color('█'.repeat(filled)) + dim('░'.repeat(10 - filled)) + ` ${Math.round(pct * 100)}%`;
}

// ── Commands ──────────────────────────────────────────────────────────────────

if (cmd === 'start') {
  if (!fs.existsSync(SERVER_DIST)) {
    console.error(red('✗ Server not built. Run: cd server && npm run build'));
    process.exit(1);
  }
  console.log(dim('Starting Mergen server…'));
  const child = spawn('node', [SERVER_DIST], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(green('✓') + ` Mergen server started (PID ${child.pid})`);
  console.log(dim('  Listening on http://127.0.0.1:3000'));

} else if (cmd === 'stop') {
  if (!fs.existsSync(PID_FILE)) {
    console.error(yellow('No PID file found — server may not be running.'));
    process.exit(0);
  }
  const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
  try {
    process.kill(Number(pid), 'SIGTERM');
    fs.rmSync(PID_FILE, { force: true });
    console.log(green('✓') + ` Mergen server (PID ${pid}) stopped.`);
  } catch {
    console.error(red('✗') + ` Could not kill PID ${pid} — may already be stopped.`);
    fs.rmSync(PID_FILE, { force: true });
  }

} else if (cmd === 'status') {
  const port = findPort();
  if (!port) {
    console.log(red('●') + ' Mergen server is ' + bold('not running'));
    console.log(dim('  Start it with: mergen start'));
    process.exit(0);
  }

  const health = fetchJson('/health', port);
  const usage  = fetchJson('/usage',  port);

  const { included, used, remaining, overage } = usage;

  console.log('');
  console.log(green('●') + ' Mergen server is ' + bold('running'));
  console.log('');
  console.log(`  ${bold('Plan:')}     ${usage.planName}  ${dim('v' + health.version)}`);
  console.log(`  ${bold('Period:')}   ${usage.month}  →  resets ${new Date(usage.resetsAt).toDateString()}`);
  console.log('');

  if (included === null) {
    console.log(`  ${bold('Credits:')}  ${used} used  ${dim('(unlimited)')}`);
  } else if (included === 0) {
    console.log(`  ${bold('Credits:')}  ${used} used  ${dim('(pay-as-you-go)')}`);
  } else {
    console.log(`  ${bold('Credits:')}  ${creditBar(used, included)}  ${used} / ${included}`);
    if (usage.lowCredits) {
      console.log('           ' + yellow(`⚠ Only ${remaining} credits left this month`));
    }
    if (overage > 0) {
      console.log('');
      console.log(`  ${bold('Overage:')}    ${red(String(overage))} call(s)`);
      console.log(`  ${bold('Est. charge:')} $${(usage.estimatedOverageCents / 100).toFixed(2)}`);
      console.log(`  ${bold('Billing:')}    ${usage.billingStatus === 'confirmed' ? green('confirmed ✓') : yellow('pending ⏳')}`);
    }
  }
  console.log('');
  console.log(`  ${bold('Buffer:')}   ${blue(String(health.buffered))} events  (${red(String(health.errors))} errors, ${yellow(String(health.warnings))} warnings, ${red(String(health.networkErrors))} net errors)`);
  console.log(`  ${bold('Port:')}     ${port}`);
  console.log('');

} else if (cmd === 'clear') {
  const port = findPort();
  if (!port) { console.error(red('Server not running.')); process.exit(1); }
  postEmpty('/clear', port);
  console.log(green('✓') + ' Buffer cleared.');

} else if (cmd === 'doctor') {
  // ── A5: end-to-end health check ──────────────────────────────────────────
  // Shows pass/fail for each link in the chain so the user can see exactly
  // where onboarding is stuck. Exits 0 if everything is green, 1 if any
  // critical step (server or extension) is failing.
  console.log('');
  console.log(bold('Mergen Doctor') + dim(' — checking your install…'));
  console.log('');

  const checks = [];
  function pass(label, detail) { checks.push({ ok: true,  label, detail }); }
  function fail(label, detail) { checks.push({ ok: false, label, detail }); }
  function warn(label, detail) { checks.push({ ok: null,  label, detail }); }

  // 1. Build artifact present
  if (fs.existsSync(SERVER_DIST)) pass('Server build artifact', SERVER_DIST);
  else fail('Server build artifact', `missing — run: cd server && npm install && npm run build`);

  // 2. Server reachable
  const port = findPort();
  if (port) pass('Server running', `http://127.0.0.1:${port}`);
  else fail('Server running', 'no server on 3000–3010 — run: mergen start');

  // 3. Extension talking to server (recent buffer activity)
  let bufferSeen = 0;
  if (port) {
    try {
      const h = fetchJson('/health', port);
      bufferSeen = h.buffered ?? 0;
      if (bufferSeen > 0) pass('Browser extension connected', `${bufferSeen} events in buffer`);
      else warn('Browser extension connected', 'no events yet — open a tab with the extension loaded and reload the page');
    } catch (e) {
      fail('Browser extension connected', String(e.message ?? e));
    }
  }

  // 4. License / plan
  if (port) {
    try {
      const lic = fetchJson('/license', port);
      const planName = lic.plan?.name ?? 'Free';
      const planId   = lic.plan?.id   ?? 'free';
      pass('License plan', `${planName}` + (planId === 'free' ? dim('  (run: mergen activate <key> to upgrade)') : ''));
    } catch { warn('License plan', 'license module unreachable'); }
  }

  // 5. MCP registrations — look for known config files
  const home = os.homedir();
  const mcpHosts = [
    { name: 'Claude Code',  path: path.join(home, '.claude.json') },
    { name: 'Cursor',       path: path.join(home, '.cursor', 'mcp.json') },
    { name: 'Windsurf',     path: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    { name: 'VS Code user', path: path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json') },
  ];
  let registeredHosts = 0;
  for (const host of mcpHosts) {
    try {
      const raw = fs.readFileSync(host.path, 'utf8');
      if (raw.includes('mergen')) registeredHosts++;
    } catch { /* missing file = host not installed */ }
  }
  if (registeredHosts > 0) pass('MCP registered', `${registeredHosts} host(s) — run: mergen status to verify`);
  else warn('MCP registered', 'no host found — run: node scripts/setup.mjs');

  // ── Render ──
  for (const c of checks) {
    const icon = c.ok === true ? green('✓') : c.ok === false ? red('✗') : yellow('!');
    console.log(`  ${icon}  ${bold(c.label)}`);
    if (c.detail) console.log(`     ${dim(c.detail)}`);
  }
  console.log('');

  const failed = checks.filter(c => c.ok === false).length;
  const warned = checks.filter(c => c.ok === null).length;
  if (failed === 0 && warned === 0) {
    console.log(green('All checks passed.') + dim('  Your install is healthy.'));
  } else if (failed === 0) {
    console.log(yellow(`${warned} warning(s).`) + dim('  Mergen will work but some features are inactive.'));
  } else {
    console.log(red(`${failed} failure(s), ${warned} warning(s).`) + dim('  Fix the failures above to start using Mergen.'));
  }
  console.log('');
  process.exit(failed === 0 ? 0 : 1);

} else if (cmd === 'guard') {
  // ── Pre-commit guardrail ────────────────────────────────────────────────
  // The continuous-watch pivot makes a new question possible:
  //   "Are there *unresolved* runtime anomalies right now?"
  // If yes, block the commit (or warn with --warn) so devs don't ship code
  // on top of a broken baseline. Wire into a Husky/lefthook pre-commit hook:
  //
  //     mergen guard --min-confidence MEDIUM
  //
  // Exits 0 when clean, 1 when anomalies of the given severity exist.
  // Always exits 0 if the server isn't running — devs without Mergen
  // installed locally should never have their commits blocked.
  const warnMode = args.includes('--warn');
  const minIdx = args.indexOf('--min-confidence');
  const minConf = (minIdx > -1 ? args[minIdx + 1] : 'HIGH') || 'HIGH';
  const RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };
  const threshold = RANK[String(minConf).toUpperCase()] ?? 3;

  const port = findPort();
  if (!port) {
    console.log(dim('mergen: server not running — guard skipped (commit allowed).'));
    process.exit(0);
  }

  let pack;
  try {
    pack = fetchJson('/last-pack', port);
  } catch (e) {
    console.log(dim('mergen: could not reach /last-pack — guard skipped: ' + e.message));
    process.exit(0);
  }

  if (!pack || !pack.hasPack || !pack.topHypothesis) {
    console.log(green('✓') + ' mergen guard: no pending runtime anomalies.');
    process.exit(0);
  }

  const top = pack.topHypothesis;
  const rank = RANK[top.confidence] ?? 0;
  if (rank < threshold) {
    console.log(green('✓') + ` mergen guard: top hypothesis is ${top.confidence} — below threshold ${minConf.toUpperCase()}.`);
    process.exit(0);
  }

  const banner = warnMode ? yellow('⚠ mergen guard') : red('✗ mergen guard');
  console.log('');
  console.log(banner + dim(' — unresolved runtime anomaly detected'));
  console.log('');
  console.log('  ' + bold(top.confidence) + '  ' + top.summary);
  if (Array.isArray(top.causalPath) && top.causalPath.length > 0) {
    console.log('');
    console.log('  ' + dim('Causal path:'));
    for (const step of top.causalPath.slice(0, 4)) console.log('    ' + dim('· ') + step);
  }
  if (top.fixHint) {
    console.log('');
    console.log('  ' + bold('Fix:') + ' ' + top.fixHint);
  }
  console.log('');
  console.log(dim('  Inspect:  mergen status'));
  console.log(dim('  Override: git commit --no-verify'));
  console.log('');
  process.exit(warnMode ? 0 : 1);

} else if (cmd === 'activate') {
  const key = args[1];
  if (!key) {
    console.error(red('✗') + ' Usage: mergen activate <license-key>');
    console.error(dim('  Your key was emailed to you after purchase.'));
    process.exit(1);
  }
  const port = findPort();
  if (!port) {
    console.error(red('✗') + ' Mergen server is not running. Start it first: mergen start');
    process.exit(1);
  }
  console.log(dim('Activating license…'));
  try {
    const res = postJson('/license', port, { key });
    if (res.ok) {
      console.log(green('✓') + ` License activated — plan: ${bold(res.plan)}, email: ${res.email}`);
    } else {
      console.error(red('✗') + ` Activation failed: ${res.error ?? 'unknown error'}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(red('✗') + ` Activation failed: ${e.message ?? e}`);
    process.exit(1);
  }

} else if (cmd === 'deactivate') {
  const port = findPort();
  if (!port) {
    console.error(red('✗') + ' Mergen server is not running. Start it first: mergen start');
    process.exit(1);
  }
  console.log(dim('Deactivating license…'));
  try {
    const res = deleteReq('/license', port);
    if (res.ok) {
      console.log(green('✓') + ` License deactivated — reverted to ${bold(res.plan)}`);
    } else {
      console.error(red('✗') + ` Deactivation failed: ${res.error ?? 'unknown error'}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(red('✗') + ` Deactivation failed: ${e.message ?? e}`);
    process.exit(1);
  }

} else {
  console.log(`
${bold('mergen')} — Mergen MCP server CLI

${bold('Commands:')}
  ${blue('mergen start')}               Start the MCP server in the background
  ${blue('mergen stop')}                Stop the background server
  ${blue('mergen status')}              Show plan, credits, and buffer stats
  ${blue('mergen doctor')}              End-to-end install health check
  ${blue('mergen clear')}               Clear the event buffer
  ${blue('mergen activate <key>')}      Activate a license key (upgrades from free)
  ${blue('mergen deactivate')}          Deactivate license and revert to free plan
  ${blue('mergen guard')}               Pre-commit: fail if a HIGH-confidence runtime
                             anomaly is unresolved. Flags:
                               --warn                 do not fail, just print
                               --min-confidence LOW|MEDIUM|HIGH  (default HIGH)

${bold('Environment:')}
  LS_API_KEY              LemonSqueezy API key
  LS_WEBHOOK_SECRET       Webhook signature secret
`);
}
