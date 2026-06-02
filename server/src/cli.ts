#!/usr/bin/env node
/**
 * cli.ts — Mergen CLI for easy setup and management
 *
 * Usage:
 *   npx mergen-server setup    # Interactive setup wizard
 *   npx mergen-server test     # Validate installation
 *   npx mergen-server start    # Start server
 *   npx mergen-server --help   # Show help
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const VERSION = '1.0.0';

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(msg: string, icon = 'ℹ'): void {
  console.log(`${icon} ${msg}`);
}

function success(msg: string): void {
  console.log(`✓ ${msg}`);
}

function error(msg: string): void {
  console.error(`✗ ${msg}`);
}

function hr(): void {
  console.log('─'.repeat(60));
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function setupCommand(): Promise<void> {
  console.log('🚀 Mergen Setup Wizard\n');
  hr();

  // 1. Check prerequisites
  log('Checking prerequisites...');

  const nodeVersion = parseInt(process.versions.node.split('.')[0]);
  if (nodeVersion < 18) {
    error(`Node.js 18+ required (you have ${process.versions.node})`);
    log('Install from: https://nodejs.org/');
    process.exit(1);
  }
  success(`Node.js ${process.versions.node}`);

  // 2. Detect IDE
  log('\nDetecting IDE...');
  const ide = await detectIDE();
  success(`Found: ${ide}`);

  // 3. Configure IDE
  log(`\nConfiguring ${ide}...`);
  await configureIDE(ide);
  success(`${ide} configured`);

  // 4. Extension setup
  log('\nBrowser extension setup:');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable Developer Mode');
  console.log('  3. Click "Load unpacked"');
  console.log(`  4. Select: ${resolve(__dirname, '../../extension')}`);

  const installed = await ask('\nHave you installed the extension? (y/n): ');
  if (installed.toLowerCase() !== 'y') {
    log('⚠ Extension not installed. You can install it later.', '⚠');
  }

  // 5. Start server
  hr();
  log('\n✨ Setup complete!\n');
  console.log('Next steps:');
  console.log('  1. Start server: mergen-server start');
  console.log('  2. Or run in background: mergen-server start &');
  console.log('  3. Verify setup: mergen-server test\n');

  const startNow = await ask('Start server now? (y/n): ');
  if (startNow.toLowerCase() === 'y') {
    await startCommand();
  }
}

async function testCommand(): Promise<void> {
  console.log('🔍 Testing Mergen installation\n');
  hr();

  const checks = [
    { name: 'Server binary', fn: checkBinary },
    { name: 'Server starts', fn: checkServerStarts },
    { name: 'Health endpoint', fn: checkHealth },
    { name: 'Event ingestion', fn: checkIngest },
    { name: 'IDE configuration', fn: checkIDEConfig },
  ];

  let passed = 0;
  let failed = 0;

  for (const check of checks) {
    process.stdout.write(`${check.name}... `);
    try {
      await check.fn();
      console.log('✓');
      passed++;
    } catch (err) {
      console.log('✗');
      error(`  ${err instanceof Error ? err.message : 'Unknown error'}`);
      failed++;
    }
  }

  hr();
  if (failed === 0) {
    success(`All checks passed (${passed}/${checks.length})`);
    console.log('\n✨ Mergen is ready to use!\n');
  } else {
    error(`${failed} check(s) failed`);
    console.log('\nRun: mergen-server setup');
    process.exit(1);
  }
}

async function ciCommand(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');

  if (!existsSync(serverPath)) {
    error('Server binary not found. Run: npm run build');
    process.exit(1);
  }

  console.log('🤖 Mergen CI health check\n');

  const proc = spawn('node', [serverPath], {
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production', HTTP_PORT: '3099' },
  });

  const BASE = 'http://127.0.0.1:3099';
  let serverReady = false;

  // Collect stderr for error reporting
  const stderrLines: string[] = [];
  proc.stderr.on('data', (d: Buffer) => {
    stderrLines.push(d.toString().trim());
    if (d.toString().includes('HTTP ingest listening')) {
      serverReady = true;
    }
  });

  // Wait up to 10s for server to start
  const startDeadline = Date.now() + 10_000;
  while (!serverReady && Date.now() < startDeadline) {
    await sleep(200);
  }

  if (!serverReady) {
    error('Server did not start within 10s');
    console.error(stderrLines.join('\n'));
    proc.kill();
    process.exit(1);
  }

  let exitCode = 0;

  try {
    // 1. Health check
    process.stdout.write('Health endpoint... ');
    const health = await fetch(`${BASE}/health`);
    if (!health.ok) throw new Error(`/health returned ${health.status}`);
    const hd = await health.json() as { status: string };
    if (hd.status !== 'ok') throw new Error(`status=${hd.status}`);
    console.log('✓');

    // 2. Ingest a test event
    process.stdout.write('Event ingestion... ');
    const ingest = await fetch(`${BASE}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'console',
        level: 'log',
        args: ['mergen-ci-probe'],
        url: 'http://ci.test',
        timestamp: Date.now(),
      }),
    });
    if (!ingest.ok) throw new Error(`/ingest returned ${ingest.status}`);
    console.log('✓');

    success('All CI checks passed');
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    exitCode = 1;
  } finally {
    proc.kill();
  }

  process.exit(exitCode);
}

async function startCommand(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');

  if (!existsSync(serverPath)) {
    error('Server not found. Run: mergen-server setup');
    process.exit(1);
  }

  log('Starting Mergen server...\n');

  // Start server in foreground
  const server = spawn('node', [serverPath], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  server.on('error', (err) => {
    error(`Failed to start: ${err.message}`);
    process.exit(1);
  });

  server.on('exit', (code) => {
    if (code !== 0) {
      error(`Server exited with code ${code}`);
    }
    process.exit(code || 0);
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    log('Stopping server...');
    server.kill('SIGINT');
  });
}

// ── IDE Detection & Configuration ──────────────────────────────────────────────

async function detectIDE(): Promise<string> {
  // Check for Claude Code CLI
  try {
    execSync('which claude', { stdio: 'ignore' });
    return 'claude-code';
  } catch {}

  // Check for Cursor config
  const cursorConfig = resolve(homedir(), '.cursor', 'mcp.json');
  if (existsSync(cursorConfig)) {
    return 'cursor';
  }

  // Check for VS Code
  try {
    execSync('which code', { stdio: 'ignore' });
    return 'vscode';
  } catch {}

  // Check for Windsurf
  const windsurfConfig = resolve(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
  if (existsSync(windsurfConfig)) {
    return 'windsurf';
  }

  // Default
  const answer = await ask('Which IDE? (cursor/claude-code/vscode/windsurf): ');
  return answer || 'cursor';
}

async function configureIDE(ide: string): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');

  switch (ide) {
    case 'claude-code':
      try {
        execSync(`claude mcp add mergen --transport stdio -- node "${serverPath}"`, {
          stdio: 'inherit',
        });
      } catch {
        log('Run manually:', 'ℹ');
        console.log(`  claude mcp add mergen --transport stdio -- node "${serverPath}"`);
      }
      break;

    case 'cursor': {
      const configPath = resolve(homedir(), '.cursor', 'mcp.json');
      const config = {
        mcpServers: {
          mergen: {
            command: 'node',
            args: [serverPath],
          },
        },
      };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      log(`Config written to: ${configPath}`);
      break;
    }

    case 'vscode': {
      const configPath = resolve(homedir(), '.vscode', 'mcp.json');
      const config = {
        mcpServers: {
          mergen: {
            command: 'node',
            args: [serverPath],
          },
        },
      };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      log(`Config written to: ${configPath}`);
      break;
    }

    case 'windsurf': {
      const configPath = resolve(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
      const config = {
        mcpServers: {
          mergen: {
            command: 'node',
            args: [serverPath],
          },
        },
      };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      log(`Config written to: ${configPath}`);
      break;
    }

    default:
      log(`Manual setup required for ${ide}`, '⚠');
      console.log(`  Add this to your IDE config:`);
      console.log(`  { "command": "node", "args": ["${serverPath}"] }`);
  }
}

// ── Validation Checks ──────────────────────────────────────────────────────────

async function checkBinary(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');
  if (!existsSync(serverPath)) {
    throw new Error(`Server not found at ${serverPath}`);
  }
}

async function checkServerStarts(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');
  const proc = spawn('node', [serverPath], { stdio: 'pipe' });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Server did not start within 5s'));
    }, 5000);

    proc.stderr.on('data', (data: Buffer) => {
      if (data.toString().includes('HTTP ingest listening')) {
        proc.kill();
        clearTimeout(timeout);
        resolve();
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function checkHealth(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');
  const proc = spawn('node', [serverPath], { stdio: 'pipe' });

  // Wait for server to start
  await sleep(2000);

  try {
    const response = await fetch('http://127.0.0.1:3000/health');
    if (!response.ok) {
      throw new Error(`Health check returned ${response.status}`);
    }
    const data = await response.json() as { status: string };
    if (data.status !== 'ok') {
      throw new Error(`Health status: ${data.status}`);
    }
  } finally {
    proc.kill();
  }
}

async function checkIngest(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');
  const proc = spawn('node', [serverPath], { stdio: 'pipe' });

  await sleep(2000);

  try {
    const response = await fetch('http://127.0.0.1:3000/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'console',
        level: 'log',
        args: ['Mergen test'],
        url: 'http://test',
        timestamp: Date.now(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Ingest returned ${response.status}`);
    }
  } finally {
    proc.kill();
  }
}

async function checkIDEConfig(): Promise<void> {
  const ide = await detectIDE();

  let configPath: string;
  switch (ide) {
    case 'cursor':
      configPath = resolve(homedir(), '.cursor', 'mcp.json');
      break;
    case 'vscode':
      configPath = resolve(homedir(), '.vscode', 'mcp.json');
      break;
    case 'windsurf':
      configPath = resolve(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
      break;
    case 'claude-code':
      // Check via CLI
      try {
        const output = execSync('claude mcp list', { encoding: 'utf8' });
        if (!output.includes('mergen')) {
          throw new Error('mergen not in claude mcp list');
        }
        return;
      } catch {
        throw new Error('Claude Code not configured');
      }
    default:
      throw new Error(`Unknown IDE: ${ide}`);
  }

  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config.mcpServers?.mergen) {
    throw new Error('mergen not in IDE config');
  }
}

// ── Invite command ─────────────────────────────────────────────────────────────

async function inviteCommand(): Promise<void> {
  // Find the server's external-facing address
  let host = process.env.MERGEN_DASHBOARD_URL ?? '';

  if (!host) {
    // Try to discover the server and suggest the machine's LAN IP
    let port = 3000;
    for (let p = 3000; p <= 3010; p++) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(600) });
        if (r.ok) { port = p; break; }
      } catch {}
    }

    // Get LAN IP
    let lanIp = '127.0.0.1';
    try {
      const { networkInterfaces } = await import('os');
      const ifaces = networkInterfaces();
      for (const iface of Object.values(ifaces)) {
        for (const addr of iface ?? []) {
          if (!addr.internal && addr.family === 'IPv4') { lanIp = addr.address; break; }
        }
      }
    } catch {}

    host = `http://${lanIp}:${port}`;
  }

  // Read the shared secret
  let secret = '';
  try {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');
    secret = readFileSync(join(homedir(), '.mergen', 'secret'), 'utf8').trim();
  } catch {}

  const inviteUrl = `${host}/setup?server=${encodeURIComponent(host)}&token=${encodeURIComponent(secret)}`;

  hr();
  console.log('⬡ Mergen Team Invite\n');
  console.log('Share this URL with your teammate:');
  console.log(`\n  ${inviteUrl}\n`);
  console.log('When they open it, the setup wizard auto-fills the server endpoint and secret.');
  console.log('\nOr they can run:');
  console.log(`  npx mergen-server join "${inviteUrl}"`);
  hr();
  console.log(`\nNote: make sure your Mergen server is reachable from their machine.`);
  console.log(`      If it's local-only, set MERGEN_BIND=0.0.0.0 and restart.`);
}

// ── Join command ────────────────────────────────────────────────────────────────

async function joinCommand(args: string[]): Promise<void> {
  const url = args[1];
  if (!url) {
    error('Usage: mergen-server join <invite-url>');
    process.exit(1);
  }

  let parsed: URL;
  try { parsed = new URL(url); }
  catch { error('Invalid URL: ' + url); process.exit(1); return; }

  const server = parsed.searchParams.get('server') ?? '';
  const token  = parsed.searchParams.get('token') ?? '';

  if (!server) { error('Invite URL missing server parameter'); process.exit(1); }

  console.log('⬡ Joining Mergen team instance...\n');
  log(`Server: ${server}`);

  // Write config so this engineer's Mergen CLI points at the team server
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');

  const configDir = join(homedir(), '.mergen');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'team-server'), server, 'utf8');
  if (token) writeFileSync(join(configDir, 'team-secret'), token, { encoding: 'utf8', mode: 0o600 });

  success(`Team server saved to ~/.mergen/team-server`);

  // Verify connectivity
  try {
    const r = await fetch(`${server}/health`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { success(`Server reachable at ${server}`); }
    else { error(`Server returned ${(await r.json() as {status?:string}).status}`); }
  } catch { error(`Could not reach ${server} — make sure MERGEN_BIND=0.0.0.0 is set on the server`); }

  log(`\nOpen the dashboard: ${server}/dashboard`);
}

// ── Postmortem command ─────────────────────────────────────────────────────────

async function postmortemCommand(args: string[]): Promise<void> {
  let port = 3000;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(600) });
      if (r.ok) { port = p; break; }
    } catch {}
  }

  const hours  = parseFloat(args[1] ?? '1') || 1;
  const sha    = args[2] ?? '';
  const to     = Date.now();
  const from   = to - hours * 60 * 60 * 1000;

  const params = new URLSearchParams({ from: String(Math.round(from)), to: String(to), format: 'md' });
  if (sha) params.set('sha', sha);

  console.log(`Generating postmortem (last ${hours}h)...\n`);

  try {
    const r = await fetch(`http://127.0.0.1:${port}/export/incident?${params}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) { error(`Server returned ${r.status}`); process.exit(1); }
    const md = await r.text();

    const { writeFileSync } = await import('fs');
    const filename = `postmortem-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.md`;
    writeFileSync(filename, md, 'utf8');

    process.stdout.write(md + '\n');
    hr();
    success(`Saved to: ${filename}`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ── Timeline command ───────────────────────────────────────────────────────────

async function timelineCommand(args: string[]): Promise<void> {
  const seconds = parseInt(args[1] ?? '300', 10) || 300;

  // Find server
  let port = 0;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(600) });
      if (r.ok) { port = p; break; }
    } catch {}
  }

  if (!port) {
    error('Server not running. Start with: mergen-server start');
    process.exit(1);
  }

  interface TRow { ts: number; kind: string; summary: string; source?: string; sha?: string }
  interface TRC   { hypothesis: string; confidence: number; fixHint?: string | null }

  let data: { rows?: TRow[]; rootCause?: TRC | null } = {};
  try {
    const r = await fetch(`http://127.0.0.1:${port}/timeline/unified?seconds=${seconds}&limit=100`, { signal: AbortSignal.timeout(3000) });
    data = await r.json() as typeof data;
  } catch {
    error('Failed to fetch timeline');
    process.exit(1);
  }

  const rows = data.rows ?? [];
  const rc   = data.rootCause ?? null;

  const KIND_ICON: Record<string, string> = {
    error: '🔴', warn: '🟡', log: '⬜', request: '🟠', context: '⬜',
    terminal: '💻', process_exit: '💥', ci_failure: '❌', ci_success: '✅', deployment: '🚀',
  };
  const SRC_LABEL: Record<string, string> = {
    browser: 'BROWSER', backend: 'BACKEND', ci: 'CI', deploy: 'DEPLOY',
  };

  hr();
  console.log(`⬡ Mergen Unified Timeline  (last ${Math.round(seconds / 60)}m · ${rows.length} events)\n`);

  if (rc) {
    const pct = Math.round((rc.confidence ?? 0) * 100);
    console.log(`┌─ Root Cause  ${pct}% confidence`);
    console.log(`│  ${rc.hypothesis}`);
    if (rc.fixHint) console.log(`│  💡 ${rc.fixHint}`);
    console.log('└' + '─'.repeat(58));
    console.log('');
  }

  if (rows.length === 0) {
    log('No significant events in this window.');
    log('Connect CI: POST /ci/github or POST /ci/generic');
    log('Stream logs: mergen-server watch npm start');
  } else {
    for (const r of rows) {
      const time  = new Date(r.ts).toISOString().slice(11, 19);
      const icon  = KIND_ICON[r.kind] ?? '⬜';
      const src   = r.source ? `  [${SRC_LABEL[r.source] ?? r.source}]` : '';
      const sha   = r.sha ? `  {${r.sha}}` : '';
      const summary = r.summary.slice(0, 90);
      console.log(`${time}  ${icon}${src.padEnd(12)}  ${summary}${sha}`);
    }
  }

  hr();
}

// ── Watch command ──────────────────────────────────────────────────────────────

async function watchCommand(args: string[]): Promise<void> {
  // mergen watch [--name <name>] [--port <port>] -- <command> [args...]
  // mergen watch npm start
  // mergen watch python manage.py runserver

  let name = '';
  let port = 3000;
  const rest: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) { name = args[++i]; }
    else if (args[i] === '--port' && args[i + 1]) { port = parseInt(args[++i], 10); }
    else if (args[i] === '--') { rest.push(...args.slice(i + 1)); break; }
    else { rest.push(...args.slice(i)); break; }
  }

  if (rest.length === 0) {
    error('Usage: mergen-server watch [--name <name>] [--port <port>] <command> [args...]');
    console.log('  Example: mergen-server watch npm start');
    console.log('  Example: mergen-server watch --name api python manage.py runserver');
    process.exit(1);
  }

  const command = rest[0];
  const cmdArgs = rest.slice(1);
  const processName = name || command;

  // Discover the server port
  let serverPort = port;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { serverPort = p; break; }
    } catch {}
  }

  const mergenHost = process.env.MERGEN_HOST ?? '127.0.0.1';
  const ingestUrl  = `http://${mergenHost}:${serverPort}/ingest`;
  log(`Watching: ${[command, ...cmdArgs].join(' ')}`);
  log(`Streaming to Mergen on ${mergenHost}:${serverPort} as process "${processName}"\n`);

  const { spawn: spawnChild } = await import('child_process');

  const child = spawnChild(command, cmdArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env as Record<string, string>,
    shell: process.platform === 'win32',
  });

  let lineCount = 0;
  let windowStart = Date.now();

  function postLine(data: string, isErr: boolean): void {
    const now = Date.now();
    if (now - windowStart > 1000) { lineCount = 0; windowStart = now; }
    if (lineCount >= 30) return;
    lineCount++;

    const payload = JSON.stringify({
      type: 'terminal',
      terminalName: processName,
      data: (isErr ? '[stderr] ' : '') + data.slice(0, 2000),
      timestamp: Date.now(),
    });

    try {
      const url = new URL(ingestUrl);
      const req = require('http').request({
        hostname: url.hostname, port: parseInt(url.port || '3000'),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      });
      req.on('error', () => {});
      req.write(payload);
      req.end();
    } catch {}
  }

  function pipeProcStream(stream: NodeJS.ReadableStream, isErr: boolean, out: NodeJS.WriteStream): void {
    let buf = '';
    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      out.write(text); // mirror to terminal
      buf += text;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) postLine(l, isErr);
    });
  }

  pipeProcStream(child.stdout!, false, process.stdout);
  pipeProcStream(child.stderr!, true,  process.stderr);

  child.on('error', (err) => {
    error(`Failed to start: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    const reason = code === 137 ? 'oom' : signal ? 'signal' : code !== 0 ? 'crash' : 'normal';
    const payload = JSON.stringify({
      type: 'process_exit', process: processName,
      exitCode: code ?? -1, reason, signal: signal ?? undefined,
      timestamp: Date.now(),
    });
    try {
      const url = new URL(ingestUrl);
      const req = require('http').request({
        hostname: url.hostname, port: parseInt(url.port || '3000'),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      });
      req.on('error', () => {});
      req.write(payload);
      req.end();
    } catch {}
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => { child.kill('SIGINT'); });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); });
}

// ── Status command ─────────────────────────────────────────────────────────────
// Single-screen live snapshot: server health, buffer fill, errors, MCP activity.
// Designed to be run any time an engineer wants to confirm Mergen is wired up.

async function statusCommand(): Promise<void> {
  let port = 0;
  interface HealthData {
    version?: string; buffered?: number; maxBuffer?: number;
    errors?: number; warnings?: number; networkErrors?: number;
    lastEventAt?: number | null; lastMcpCallAt?: number | null;
    signals?: Array<{ kind: string; confidence: number; message: string }>;
  }
  let health: HealthData | null = null;

  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) { health = await r.json() as HealthData; port = p; break; }
    } catch { /* try next port */ }
  }

  console.log('⬡ Mergen Status\n');
  hr();

  if (!health) {
    error('Server not running  (tried :3000–:3010)');
    console.log('\n  Start it:  mergen-server start');
    console.log('  Diagnose:  mergen-server doctor');
    process.exit(1);
  }

  const buffered    = health.buffered     ?? 0;
  const maxBuffer   = health.maxBuffer    ?? 2000;
  const errors      = health.errors       ?? 0;
  const warns       = health.warnings     ?? 0;
  const netErrors   = health.networkErrors ?? 0;
  const lastAt      = health.lastEventAt  ?? null;
  const mcpAt       = health.lastMcpCallAt ?? null;
  const version     = health.version      ?? '?';
  const signals     = health.signals      ?? [];

  const bufPct    = maxBuffer > 0 ? Math.round((buffered / maxBuffer) * 100) : 0;
  const lastStr   = lastAt ? `${Math.round((Date.now() - lastAt)  / 1000)}s ago` : 'none yet';
  const mcpStr    = mcpAt  ? `${Math.round((Date.now() - mcpAt)   / 1000)}s ago` : 'not yet';

  const errLabel = [
    errors    > 0 ? `${errors} console`  : '',
    netErrors > 0 ? `${netErrors} network` : '',
  ].filter(Boolean).join(', ') || 'none';

  console.log(`  Server      http://127.0.0.1:${port}  v${version}`);
  console.log(`  Buffer      ${buffered} / ${maxBuffer}  (${bufPct}% full)`);
  console.log(`  Errors      ${errLabel}`);
  if (warns > 0) console.log(`  Warnings    ${warns}`);
  console.log(`  Last event  ${lastStr}`);
  console.log(`  MCP         ${mcpStr}`);

  if (signals.length > 0) {
    console.log(`\n  Signals (${signals.length} active):`);
    for (const s of signals.slice(0, 3)) {
      console.log(`    [${Math.round(s.confidence * 100)}%] ${s.message}`);
    }
  }

  hr();

  if (!lastAt) {
    console.log('  ⚠ No events yet — open your app in the browser with the Mergen extension active');
    console.log('    Or for Node apps: node --require mergen-server/sdk/node your-app.js');
  } else if (errors === 0 && netErrors === 0) {
    success(`Healthy — server running, events flowing`);
  } else {
    console.log(`  ⚠ ${errors + netErrors} error(s) in buffer`);
    console.log('    Ask your AI: "quick_check"');
  }
}

// ── Doctor command ─────────────────────────────────────────────────────────────

async function doctorCommand(): Promise<void> {
  console.log('🩺 Mergen Doctor\n');
  hr();

  const checks: Array<{ name: string; detail: string; fix: string; warn?: boolean }> = [];
  let passed = 0; let warned = 0; let failed = 0;

  async function runCheck(
    name: string,
    fn: () => Promise<{ ok: boolean; detail: string; fix?: string; warn?: boolean }>,
  ): Promise<void> {
    process.stdout.write(`  ${name}... `);
    try {
      const { ok, detail, fix, warn } = await fn();
      if (ok) {
        console.log(`✓  ${detail}`);
        passed++;
      } else if (warn) {
        console.log(`⚠  ${detail}`);
        if (fix) console.log(`     → ${fix}`);
        warned++;
      } else {
        console.log(`✗  ${detail}`);
        if (fix) console.log(`     → ${fix}`);
        failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${msg}`);
      failed++;
    }
  }

  await runCheck('Node.js version', async () => {
    const ver = parseInt(process.versions.node.split('.')[0]);
    return ver >= 18
      ? { ok: true,  detail: `Node.js ${process.versions.node}` }
      : { ok: false, detail: `Node.js ${process.versions.node} (need ≥18)`, fix: 'Install from https://nodejs.org/' };
  });

  await runCheck('Server binary', async () => {
    const p = resolve(__dirname, 'index.js');
    return existsSync(p)
      ? { ok: true,  detail: p }
      : { ok: false, detail: 'dist/index.js not found', fix: 'cd server && npm run build' };
  });

  await runCheck('Server health', async () => {
    for (let port = 3000; port <= 3010; port++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) {
          const d = await r.json() as { buffered?: number; errors?: number };
          return { ok: true, detail: `running on :${port} — ${d.buffered ?? 0} events buffered, ${d.errors ?? 0} errors` };
        }
      } catch { /* try next port */ }
    }
    return { ok: false, detail: 'server not reachable on :3000–3010', fix: 'mergen-server start' };
  });

  await runCheck('IDE configuration', async () => {
    const ides: string[] = [];
    try { execSync('claude mcp list 2>&1', { encoding: 'utf8' }).includes('mergen') && ides.push('Claude Code'); } catch {}
    const cursorCfg = resolve(homedir(), '.cursor', 'mcp.json');
    if (existsSync(cursorCfg)) {
      try { const c = JSON.parse(readFileSync(cursorCfg, 'utf8')); if (c?.mcpServers?.mergen) ides.push('Cursor'); } catch {}
    }
    const windsurfCfg = resolve(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
    if (existsSync(windsurfCfg)) {
      try { const c = JSON.parse(readFileSync(windsurfCfg, 'utf8')); if (c?.mcpServers?.mergen) ides.push('Windsurf'); } catch {}
    }
    const wsSettings = resolve(homedir(), '.vscode', 'settings.json');
    if (existsSync(wsSettings)) {
      try { const c = JSON.parse(readFileSync(wsSettings, 'utf8')); if (c?.['mcp.servers']?.mergen) ides.push('VS Code'); } catch {}
    }
    return ides.length > 0
      ? { ok: true,  detail: ides.join(', ') }
      : { ok: false, detail: 'no IDE configured', fix: 'mergen-server setup' };
  });

  await runCheck('Browser extension (events)', async () => {
    for (let port = 3000; port <= 3010; port++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
        if (!r.ok) continue;
        const d = await r.json() as { lastEventAt?: number | null };
        const lastMs = d.lastEventAt;
        if (lastMs && Date.now() - lastMs < 24 * 60 * 60 * 1000) {
          return { ok: true, detail: `event received ${Math.round((Date.now() - lastMs) / 1000)}s ago` };
        }
        return { ok: false, warn: true, detail: 'no events received in last 24h', fix: 'open your app in the browser tab with the Mergen extension active, or paste sdk/devtools-snippet.js into DevTools console' };
      } catch { /* try next */ }
    }
    return { ok: false, warn: true, detail: 'server not reachable — skipping extension check', fix: 'start the server first' };
  });

  hr();
  const total = passed + warned + failed;
  if (failed === 0 && warned === 0) {
    success(`All ${total} checks passed — Mergen is healthy ✨`);
  } else if (failed === 0) {
    console.log(`\n${passed}/${total} passed, ${warned} warning(s) — Mergen is functional`);
  } else {
    console.log(`\n${passed}/${total} passed, ${failed} failure(s)`);
    console.log('\nRun: mergen-server setup   to reconfigure');
    process.exit(1);
  }
}

// ── Export command ─────────────────────────────────────────────────────────────

async function exportCommand(args: string[]): Promise<void> {
  const label = args[1] ?? `session-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`;
  const outJson = `./${label}.mergen-report.json`;
  const outHtml = `./${label}.mergen-report.html`;

  console.log('📦 Mergen Export\n');
  hr();

  // Find running server
  let port = 3000;
  let serverFound = false;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) { port = p; serverFound = true; break; }
    } catch {}
  }

  if (!serverFound) {
    error('Server not running. Start with: mergen-server start');
    process.exit(1);
  }

  log(`Fetching session data from :${port}...`);

  const BASE = `http://127.0.0.1:${port}`;

  async function safeFetch(path: string): Promise<unknown> {
    try {
      const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  const [health, lastPack, history, timeline, calibration] = await Promise.all([
    safeFetch('/health'),
    safeFetch('/last-pack'),
    safeFetch('/history?limit=20'),
    safeFetch('/timeline?seconds=3600&limit=500'),
    safeFetch('/calibration'),
  ]) as [
    Record<string, unknown> | null,
    Record<string, unknown> | null,
    { entries?: unknown[] } | null,
    { rows?: unknown[] } | null,
    Record<string, unknown> | null,
  ];

  const report = {
    exported_at: new Date().toISOString(),
    label,
    server: { port, health },
    diagnoses: (history?.entries ?? []),
    latest_analysis: lastPack,
    timeline: (timeline?.rows ?? []),
    calibration,
  };

  writeFileSync(outJson, JSON.stringify(report, null, 2), 'utf8');
  success(`JSON report: ${outJson}`);

  // Generate simple HTML report
  const rows = (timeline?.rows ?? []) as Array<{ isoTs: string; kind: string; summary: string }>;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Mergen Report — ${label}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#222}
h1{font-size:20px;margin-bottom:4px}
.meta{color:#888;font-size:13px;margin-bottom:24px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:6px 10px;background:#f5f5f5;border-bottom:2px solid #ddd}
td{padding:5px 10px;border-bottom:1px solid #eee}
.error{color:#d32}
.warn{color:#b80}
.request{color:#07a}
.context{color:#888}
</style></head><body>
<h1>Mergen Session Report</h1>
<div class="meta">Exported ${report.exported_at} · ${rows.length} events</div>
<table>
<thead><tr><th>Time</th><th>Type</th><th>Summary</th></tr></thead>
<tbody>
${rows.map((r) => `<tr><td>${r.isoTs.slice(11, 19)}</td><td class="${r.kind}">${r.kind}</td><td>${r.summary.replace(/</g, '&lt;')}</td></tr>`).join('\n')}
</tbody></table>
</body></html>`;

  writeFileSync(outHtml, html, 'utf8');
  success(`HTML report:  ${outHtml}`);

  hr();
  const eventCount = rows.length;
  const diagCount  = (report.diagnoses as unknown[]).length;
  console.log(`\n${eventCount} events · ${diagCount} diagnosis session(s) exported`);
  console.log(`\nShare with your team: cat ${outJson} | pbcopy`);
}

// ── Guard command ──────────────────────────────────────────────────────────────

async function guardCommand(args: string[]): Promise<void> {
  const strict = args.includes('--strict');
  const install = args.includes('--install');

  // --install: write a .git/hooks/pre-commit script
  if (install) {
    const hookPath = resolve(process.cwd(), '.git', 'hooks', 'pre-commit');
    if (!existsSync(resolve(process.cwd(), '.git'))) {
      error('Not a git repository. Run from project root.');
      process.exit(1);
    }
    const script = `#!/bin/sh\n# Mergen guard — checks for runtime errors before commit\nmergen-server guard\n`;
    writeFileSync(hookPath, script, { encoding: 'utf8', mode: 0o755 });
    success(`Pre-commit hook installed: ${hookPath}`);
    log('Mergen will now report runtime errors before each commit.');
    return;
  }

  // Find running server (best-effort, never block if server is down)
  type GuardHealth = { errors?: number; warnings?: number; networkErrors?: number; signals?: Array<{ kind: string; message: string; confidence: number }> };
  let health: GuardHealth | null = null;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) { health = await r.json() as GuardHealth; break; }
    } catch {}
  }

  if (!health) {
    log('Mergen: server not running — skipping runtime check', '⬡');
    process.exit(0);
  }

  const errors = health.errors ?? 0;
  const warns  = health.warnings ?? 0;
  const netErr = health.networkErrors ?? 0;
  const sigs   = health.signals ?? [];
  const highSig = sigs.filter((s) => s.confidence >= 0.80);

  hr();
  console.log('⬡ Mergen — pre-commit runtime check\n');

  if (errors === 0 && warns === 0 && netErr === 0 && sigs.length === 0) {
    success('Buffer clean — no errors, warnings, or signals');
  } else {
    if (errors > 0)  console.log(`  ⚠ ${errors} console error(s) in buffer`);
    if (warns > 0)   console.log(`  ⚠ ${warns} console warning(s) in buffer`);
    if (netErr > 0)  console.log(`  ⚠ ${netErr} network error(s) in buffer`);
    for (const s of sigs.slice(0, 3)) {
      const pct = Math.round(s.confidence * 100);
      console.log(`  🔍 [${pct}%] ${s.message}`);
    }
    if (strict && (errors > 0 || highSig.length > 0)) {
      console.log('\n  Ask your AI: "analyze_runtime" before committing');
      hr();
      error('Commit blocked (--strict mode). Fix runtime errors first.');
      process.exit(1);
    }
    log('\nCommit allowed. Run "analyze_runtime" to investigate.');
  }

  hr();
  process.exit(0);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'setup':
      await setupCommand();
      break;

    case 'test':
      await testCommand();
      break;

    case 'start':
      await startCommand();
      break;

    case 'ci':
      await ciCommand();
      break;

    case 'invite':
      await inviteCommand();
      break;

    case 'join':
      await joinCommand(args);
      break;

    case 'postmortem':
      await postmortemCommand(args);
      break;

    case 'timeline':
      await timelineCommand(args);
      break;

    case 'watch':
      await watchCommand(args);
      break;

    case 'status':
      await statusCommand();
      break;

    case 'doctor':
      await doctorCommand();
      break;

    case 'export':
      await exportCommand(args);
      break;

    case 'guard':
      await guardCommand(args);
      break;

    case 'version':
    case '--version':
    case '-v':
      console.log(`mergen-server v${VERSION}`);
      break;

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(`
Mergen — Local-first browser observability for AI

Usage:
  mergen-server status             Live snapshot: server health, buffer, errors, MCP activity
  mergen-server setup              Interactive setup wizard
  mergen-server start              Start the server
  mergen-server watch <cmd>        Stream any process into Mergen (e.g. watch npm start)
  mergen-server doctor             Full health-check wizard (diagnose config issues)
  mergen-server invite             Generate a team invite URL (pre-configured setup link)
  mergen-server join <url>         Join a team Mergen instance from an invite URL
  mergen-server postmortem [h]     Generate a postmortem document (default: last 1 hour)
  mergen-server timeline [seconds] Unified causal timeline (browser + CI + deploy + backend)
  mergen-server export [label]     Export session as JSON + HTML report
  mergen-server guard              Pre-commit runtime check
  mergen-server guard --install    Install as git pre-commit hook
  mergen-server guard --strict     Block commit on errors (use in hook)
  mergen-server test               Validate installation
  mergen-server ci                 CI smoke test (exit 0 = healthy)
  mergen-server --version          Show version
  mergen-server --help             Show this help

Examples:
  npx mergen-server setup
  mergen-server start &
  mergen-server doctor
  mergen-server export my-login-bug
  mergen-server guard --install

Documentation: https://github.com/omertt27/Mergen
      `);
      break;

    default:
      error(`Unknown command: ${command}`);
      console.log('Run: mergen-server --help');
      process.exit(1);
  }
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});
