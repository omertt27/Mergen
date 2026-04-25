#!/usr/bin/env node
/**
 * mergen — thin CLI wrapper for the Mergen MCP server.
 *
 * Usage:
 *   mergen start          Start the MCP + HTTP server
 *   mergen status         Print current plan, credits, and server health
 *   mergen logs [--n N]   Print the last N console events (default 20)
 *   mergen clear          Clear the event buffer
 *   mergen stop           Send SIGTERM to a running server (finds by PID file)
 */

import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require    = createRequire(import.meta.url);

const SERVER_DIR  = path.resolve(__dirname, '../server');
const SERVER_DIST = path.join(SERVER_DIR, 'dist', 'index.js');
const PID_FILE    = path.join(os.homedir(), '.mergen', 'server.pid');
const PORT_START  = 3000;
const PORT_END    = 3010;

const args = process.argv.slice(2);
const cmd  = args[0] ?? 'help';

// ── Helpers ───────────────────────────────────────────────────────────────────

function findPort(): number | null {
  for (let p = PORT_START; p <= PORT_END; p++) {
    try {
      // Synchronous health check via Node's http module
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

function fetchJson(path_: string, port: number): unknown {
  const raw = execSync(
    `node -e "const h=require('http');const r=h.get('http://127.0.0.1:${port}${path_}',res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{process.stdout.write(d);process.exit(0)});});r.on('error',e=>{console.error(e.message);process.exit(1)});r.setTimeout(3000,()=>process.exit(1));"`,
    { timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] },
  ).toString();
  return JSON.parse(raw);
}

function postEmpty(path_: string, port: number): void {
  execSync(
    `node -e "const h=require('http');const o={hostname:'127.0.0.1',port:${port},path:'${path_}',method:'POST',headers:{'Content-Length':0}};const r=h.request(o,res=>{res.resume();res.on('end',()=>process.exit(0))});r.on('error',e=>{console.error(e.message);process.exit(1)});r.end();"`,
    { timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

function dim(s: string)   { return `\x1b[2m${s}\x1b[0m`; }
function bold(s: string)  { return `\x1b[1m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string)   { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s: string){ return `\x1b[33m${s}\x1b[0m`; }
function blue(s: string)  { return `\x1b[34m${s}\x1b[0m`; }

function creditBar(used: number, total: number): string {
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

  const health = fetchJson('/health', port) as Record<string, unknown>;
  const usage  = fetchJson('/usage',  port) as Record<string, unknown>;

  const included = usage.included as number | null;
  const used     = usage.used     as number;
  const remaining = usage.remaining as number | null;
  const overage  = usage.overage  as number;

  console.log('');
  console.log(green('●') + ' Mergen server is ' + bold('running'));
  console.log('');
  console.log(`  ${bold('Plan:')}     ${usage.planName}  ${dim('v' + health.version)}`);
  console.log(`  ${bold('Period:')}   ${usage.month}  →  resets ${new Date(usage.resetsAt as string).toDateString()}`);
  console.log('');

  if (included === null) {
    console.log(`  ${bold('Credits:')}  ${used} used  ${dim('(unlimited)')}`);
  } else {
    console.log(`  ${bold('Credits:')}  ${creditBar(used, included)}  ${used} / ${included}`);
    if ((usage.lowCredits as boolean)) {
      console.log('           ' + yellow(`⚠ Only ${remaining} credits left this month`));
    }
    if (overage > 0) {
      console.log('');
      console.log(`  ${bold('Overage:')}  ${red(String(overage))} call(s)`);
      console.log(`  ${bold('Est. charge:')}  $${((usage.estimatedOverageCents as number) / 100).toFixed(2)}`);
      console.log(`  ${bold('Billing:')}  ${usage.billingStatus === 'confirmed' ? green('confirmed ✓') : yellow('pending ⏳')}`);
    }
  }

  console.log('');
  console.log(`  ${bold('Buffer:')}   ${blue(String(health.buffered))} events  (${red(String(health.errors))} errors, ${yellow(String(health.warnings))} warnings, ${red(String(health.networkErrors))} net errors)`);
  console.log(`  ${bold('Port:')}     ${port}`);
  console.log('');

} else if (cmd === 'logs') {
  const nFlag = args.indexOf('--n');
  const n     = nFlag !== -1 ? Number(args[nFlag + 1]) || 20 : 20;
  const port  = findPort();
  if (!port) { console.error(red('Server not running.')); process.exit(1); }

  const data = fetchJson(`/health`, port) as Record<string, unknown>;
  // logs aren't exposed via HTTP — remind the user to use MCP / AI assistant
  console.log(dim(`  Buffer: ${data.buffered} events — use your AI assistant (ask "show recent logs") or call the MCP tool get_recent_logs directly.`));

} else if (cmd === 'clear') {
  const port = findPort();
  if (!port) { console.error(red('Server not running.')); process.exit(1); }
  postEmpty('/clear', port);
  console.log(green('✓') + ' Buffer cleared.');

} else {
  console.log(`
${bold('mergen')} — Mergen MCP server CLI

${bold('Commands:')}
  ${blue('mergen start')}           Start the server in the background
  ${blue('mergen stop')}            Stop the background server
  ${blue('mergen status')}          Show plan, credits, buffer stats
  ${blue('mergen clear')}           Clear the event buffer
  ${blue('mergen logs')}            Remind where to read logs

${bold('Options:')}
  --n <number>            Number of log entries (used with logs)

${bold('Environment:')}
  LS_API_KEY              LemonSqueezy API key (for license validation)
  LS_WEBHOOK_SECRET       Webhook signature secret
`);
}
