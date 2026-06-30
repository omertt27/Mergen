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

import { execSync, spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };
const VERSION = _pkg.version;

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

async function seedBuiltinRunbooks(): Promise<void> {
  const { mkdirSync: mkd, copyFileSync, existsSync: ex } = await import('fs');
  const { join: j, dirname, resolve: res } = await import('path');
  const { homedir: hd } = await import('os');
  const { fileURLToPath } = await import('url');

  const RUNBOOKS_DIR = j(hd(), '.mergen', 'runbooks', '_builtin');
  mkd(RUNBOOKS_DIR, { recursive: true });

  // Runbooks ship alongside the package in server/runbooks/
  const __filename = fileURLToPath(import.meta.url);
  const pkgRunbooks = res(dirname(__filename), '..', 'runbooks');
  if (!ex(pkgRunbooks)) return; // not present in this environment

  const { readdirSync } = await import('fs');
  let seeded = 0;
  for (const f of readdirSync(pkgRunbooks)) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    const dest = j(RUNBOOKS_DIR, f);
    if (!ex(dest)) {
      copyFileSync(j(pkgRunbooks, f), dest);
      seeded++;
    }
  }
  if (seeded > 0) {
    log(`Seeded ${seeded} built-in runbook${seeded !== 1 ? 's' : ''} → ~/.mergen/runbooks/_builtin/`, '✅');
  }
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function loginCommand(): Promise<void> {
  const { createServer } = await import('http');
  const { exec } = await import('child_process');
  const { activateKey } = await import('./intelligence/license.js');

  const args = process.argv.slice(3);
  const keyIndex = args.indexOf('--key');
  if (keyIndex !== -1 && args[keyIndex + 1]) {
    const key = args[keyIndex + 1];
    log(`Activating license key: ${key.substring(0, 12)}...`);
    try {
      const result = await activateKey(key);
      success(`License activated successfully! Plan: ${result.planId}`);
      process.exit(0);
    } catch (err) {
      error(`Activation failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const server = createServer();
  
  server.listen(0, '127.0.0.1', async () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      error('Failed to bind to local callback server');
      process.exit(1);
    }
    const port = addr.port;
    const loginUrl = `${process.env.MERGEN_APP_URL ?? 'https://app.mergen.dev'}/cli-auth?port=${port}`;
    
    console.log('🚀 Authenticating Mergen CLI...');
    console.log(`\nOpening your browser to:\n  ${loginUrl}\n`);
    
    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${openCmd} "${loginUrl}"`).unref();

    console.log('Waiting for authentication to complete in the browser...');
    console.log('If the browser does not open automatically, copy and paste the URL above.');
    console.log('\nAlternatively, paste your license key manually below:');
    
    const key = await ask('License Key: ');
    if (key && key.trim()) {
      log(`Activating license key: ${key.substring(0, 12)}...`);
      try {
        const result = await activateKey(key.trim());
        success(`License activated successfully! Plan: ${result.planId}`);
        server.close();
        process.exit(0);
      } catch (err) {
        error(`Activation failed: ${(err as Error).message}`);
        server.close();
        process.exit(1);
      }
    }
  });

  server.on('request', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    if (url.pathname === '/callback') {
      const token = url.searchParams.get('token');
      if (!token) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication Failed</h1><p>Missing token in query parameters.</p>');
        error('Authentication failed: missing token in callback');
        server.close();
        process.exit(1);
      }

      try {
        const result = await activateKey(token);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Mergen Authentication Successful</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                background: #0a0a0a;
                color: #ffffff;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
              }
              .card {
                background: #111111;
                border: 1px solid #333333;
                border-radius: 8px;
                padding: 2.5rem;
                text-align: center;
                max-width: 420px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
              }
              h1 { color: #ff6600; font-size: 1.5rem; margin-top: 0; }
              p { color: #888888; font-size: 0.95rem; line-height: 1.5; }
              .checkmark { font-size: 3rem; color: #22c55e; margin-bottom: 1rem; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="checkmark">✓</div>
              <h1>Authentication Successful!</h1>
              <p>Your Mergen CLI has been authorized. You can close this tab and return to your terminal.</p>
            </div>
          </body>
          </html>
        `);
        success(`Successfully authenticated! License plan: ${result.planId}`);
        server.close();
        process.exit(0);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authentication Failed</h1><p>${(err as Error).message}</p>`);
        error(`Authentication failed: ${(err as Error).message}`);
        server.close();
        process.exit(1);
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

async function setupCommand(): Promise<void> {
  // ── Parse flags ─────────────────────────────────────────────────────────────
  const rawArgs = process.argv.slice(3); // skip 'node', 'cli.js', 'setup'
  const yes            = rawArgs.includes('--yes') || rawArgs.includes('-y');
  const skipGitHub     = yes || rawArgs.includes('--skip-github');
  const showTiming     = rawArgs.includes('--time');
  const ideFlag        = (rawArgs.find(a => a.startsWith('--ide='))?.slice(6)) ??
                         (rawArgs.includes('--ide') ? rawArgs[rawArgs.indexOf('--ide') + 1] : null);

  // ── Step timing ─────────────────────────────────────────────────────────────
  const _setupStart = performance.now();
  const _stepTimes: { label: string; ms: number }[] = [];
  let _stepStart = _setupStart;
  function _markStep(label: string): void {
    const ms = performance.now() - _stepStart;
    _stepTimes.push({ label, ms });
    _stepStart = performance.now();
  }

  console.log('🚀 Mergen Setup Wizard\n');
  if (yes) log('Non-interactive mode (--yes)\n', 'ℹ');
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
  _markStep('Prerequisites');

  // 2. Detect IDE
  log('\nDetecting IDE...');
  const ide = ideFlag ?? await detectIDE();
  success(`Found: ${ide}`);
  _markStep('IDE detection');

  // 3. Configure IDE
  log(`\nConfiguring ${ide}...`);
  await configureIDE(ide);
  success(`${ide} configured`);
  _markStep('MCP configuration');

  // 4. Shadow mode — safe first step that needs no PagerDuty
  hr();
  log('\nShadow mode (recommended starting point):');
  console.log('  Shadow mode runs full diagnosis and posts Slack alerts but never executes fixes.');
  console.log('  After 30 days you\'ll have a track record: "Mergen would have been correct 89% of the time."');
  console.log('  That data is what makes enabling autopilot a decision, not a leap of faith.');

  if (!yes) {
    const enableShadow = await ask('\nEnable shadow mode now? (y/n): ');
    if (enableShadow.toLowerCase() === 'y') {
      process.env.MERGEN_SHADOW_MODE = 'true';
      // Persist to .env in cwd so it survives restarts
      const envPath = path.join(process.cwd(), '.env');
      try {
        const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
        if (!existing.includes('MERGEN_SHADOW_MODE')) {
          writeFileSync(envPath, `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}MERGEN_SHADOW_MODE=true\n`);
          success('Shadow mode enabled and written to .env');
        } else {
          success('Shadow mode enabled (MERGEN_SHADOW_MODE already in .env)');
        }
      } catch {
        log('Set MERGEN_SHADOW_MODE=true in your server environment to persist this.', 'ℹ');
        success('Shadow mode enabled for this session');
      }
    } else {
      log('Skipped — enable later: echo "MERGEN_SHADOW_MODE=true" >> .env', 'ℹ');
    }
  }

  // 5. Slack alerts — where you see incidents
  hr();
  log('\nSlack alerts (recommended — where Mergen posts incident analysis):');
  console.log('  Without Slack, Mergen diagnoses silently. With Slack, every incident fires a');
  console.log('  thread: root cause, confidence score, proposed fix, and HITL approve/deny buttons.');

  if (!yes) {
    const enableSlack = await ask('\nConnect Slack now? (y/n): ');
    if (enableSlack.toLowerCase() === 'y') {
      console.log('');
      console.log('  1. Go to https://api.slack.com/apps → Create New App → From manifest');
      console.log('  2. Grant scopes: chat:write, chat:write.public, incoming-webhook');
      console.log('  3. Install to your workspace → copy the Bot User OAuth Token');
      console.log('');
      const slackToken = (await ask('  Bot token (xoxb-...): ')).trim();
      const slackChannel = (await ask('  Channel for alerts (#incidents): ')).trim() || '#incidents';
      if (slackToken) {
        const envPath = path.join(process.cwd(), '.env');
        try {
          const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
          let updated = existing;
          if (!updated.includes('MERGEN_SLACK_BOT_TOKEN')) updated += `\nMERGEN_SLACK_BOT_TOKEN=${slackToken}`;
          if (!updated.includes('MERGEN_SLACK_CHANNEL'))   updated += `\nMERGEN_SLACK_CHANNEL=${slackChannel}`;
          writeFileSync(envPath, updated.trimStart() + '\n', 'utf8');
          success(`Slack configured (channel: ${slackChannel}), written to .env`);
        } catch {
          success('Slack configured for this session');
          log(`Set these in your .env to persist:\n  MERGEN_SLACK_BOT_TOKEN=${slackToken}\n  MERGEN_SLACK_CHANNEL=${slackChannel}`, 'ℹ');
        }
      } else {
        log('No token entered — skipped.', 'ℹ');
      }
    } else {
      log('Skipped. To add later: set MERGEN_SLACK_BOT_TOKEN and MERGEN_SLACK_CHANNEL in .env', 'ℹ');
    }
  }
  _markStep('Slack setup');

  // 6. GitHub intent archive
  hr();
  log('\nGitHub intent archive (optional — powers explain_why):');
  console.log('  Connecting GitHub populates PR history so Mergen can answer "why was this changed?"');
  console.log('  Skip this if you just want incident triage — you can add it later.');

  if (!skipGitHub && !yes) {
    const connectGh = await ask('Connect GitHub now? (y/n): ');
    if (connectGh.toLowerCase() === 'y') {
      await connectCommand(['github']);
      const doBackfill = await ask('\nBackfill historical PRs? Gives explain_why data on day 1. (y/n): ');
      if (doBackfill.toLowerCase() === 'y') {
        await backfillCommand(['github']);
      }
    } else {
      log('Skipped. Run later: mergen-server connect github --repo <owner/repo>', 'ℹ');
    }
  } else {
    log('GitHub step skipped. Run later: mergen-server connect github --repo <owner/repo>', 'ℹ');
  }
  _markStep('GitHub integration');

  // 7. Git Pre-commit Hook (Recommended for Codex / non-VS Code users)
  hr();
  log('\nGit Pre-commit Hook (Recommended):');
  console.log('  Enforces safety rules before each git commit, protecting your repo from');
  console.log('  staged file errors regardless of the editor or AI autocomplete tool you use.');

  if (!yes) {
    const installHook = await ask('\nInstall Git pre-commit guard hook now? (y/n): ');
    if (installHook.toLowerCase() === 'y') {
      try {
        await guardCommand(['--install']);
      } catch (err) {
        error(`Failed to install hook: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    try {
      await guardCommand(['--install']);
    } catch {}
  }
  _markStep('Pre-commit hook');

  // 8. Seed built-in runbooks
  await seedBuiltinRunbooks();
  _markStep('Runbook seed');

  // 9. Summary + start server
  hr();
  log('\n✨ Setup complete!\n');

  if (showTiming) {
    const totalMs = performance.now() - _setupStart;
    const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
    console.log('Setup timing:');
    for (const { label, ms } of _stepTimes) {
      console.log(`  ${pad(label + ':', 26)} ${(ms / 1000).toFixed(1)}s`);
    }
    console.log(`  ${'Total:'.padEnd(26)} ${(totalMs / 1000).toFixed(1)}s\n`);
  }
  console.log('Next steps:');
  console.log('  1. Start server:     mergen-server start');
  console.log('  2. Verify it works:  mergen-server start --then doctor');
  console.log('       (starts server, runs health checks, then keeps server running)');
  console.log('  3. Check shadow log: mergen-server shadow-report');
  console.log('  4. Enable autopilot: echo "MERGEN_AUTOPILOT=true" >> .env\n');
  console.log('If PagerDuty or Datadog aren\'t set up yet, add to .env then restart:');
  console.log('  MERGEN_PAGERDUTY_SECRET=<signing-secret>   # webhook → /webhooks/pagerduty');
  console.log('  DD_API_KEY=...  DD_APP_KEY=...             # trace fetch + validation\n');
  console.log('Save your Day-1 baseline (compare at Day 30):');
  console.log('  mergen-server impact-report --baseline');
  console.log('  mergen-server impact-report --compare      # at Day 30\n');

  if (yes) {
    log('Skipping "start now?" prompt in --yes mode. Run: mergen-server start', 'ℹ');
    return;
  }

  const startNow = await ask('Start server now and run doctor to verify? (y/n): ');
  if (startNow.toLowerCase() === 'y') {
    // Start in background, verify, then switch to foreground
    process.argv = [...process.argv.slice(0, 3), '--then', 'doctor'];
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
  const rawArgs = process.argv.slice(3);
  const thenIdx = rawArgs.indexOf('--then');
  const thenCmd = thenIdx !== -1 ? rawArgs[thenIdx + 1] : null;

  const serverPath = resolve(__dirname, 'index.js');

  if (!existsSync(serverPath)) {
    error('Server not found. Run: mergen-server setup');
    process.exit(1);
  }

  // --then <cmd>: start server in background, wait for health, run cmd, then bring server to foreground
  if (thenCmd) {
    const mergenHost = process.env.MERGEN_HOST ?? '127.0.0.1';
    const srv = spawn('node', [serverPath], {
      stdio: 'ignore', detached: true,
      env: { ...process.env as Record<string, string>, NODE_ENV: 'production' },
    });
    srv.unref();
    process.stdout.write('Starting Mergen server...');
    let serverPort = 3000;
    let ready = false;
    for (let attempt = 0; attempt < 20 && !ready; attempt++) {
      await sleep(500);
      for (let p = 3000; p <= 3010; p++) {
        try {
          const r = await fetch(`http://${mergenHost}:${p}/health`, { signal: AbortSignal.timeout(300) });
          if (r.ok) { serverPort = p; ready = true; break; }
        } catch {}
      }
    }
    console.log(ready ? ` ready on :${serverPort}` : ' (timeout — proceeding anyway)');
    // Run the --then command
    const thenParts = thenCmd.split(/\s+/);
    const thenProc = spawn(thenParts[0], thenParts.slice(1), { stdio: 'inherit' });
    await new Promise<void>((res) => thenProc.on('exit', () => res()));
    // After --then command completes, attach server to foreground
    const fgSrv = spawn('node', [serverPath], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
    fgSrv.on('error', (err) => { error(`Server error: ${err.message}`); process.exit(1); });
    fgSrv.on('exit', (code) => { process.exit(code || 0); });
    process.on('SIGINT', () => { fgSrv.kill('SIGINT'); });
    return;
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
        // Use spawnSync with an args array — never interpolate serverPath into a
        // shell string because paths with spaces or special chars cause injection.
        spawnSync('claude', ['mcp', 'add', 'mergen', '--transport', 'stdio', '--', 'node', serverPath], {
          stdio: 'inherit',
          shell: false,
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

  // Item 4: Discover server — auto-start if not running so `watch` is truly one command.
  const mergenHost = process.env.MERGEN_HOST ?? '127.0.0.1';
  let serverPort = port;
  let serverFound = false;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://${mergenHost}:${p}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { serverPort = p; serverFound = true; break; }
    } catch {}
  }

  if (!serverFound) {
    const serverPath = resolve(__dirname, 'index.js');
    if (existsSync(serverPath)) {
      process.stdout.write('ℹ Starting Mergen server...');
      const { spawn: spawnSrv } = await import('child_process');
      const srv = spawnSrv('node', [serverPath], {
        stdio:    'ignore',
        detached: true,
        env:      { ...process.env as Record<string, string>, NODE_ENV: 'production' },
      });
      srv.unref();
      for (let attempt = 0; attempt < 16 && !serverFound; attempt++) {
        await sleep(500);
        for (let p = 3000; p <= 3010; p++) {
          try {
            const r = await fetch(`http://${mergenHost}:${p}/health`, { signal: AbortSignal.timeout(300) });
            if (r.ok) { serverPort = p; serverFound = true; break; }
          } catch {}
        }
      }
      console.log(serverFound ? ` ✓  :${serverPort}` : ' ✗ (proceeding without server)');
    } else {
      log('Server not found — run: mergen-server setup', '⚠');
    }
  }

  const ingestUrl = `http://${mergenHost}:${serverPort}/ingest`;
  log(`Watching: ${[command, ...cmdArgs].join(' ')}`);
  log(`Streaming to Mergen on ${mergenHost}:${serverPort} as process "${processName}"\n`);

  const { spawn: spawnChild } = await import('child_process');

  const child = spawnChild(command, cmdArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env:   process.env as Record<string, string>,
    shell: process.platform === 'win32',
  });

  let lineCount  = 0;
  let windowStart = Date.now();

  // Item 1: inline analysis — debounce 2s after the last error line then surface
  // the top signal from /health directly in the terminal. No AI IDE required.
  let analysisTimer: ReturnType<typeof setTimeout> | null = null;
  let firstInsightShown = false;

  function scheduleInlineAnalysis(): void {
    if (analysisTimer) clearTimeout(analysisTimer);
    analysisTimer = setTimeout(async () => {
      analysisTimer = null;
      try {
        const r = await fetch(`http://${mergenHost}:${serverPort}/health`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) return;
        const h = await r.json() as { signals?: Array<{ message: string; confidence: number; action: string }> };
        const sigs = h.signals ?? [];
        if (sigs.length === 0) return;
        const top = sigs[0];
        const pct = Math.round(top.confidence * 100);
        const div = '─'.repeat(58);
        process.stdout.write(`\n${div}\n`);
        process.stdout.write(`⬡ Mergen  ${top.message}  [${pct}%]\n`);
        process.stdout.write(`  → ${top.action}\n`);
        if (!firstInsightShown) {
          firstInsightShown = true;
          process.stdout.write(`  ✦ First insight. Run reconstruct_context in your AI IDE for root cause + fix.\n`);
          process.stdout.write(`    Or: mergen-server explain < your-error.log\n`);
        }
        process.stdout.write(`${div}\n\n`);
      } catch { /* non-fatal — never interrupt the process stream */ }
    }, 2000);
  }

  const ERROR_LINE_RE = /\berror\b|exception|fatal|panic|segfault|ETIMEDOUT|ECONNREFUSED|ENOSPC|unhandled/i;

  function postLine(data: string, isErr: boolean): void {
    const now = Date.now();
    if (now - windowStart > 1000) { lineCount = 0; windowStart = now; }
    if (lineCount >= 30) return;
    lineCount++;

    if (ERROR_LINE_RE.test(data)) scheduleInlineAnalysis();

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
        path:     url.pathname, method: 'POST',
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

// ── Explain command ────────────────────────────────────────────────────────────
// Standalone analysis: cat error.log | mergen-server explain
// No server required. Runs the causal detector locally on piped or file input.

async function explainCommand(args: string[]): Promise<void> {
  const filePath = args[0] && args[0] !== '-' ? args[0] : null;

  let text = '';
  if (filePath) {
    if (!existsSync(filePath)) { error(`File not found: ${filePath}`); process.exit(1); }
    text = readFileSync(filePath, 'utf8');
  } else {
    if (process.stdin.isTTY) {
      error('No input. Usage:');
      console.log('  cat error.log | mergen-server explain');
      console.log('  mergen-server explain error.log');
      process.exit(1);
    }
    const chunks: Buffer[] = [];
    process.stdin.resume();
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    text = Buffer.concat(chunks).toString('utf8');
  }

  const rawLines = text.split('\n').filter((l) => l.trim());
  if (rawLines.length === 0) { error('Empty input.'); process.exit(1); }

  // Parse lines into ConsoleEvents — classify by keyword
  const now = Date.now();
  const logs = rawLines.map((line, i) => ({
    type:      'console' as const,
    level:     (/\berror\b|exception|fatal|panic|traceback|segfault|ETIMEDOUT|ECONNREFUSED|ENOSPC/i.test(line)
                  ? 'error'
                  : /\bwarn/i.test(line) ? 'warn' : 'log') as 'error' | 'warn' | 'log',
    args:      [line],
    url:       filePath ?? 'stdin',
    timestamp: now - (rawLines.length - i) * 500,
  }));

  const errorCount = logs.filter((l) => l.level === 'error').length;
  if (errorCount === 0) {
    log(`${rawLines.length} lines read — no error-level patterns detected.`);
    log('Lines matching: error, exception, fatal, panic, ETIMEDOUT, ECONNREFUSED are classified as errors.');
    process.exit(0);
  }

  process.stdout.write(`Analyzing ${rawLines.length} lines (${errorCount} error(s))...`);

  try {
    const { buildCausalChain } = await import('./intelligence/causal.js');
    const causal = await buildCausalChain(logs, [], [], undefined, [], [], [], []);
    console.log(' ✓\n');

    if (causal.hypotheses.length === 0) {
      log('No hypothesis matched — patterns did not align with known failure modes.');
      log('For richer analysis with network context: mergen-server watch <your-command>');
      process.exit(0);
    }

    const top = causal.hypotheses[0];
    const pct = Math.round((top.confidenceScore ?? 0) * 100);

    hr();
    console.log(`Root cause  ${top.confidence} [${pct}%]\n`);
    console.log(`  ${top.summary}\n`);
    if (top.causalPath?.length) {
      console.log('Causal chain:');
      top.causalPath.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
      console.log('');
    }
    if (top.fixHint) {
      console.log(`Fix:  ${top.fixHint.split('.')[0]}.\n`);
    }
    hr();
    if (causal.hypotheses.length > 1) {
      log(`${causal.hypotheses.length - 1} alternative hypothesis(es) considered.`, 'ℹ');
    }
    log('For real-time analysis with network context: mergen-server watch <your-command>', 'ℹ');
  } catch (err) {
    console.log(' ✗');
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
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
    console.log('  ⚠ No events yet — send OpenTelemetry events to the gateway to start');
    console.log('    Or for Node apps: node --require mergen-server/sdk/node your-app.js');
  } else if (errors === 0 && netErrors === 0) {
    success(`Healthy — server running, events flowing`);
  } else {
    console.log(`  ⚠ ${errors + netErrors} error(s) in buffer`);
    console.log('    Ask your AI: "quick_check"');
  }
}

// ── Approve command ─────────────────────────────────────────────────────────────

async function approveCommand(cmdArgs: string[]): Promise<void> {
  const token = cmdArgs[0]?.trim();
  if (!token) {
    error('Token required. Usage: mergen approve <id>');
    process.exit(1);
  }

  // Read the shared secret to authenticate with mutating endpoints
  let secret = '';
  const secretPath = join(homedir(), '.mergen', 'secret');
  if (existsSync(secretPath)) {
    try {
      secret = readFileSync(secretPath, 'utf8').trim();
    } catch {
      // Ignore and proceed
    }
  }

  log('Locating running Mergen gateway server...');
  let port = 3000;
  let discovered = false;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(300) });
      if (r.ok) {
        port = p;
        discovered = true;
        break;
      }
    } catch {}
  }

  if (!discovered) {
    error('No active Mergen server detected on local ports 3000-3010.');
    log('Make sure the server is running: mergen-server start');
    process.exit(1);
  }

  log(`Connecting to server on port ${port}...`);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) {
      headers['x-mergen-secret'] = secret;
    }

    const res = await fetch(`http://127.0.0.1:${port}/hitl/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token }),
    });

    const body = await res.json() as { ok: boolean; error?: string };
    if (res.ok && body.ok) {
      success(`Approved! The blocked tool call will be allowed to proceed.`);
    } else {
      error(`Approval failed: ${body.error ?? 'Unknown error'}`);
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to reach server: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
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

  await runCheck('Telemetry receiving', async () => {
    for (let port = 3000; port <= 3010; port++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
        if (!r.ok) continue;
        const d = await r.json() as { lastEventAt?: number | null; buffered?: number };
        const lastMs = d.lastEventAt;
        if (lastMs && Date.now() - lastMs < 24 * 60 * 60 * 1000) {
          return { ok: true, detail: `${d.buffered ?? 0} events buffered — last received ${Math.round((Date.now() - lastMs) / 1000)}s ago` };
        }
        return { ok: false, warn: true, detail: 'no telemetry in the last 24h', fix: 'point your OTLP exporter at http://127.0.0.1:3000 — or run: mergen-server demo' };
      } catch { /* try next */ }
    }
    return { ok: false, warn: true, detail: 'server not reachable — skipping telemetry check', fix: 'start the server first' };
  });

  await runCheck('Slack integration', async () => {
    const token = process.env.MERGEN_SLACK_BOT_TOKEN;
    const channel = process.env.MERGEN_SLACK_CHANNEL;
    if (!token) return { ok: false, warn: true, detail: 'MERGEN_SLACK_BOT_TOKEN not set', fix: 'set MERGEN_SLACK_BOT_TOKEN=xoxb-... for autonomous incident thread replies' };
    if (!channel) return { ok: false, warn: true, detail: 'MERGEN_SLACK_CHANNEL not set', fix: 'set MERGEN_SLACK_CHANNEL=#incidents' };
    try {
      const r = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      const d = await r.json() as { ok: boolean; team?: string; error?: string };
      return d.ok
        ? { ok: true, detail: `connected — workspace: ${d.team ?? 'unknown'}, channel: ${channel}` }
        : { ok: false, warn: true, detail: `Slack auth failed: ${d.error}`, fix: 'check MERGEN_SLACK_BOT_TOKEN — needs chat:write scope' };
    } catch {
      return { ok: false, warn: true, detail: 'could not reach Slack API', fix: 'check network connectivity' };
    }
  });

  await runCheck('PagerDuty webhook', async () => {
    for (let port = 3000; port <= 3010; port++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
        if (r.ok) {
          return { ok: true, warn: true, detail: `webhook URL: http://your-server:${port}/webhooks/pagerduty`, fix: 'copy this URL into PagerDuty: Services → Integrations → Webhooks' };
        }
      } catch { /* try next */ }
    }
    return { ok: false, warn: true, detail: 'server not reachable', fix: 'start the server first' };
  });

  await runCheck('Autopilot', async () => {
    const enabled = process.env.MERGEN_AUTOPILOT === 'true';
    return enabled
      ? { ok: true,  detail: 'MERGEN_AUTOPILOT=true — autonomous execution enabled at ≥85% confidence' }
      : { ok: false, warn: true, detail: 'MERGEN_AUTOPILOT not set — diagnosis-only mode', fix: 'set MERGEN_AUTOPILOT=true to enable autonomous fix execution' };
  });

  console.log('\n── Optional integrations ──────────────────────────────────────────────────');

  await runCheck('GitHub token', async () => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return { ok: false, warn: true, detail: 'GITHUB_TOKEN not set', fix: 'export GITHUB_TOKEN=ghp_...  # required for PR commenting and backfill' };
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'mergen-doctor' },
        signal: AbortSignal.timeout(3000),
      });
      const d = await r.json() as { login?: string; message?: string };
      return r.ok
        ? { ok: true, detail: `connected — user: ${d.login ?? 'unknown'}` }
        : { ok: false, warn: true, detail: `GitHub auth failed: ${d.message ?? r.status}`, fix: 'check GITHUB_TOKEN at https://github.com/settings/tokens' };
    } catch {
      return { ok: false, warn: true, detail: 'could not reach GitHub API', fix: 'check network connectivity' };
    }
  });

  await runCheck('GitHub webhook secret', async () => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return { ok: false, warn: true, detail: 'GITHUB_WEBHOOK_SECRET not set — PR/push events unauthenticated', fix: 'run: mergen-server connect github --repo <owner/repo>' };
    return { ok: true, detail: 'GITHUB_WEBHOOK_SECRET set — signature verification enabled' };
  });

  await runCheck('Datadog', async () => {
    const apiKey = process.env.DD_API_KEY;
    const appKey = process.env.DD_APP_KEY;
    if (!apiKey) return { ok: false, warn: true, detail: 'DD_API_KEY not set', fix: 'export DD_API_KEY=...  # from https://app.datadoghq.com/organization-settings/api-keys' };
    if (!appKey) return { ok: false, warn: true, detail: 'DD_APP_KEY not set', fix: 'export DD_APP_KEY=...  # from https://app.datadoghq.com/organization-settings/application-keys' };
    const site = process.env.DATADOG_SITE ?? 'datadoghq.com';
    try {
      const r = await fetch(`https://api.${site}/api/v1/validate`, {
        headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey },
        signal: AbortSignal.timeout(4000),
      });
      return r.ok
        ? { ok: true, detail: `connected — site: ${site}` }
        : { ok: false, warn: true, detail: `Datadog auth failed (${r.status})`, fix: 'check DD_API_KEY and DD_APP_KEY — run: mergen-server init' };
    } catch {
      return { ok: false, warn: true, detail: `could not reach api.${site}`, fix: 'check network connectivity' };
    }
  });

  await runCheck('Linear', async () => {
    const apiKey  = process.env.LINEAR_API_KEY;
    const teamId  = process.env.LINEAR_TEAM_ID;
    if (!apiKey) return { ok: false, warn: true, detail: 'LINEAR_API_KEY not set', fix: 'export LINEAR_API_KEY=lin_api_...  # from https://linear.app/settings/api' };
    if (!teamId) return { ok: false, warn: true, detail: 'LINEAR_TEAM_ID not set', fix: 'export LINEAR_TEAM_ID=<team-id>  # from https://linear.app/settings/api' };
    return { ok: true, detail: `LINEAR_API_KEY set, team: ${teamId}` };
  });

  await runCheck('Jira', async () => {
    const baseUrl  = process.env.JIRA_BASE_URL;
    const email    = process.env.JIRA_EMAIL;
    const token    = process.env.JIRA_API_TOKEN;
    const projKey  = process.env.JIRA_PROJECT_KEY;
    if (!baseUrl) return { ok: false, warn: true, detail: 'JIRA_BASE_URL not set', fix: 'export JIRA_BASE_URL=https://yourco.atlassian.net' };
    if (!email)   return { ok: false, warn: true, detail: 'JIRA_EMAIL not set',    fix: 'export JIRA_EMAIL=you@company.com' };
    if (!token)   return { ok: false, warn: true, detail: 'JIRA_API_TOKEN not set', fix: 'create a token at https://id.atlassian.com/manage-profile/security/api-tokens' };
    return projKey
      ? { ok: true, detail: `${baseUrl} · project: ${projKey}` }
      : { ok: false, warn: true, detail: 'JIRA_PROJECT_KEY not set', fix: 'export JIRA_PROJECT_KEY=ENG  # default project; can be overridden per request' };
  });

  await runCheck('Sentry webhook', async () => {
    const secret = process.env.MERGEN_SENTRY_SECRET;
    if (!secret) return { ok: false, warn: true, detail: 'MERGEN_SENTRY_SECRET not set — Sentry webhooks unauthenticated', fix: 'export MERGEN_SENTRY_SECRET=...  # from your Sentry webhook config' };
    return { ok: true, detail: 'MERGEN_SENTRY_SECRET set — signature verification enabled' };
  });

  await runCheck('Redis persistence', async () => {
    const url = process.env.MERGEN_REDIS_URL;
    if (!url) return { ok: false, warn: true, detail: 'MERGEN_REDIS_URL not set — ring buffer lost on restart', fix: 'export MERGEN_REDIS_URL=redis://localhost:6379  # optional but recommended for production' };
    return { ok: true, detail: `MERGEN_REDIS_URL set — buffer persisted at ${url}` };
  });

  // Docker — detect running containers and surface the watcher endpoint.
  // Listed last because it is optional, not a failure if absent.
  await runCheck('Docker containers', async () => {
    try {
      const { execSync: exec2 } = await import('child_process');
      const raw = exec2('docker ps --format "{{.Names}}" 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const names = raw.split('\n').map((s) => s.trim()).filter(Boolean);
      if (names.length === 0) {
        return { ok: false, warn: true, detail: 'Docker running but no containers found', fix: 'Start your app containers, then stream logs: curl -X POST http://127.0.0.1:3000/watchers/docker' };
      }
      const label = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '');
      return {
        ok: false, warn: true,
        detail: `${names.length} container(s) running (${label}) — not yet streaming to Mergen`,
        fix:    `Activate log streaming: curl -X POST http://127.0.0.1:3000/watchers/docker`,
      };
    } catch {
      return { ok: false, warn: true, detail: 'Docker not detected (not installed or not running)', fix: 'Install Docker if you use containers — streaming logs gives Mergen live backend context' };
    }
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

// ── Shadow-report command ──────────────────────────────────────────────────────

async function shadowReportCommand(): Promise<void> {
  let port = 3000;
  let serverFound = false;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) { port = p; serverFound = true; break; }
    } catch {}
  }
  if (!serverFound) { error('Server not running. Start with: mergen-server start'); process.exit(1); }

  const secret = (() => { try { return readFileSync(join(homedir(), '.mergen', 'secret'), 'utf8').trim(); } catch { return ''; } })();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers['x-mergen-secret'] = secret;
  const BASE = `http://127.0.0.1:${port}`;

  const [summaryRes, entriesRes] = await Promise.all([
    fetch(`${BASE}/shadow-report`, { headers, signal: AbortSignal.timeout(5000) }),
    fetch(`${BASE}/shadow-report/entries?limit=20`, { headers, signal: AbortSignal.timeout(5000) }),
  ]);

  const summary = summaryRes.ok ? (await summaryRes.json() as { windowDays?: number; total?: number; humanReviewed?: number; approvalRate?: number | null; recommendation?: string }) : null;
  const entriesData = entriesRes.ok ? (await entriesRes.json() as { entries?: Array<{ recordedAt: number; service: string; incidentTag: string; diagnosisConfidence: number; humanVerdict?: string; command: string | null }> }) : null;

  const W = 60;
  const div = '─'.repeat(W);
  const days = summary?.windowDays ?? 30;
  console.log(`\nShadow Mode Track Record — last ${days} days`);
  console.log(div);

  const entries = entriesData?.entries ?? [];
  if (entries.length === 0) {
    console.log('  No shadow entries yet.');
    console.log('  Shadow mode posts diagnoses without executing fixes.');
    console.log('  Set MERGEN_SHADOW_MODE=true and connect PagerDuty to start.\n');
  } else {
    console.log(` ${'Date'.padEnd(12)}${'Service'.padEnd(12)}${'Tag'.padEnd(26)}${'Conf'.padEnd(6)}Verdict`);
    console.log(div);
    for (const e of entries) {
      const date  = new Date(e.recordedAt).toISOString().slice(0, 10);
      const svc   = (e.service ?? 'unknown').slice(0, 10).padEnd(12);
      const tag   = (e.incidentTag ?? '').replace(/^infra_/, '').slice(0, 24).padEnd(26);
      const conf  = `${e.diagnosisConfidence}%`.padEnd(6);
      const verd  = e.humanVerdict === 'would-approve' ? '✅ approve'
                  : e.humanVerdict === 'would-override' ? '✋ override'
                  : '(unreviewed)';
      console.log(` ${date.padEnd(12)}${svc}${tag}${conf}${verd}`);
    }
    console.log(div);

    const total    = summary?.total ?? entries.length;
    const reviewed = summary?.humanReviewed ?? 0;
    const fpNote   = reviewed >= 5 && summary?.approvalRate != null
      ? `false positive rate: ${Math.round((1 - summary.approvalRate) * 100)}%`
      : `false positive rate: pending (${reviewed} of 5 reviews needed)`;
    console.log(` Total: ${total} entries · ${reviewed} reviewed · ${fpNote}`);
    if (summary?.recommendation) console.log(` ${summary.recommendation}`);
  }

  console.log(`\n Run: mergen-server impact-report   for the full Day-30 deck summary\n`);
}

// ── Allow command ──────────────────────────────────────────────────────────────

async function allowCommand(args: string[]): Promise<void> {
  const { loadEnterprisePolicy, saveEnterprisePolicy } = await import('./intelligence/enterprise-policy-engine.js');

  // Parse flags: --file <glob>, --actor ai|human|all, --service <name>
  const fileIdx   = args.indexOf('--file');
  const actorIdx  = args.indexOf('--actor');
  const svcIdx    = args.indexOf('--service');
  const fileGlob  = fileIdx  !== -1 ? args[fileIdx  + 1] : null;
  const actorFlag = actorIdx !== -1 ? args[actorIdx + 1] : 'all';
  const svcFlag   = svcIdx   !== -1 ? args[svcIdx   + 1] : undefined;

  // First positional arg (not a flag value) is the command pattern
  const positional = args.filter((a, i) => !a.startsWith('--') && (fileIdx === -1 || i !== fileIdx + 1) && (actorIdx === -1 || i !== actorIdx + 1) && (svcIdx === -1 || i !== svcIdx + 1));
  const cmdPattern = positional[0] ?? null;

  if (!cmdPattern && !fileGlob) {
    console.log('Usage: mergen-server allow "<command pattern>"');
    console.log('       mergen-server allow --file "<file glob>"');
    console.log('       mergen-server allow "npm install" --actor ai --service api');
    process.exit(1);
  }

  const actor = (actorFlag === 'ai' || actorFlag === 'human') ? actorFlag : 'all';
  const label = cmdPattern ?? fileGlob!;

  const rule = {
    id:          `allowlist_${Date.now()}`,
    name:        `Allowlist: ${label}`,
    description: `Added via mergen-server allow on ${new Date().toISOString().slice(0, 10)}`,
    action:      'pass' as const,
    reason:      `Explicitly allowed: ${label}`,
    conditions: {
      ...(cmdPattern ? { commands: [cmdPattern] } : {}),
      ...(fileGlob  ? { files:    [fileGlob]   } : {}),
      ...(actor !== 'all' ? { actorType: actor as 'ai' | 'human' } : {}),
      ...(svcFlag ? { services: [svcFlag] } : {}),
    },
  };

  const config = loadEnterprisePolicy();
  config.rules.push(rule);
  saveEnterprisePolicy(config);

  success(`Allowlisted: ${label}`);
  if (actor !== 'all') log(`Actor: ${actor}`, 'ℹ');
  if (svcFlag) log(`Service: ${svcFlag}`, 'ℹ');
  console.log(`\n  Rule id: ${rule.id}`);
  console.log(`  Policy file: ~/.mergen/enterprise-policy.json`);
  console.log(`\n  To remove it: edit ~/.mergen/enterprise-policy.json and delete the rule with this id.\n`);
}

// ── Impact-report command ──────────────────────────────────────────────────────

async function impactReportCommand(args: string[]): Promise<void> {
  const htmlMode     = args.includes('--html');
  const slideMode    = args.includes('--slide');
  const baselineMode = args.includes('--baseline');
  const compareMode  = args.includes('--compare');

  let port = 3000;
  let serverFound = false;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) { port = p; serverFound = true; break; }
    } catch {}
  }
  if (!serverFound) { error('Server not running. Start with: mergen-server start'); process.exit(1); }

  const secret = (() => { try { return readFileSync(join(homedir(), '.mergen', 'secret'), 'utf8').trim(); } catch { return ''; } })();
  const headers: Record<string, string> = {};
  if (secret) headers['x-mergen-secret'] = secret;
  const BASE = `http://127.0.0.1:${port}`;

  if (htmlMode) {
    const res = await fetch(`${BASE}/impact-report?format=html`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { error(`Server returned ${res.status}`); process.exit(1); }
    const html = await res.text();
    const outFile = `./impact-report-${new Date().toISOString().slice(0, 10)}.html`;
    writeFileSync(outFile, html, 'utf8');
    success(`HTML report written to ${outFile}`);
    console.log(`  Open in browser or send to your CISO.\n`);
    return;
  }

  // ── Slide / baseline / compare modes ──────────────────────────────────────
  if (slideMode || baselineMode || compareMode) {
    const res = await fetch(`${BASE}/impact-report?format=slide`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { error(`Server returned ${res.status}`); process.exit(1); }
    const { slide: s } = await res.json() as { slide: Record<string, unknown> };

    const baselinePath = join(homedir(), '.mergen', 'baseline.json');

    if (baselineMode) {
      const { mkdirSync } = await import('fs');
      mkdirSync(join(homedir(), '.mergen'), { recursive: true });
      writeFileSync(baselinePath, JSON.stringify({ ...s, savedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
      success(`Baseline saved to ${baselinePath}`);
      console.log('  Run again at Day 30 with --compare to see the delta.\n');
      _printSlide(s);
      return;
    }

    if (compareMode) {
      let baseline: Record<string, unknown> | null = null;
      try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch {}
      if (!baseline) {
        error('No baseline found. Run: mergen-server impact-report --baseline  on Day 1 first.');
        process.exit(1);
      }
      _printSlideCompare(baseline, s);
      return;
    }

    // --slide: just print the 5 numbers
    _printSlide(s);
    return;
  }

  // ── Default: full terminal report ─────────────────────────────────────────
  const res = await fetch(`${BASE}/impact-report`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) { error(`Server returned ${res.status}`); process.exit(1); }
  const { report: d } = await res.json() as { report: Record<string, unknown> };

  const W = 60;
  const div = '─'.repeat(W);
  const fmtMs = (ms: number | null) => {
    if (ms == null) return 'pending';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  };

  console.log('\nMergen Day-30 Impact Report');
  console.log(div);
  console.log(`Incidents processed:     ${d['totalIncidents']}  (last ${d['windowDays']} days)`);
  console.log(`Resolution rate:         ${d['wouldResolveRate']}%  (${d['wouldResolveCount']} would have resolved autonomously)`);
  console.log(`MTTR delta:              ${fmtMs(d['avgAutonomousMttrMs'] as number | null)} autonomous vs ${fmtMs(d['avgManualMttrMs'] as number | null)} manual`);
  console.log(`False positive rate:     ${d['falsePositiveRate'] != null ? `${Math.round((d['falsePositiveRate'] as number) * 100)}%` : `pending (need ${Math.max(0, 5 - (d['humanReviewedCount'] as number ?? 0))} more human shadow reviews)`}`);
  console.log(`Override corpus:         ${d['overridePatterns']} patterns encoded, ${d['corpusBlockCount']} triggered this window`);

  const blunders = d['agentBlunderSummary'] as { totalPrevented: number; chainVerified: boolean } | undefined;
  if (blunders) {
    const chain = blunders.chainVerified ? '✓' : '!';
    console.log(`Agent blunders blocked:  ${blunders.totalPrevented.toLocaleString()}  (chain ${chain})`);
  }

  console.log(`\nFull deck summary:`);
  const summary = (d['deckSummary'] as string ?? '').match(/.{1,56}(\s|$)/g) ?? [];
  for (const line of summary) console.log(`  ${line.trim()}`);

  console.log(`\nFlags:`);
  console.log(`  --slide      5 pre-agreed numbers, screenshot-ready`);
  console.log(`  --baseline   save Day-1 numbers to compare at Day 30`);
  console.log(`  --compare    show delta vs. saved baseline`);
  console.log(`  --html       write full HTML report to disk`);
  console.log(div + '\n');
}

function _printSlide(s: Record<string, unknown>): void {
  const W = 62;
  const div = '─'.repeat(W);
  const pad = (label: string, value: string) => {
    const dots = '.'.repeat(Math.max(2, W - label.length - value.length - 2));
    return `  ${label} ${dots} ${value}`;
  };
  const pend = (v: unknown) => v == null ? 'pending' : String(v);
  const pct  = (v: unknown) => v == null ? 'pending' : `${v}%`;

  console.log('\nMergen — Pre-agreed Day-30 metrics');
  console.log(div);
  console.log(pad('1. Incidents processed',        `${s['incidents_processed']}`));
  console.log(pad('2. Autonomous resolution rate', pct(s['autonomous_resolution_rate_pct'])));
  console.log(pad('3. MTTR: autonomous / manual',
    `${pend(s['mttr_autonomous_minutes'])}min / ${pend(s['mttr_manual_minutes'])}min`));
  console.log(pad('4. Gate false positive rate',   pct(s['gate_false_positive_rate_pct'])));
  console.log(pad('5. Agent blunders blocked',     `${s['agent_blunders_blocked']}`));
  console.log(div);
  console.log(`  Window: last ${s['windowDays']} days  |  Generated: ${new Date(s['generatedAt'] as string).toLocaleDateString()}`);
  console.log();
}

function _printSlideCompare(baseline: Record<string, unknown>, now: Record<string, unknown>): void {
  const W = 72;
  const div = '─'.repeat(W);
  const delta = (b: unknown, n: unknown, lowerIsBetter = false): string => {
    if (b == null || n == null) return '';
    const diff = Number(n) - Number(b);
    if (diff === 0) return '  (no change)';
    const arrow = diff > 0 ? '+' : '';
    const good  = lowerIsBetter ? diff < 0 : diff > 0;
    return `  ${arrow}${diff} ${good ? '(better)' : '(worse)'}`;
  };

  console.log('\nMergen — Day-1 vs Day-30 comparison');
  console.log(div);
  const row = (label: string, b: unknown, n: unknown, d: string) =>
    console.log(`  ${label.padEnd(34)} ${String(b ?? 'n/a').padStart(10)}  →  ${String(n ?? 'n/a').padEnd(10)}${d}`);

  row('Incidents processed',        baseline['incidents_processed'], now['incidents_processed'], delta(baseline['incidents_processed'], now['incidents_processed']));
  row('Autonomous resolution rate', `${baseline['autonomous_resolution_rate_pct']}%`, `${now['autonomous_resolution_rate_pct']}%`, delta(baseline['autonomous_resolution_rate_pct'], now['autonomous_resolution_rate_pct']));
  row('MTTR autonomous (min)',       baseline['mttr_autonomous_minutes'], now['mttr_autonomous_minutes'], delta(baseline['mttr_autonomous_minutes'], now['mttr_autonomous_minutes'], true));
  row('MTTR manual (min)',           baseline['mttr_manual_minutes'], now['mttr_manual_minutes'], delta(baseline['mttr_manual_minutes'], now['mttr_manual_minutes'], true));
  row('Gate FP rate',               `${baseline['gate_false_positive_rate_pct']}%`, `${now['gate_false_positive_rate_pct']}%`, delta(baseline['gate_false_positive_rate_pct'], now['gate_false_positive_rate_pct'], true));
  row('Agent blunders blocked',     baseline['agent_blunders_blocked'], now['agent_blunders_blocked'], delta(baseline['agent_blunders_blocked'], now['agent_blunders_blocked']));
  console.log(div);
  console.log(`  Baseline saved: ${baseline['savedAt']}`);
  console.log();
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

// ── verify-log command — cryptographic hash-chain audit of the Agent Blunder Log ──

async function verifyLogCommand(): Promise<void> {
  type VerifyResult = {
    ok: boolean;
    valid: boolean;
    truncated?: boolean;
    verified?: number;
    verifiedFrom?: string;
    firstInvalidIdx?: number;
    reason?: string;
    note?: string;
  };

  let port = 3000;
  let result: VerifyResult | null = null;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/agent-blunders/verify`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) { result = await r.json() as VerifyResult; port = p; break; }
    } catch {}
  }

  hr();
  console.log('⬡ Mergen — Agent Blunder Log integrity check\n');

  if (!result) {
    log('Server not running — cannot verify log. Start with: mergen-server start', '⚠');
    process.exit(1);
  }

  if (result.valid) {
    const count = result.verified ?? 0;
    if (count === 0) {
      success(`Log integrity: PASS — ${result.note ?? 'Log is empty'}`);
    } else {
      success(`Log integrity: PASS — ${count} entries verified`);
      if (result.truncated) {
        log(`Chain is partial (ring buffer wrapped) — pre-eviction entries cannot be verified. This is expected, not a tamper signal.`, '⬡');
      }
      if (result.verifiedFrom) {
        log(`Verified from entry: ${result.verifiedFrom}`, '⬡');
      }
    }
    hr();
    console.log(`\n  API: GET http://127.0.0.1:${port}/agent-blunders/verify\n`);
    process.exit(0);
  } else {
    hr();
    error(`Log integrity: FAIL — hash chain broken at entry index ${result.firstInvalidIdx ?? '?'}`);
    if (result.reason) console.error(`  Reason: ${result.reason}`);
    console.error('\n  The Agent Blunder Log may have been tampered with or corrupted.');
    console.error(`  Full details: GET http://127.0.0.1:${port}/agent-blunders/verify`);
    hr();
    process.exit(1);
  }
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
  type GuardHealth  = { errors?: number; warnings?: number; networkErrors?: number; signals?: Array<{ kind: string; message: string; confidence: number }> };
  type CorpusEntry  = { tag: string; total: number; dominantReason: string | null; services: string[]; timePattern: string | null };
  type CorpusResult = { ok: boolean; corpus: CorpusEntry[] };

  let serverPort = 0;
  let health: GuardHealth | null = null;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) { health = await r.json() as GuardHealth; serverPort = p; break; }
    } catch {}
  }

  if (!health) {
    log('Mergen: server not running — skipping runtime check', '⬡');
    process.exit(0);
  }

  // Cross-reference staged git files against the full override corpus.
  // Uses /override-corpus (all entries, any age) so freshly auto-seeded entries
  // from PagerDuty show up immediately — not just entries that are 30+ days old.
  type IncidentHit = { tag: string; service: string; reason: string | null; timePattern: string | null; total: number };
  let incidentHits: IncidentHit[] = [];
  try {
    const { execSync: _exec } = await import('child_process');
    const staged = _exec('git diff --cached --name-only 2>/dev/null', { encoding: 'utf8' }).trim();
    if (staged) {
      const stagedServices = new Set<string>();
      for (const f of staged.split('\n')) {
        const m = f.match(/^(?:services|apps|packages|src)\/([^/]+)\//);
        if (m) stagedServices.add(m[1].toLowerCase());
        const top = f.split('/')[0];
        if (top && !['src', 'test', 'tests', 'docs', '.github', 'scripts', 'config'].includes(top)) {
          stagedServices.add(top.toLowerCase());
        }
      }

      if (stagedServices.size > 0) {
        const r = await fetch(`http://127.0.0.1:${serverPort}/override-corpus`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (r.ok) {
          const body = await r.json() as CorpusResult;
          for (const entry of body.corpus ?? []) {
            const matchedService = entry.services.find(
              (s) => stagedServices.has(s.toLowerCase()),
            );
            if (matchedService) {
              incidentHits.push({
                tag:         entry.tag,
                service:     matchedService,
                reason:      entry.dominantReason,
                timePattern: entry.timePattern,
                total:       entry.total,
              });
            }
          }
        }
      }
    }
  } catch { /* git not available or corpus fetch failed — non-fatal */ }

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

  // Report incident history for staged services
  if (incidentHits.length > 0) {
    console.log('');
    console.log('  ⬡ Incident history for staged services:');
    for (const hit of incidentHits.slice(0, 5)) {
      const reason  = hit.reason  ? ` · ${hit.reason}` : '';
      const pattern = hit.timePattern ? ` · ${hit.timePattern}` : '';
      console.log(`    • ${hit.service} — ${hit.tag}${reason}${pattern} (${hit.total}×)`);
    }
    console.log(`  This is informational. Review corpus: GET /override-corpus`);
  }

  hr();
  process.exit(0);
}

// ── PR command — auto-generate a PR description from Mergen debug history ────────
// Reads the calibration history, recent error patterns, and git log to produce
// a structured PR description the developer can paste directly into GitHub/GitLab/Jira.
// Solves: "PR descriptions take 20 minutes and nobody reads them."

async function prCommand(args: string[]): Promise<void> {
  const copyFlag   = args.includes('--copy');
  const outputFile = args.find(a => a.startsWith('--out='))?.slice(6) ?? null;

  // Discover server
  let port = 3000;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { port = p; break; }
    } catch {}
  }

  // Fetch data from multiple endpoints in parallel
  type HealthData    = { errors?: number; warnings?: number; networkErrors?: number; buffered?: number };
  type CalibData     = { perDetector?: Array<{ tag: string; accuracy: number; verdicts: number; trusted: boolean }> };
  type FreqEntry     = { fingerprint: string; count: number; sample: string };
  type FreqData      = { console?: FreqEntry[]; network?: FreqEntry[] };

  const [health, calibRaw, freqRaw] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/health`,          { signal: AbortSignal.timeout(1500) }).then(r => r.json() as Promise<HealthData>).catch(() => ({} as HealthData)),
    fetch(`http://127.0.0.1:${port}/calibration`,      { signal: AbortSignal.timeout(1500) }).then(r => r.json() as Promise<CalibData>).catch(() => ({} as CalibData)),
    fetch(`http://127.0.0.1:${port}/error-frequency`, { signal: AbortSignal.timeout(1500) }).then(r => r.json() as Promise<FreqData>).catch(() => ({} as FreqData)),
  ]);

  // Git context — current branch, last N commits
  let branch = 'unknown-branch';
  let commits: string[] = [];
  let changedFiles: string[] = [];
  try {
    branch       = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    commits      = execSync('git log origin/main..HEAD --oneline --no-merges 2>/dev/null || git log HEAD~5..HEAD --oneline --no-merges', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    changedFiles = execSync('git diff --name-only origin/main 2>/dev/null || git diff --name-only HEAD~1', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch { /* not a git repo or no remote */ }

  // Current errors in buffer
  const errors  = health.errors  ?? 0;
  const netErrs = health.networkErrors ?? 0;
  const warns   = health.warnings ?? 0;

  // Trusted detector accuracy — did the AI predictions hold up during this work?
  const detectors = calibRaw.perDetector ?? [];
  const trusted   = detectors.filter(d => d.trusted && d.accuracy >= 0.5);
  const suppressed = detectors.filter(d => d.trusted && d.accuracy < 0.2);

  // Build PR description
  const lines: string[] = [];

  lines.push(`## Summary`);
  lines.push('');

  // Derive bullet points from commits
  if (commits.length > 0) {
    for (const c of commits.slice(0, 5)) {
      // Remove the SHA prefix and format as bullet
      const msg = c.replace(/^[0-9a-f]+\s+/, '').replace(/^(fix|feat|chore|refactor|docs|test):\s*/i, '');
      lines.push(`- ${msg}`);
    }
  } else {
    lines.push(`- Changes on branch \`${branch}\``);
  }

  lines.push('');
  lines.push(`## Runtime verification`);
  lines.push('');
  lines.push(`_Captured by Mergen during development on branch \`${branch}\`_`);
  lines.push('');

  if (errors === 0 && netErrs === 0 && warns === 0) {
    lines.push('✅ **Buffer clean** — no console errors, network failures, or warnings at time of PR creation.');
  } else {
    if (errors > 0 || netErrs > 0) {
      lines.push(`⚠️ **${errors + netErrs} error(s) remain in buffer** — review before merging.`);
    }
    if (warns > 0) {
      lines.push(`⚠️ **${warns} warning(s)** in buffer.`);
    }
  }

  // Active error patterns
  const consoleFreq = freqRaw.console ?? [];
  const netFreq     = freqRaw.network ?? [];
  if (consoleFreq.length > 0 || netFreq.length > 0) {
    lines.push('');
    lines.push('**Error patterns seen during development:**');
    for (const e of consoleFreq.slice(0, 3)) {
      lines.push(`- \`${e.fingerprint}\` — ${e.count}× — "${e.sample.slice(0, 80)}"`);
    }
    for (const n of netFreq.slice(0, 2)) {
      lines.push(`- ${n.sample.slice(0, 100)} — ${n.count}×`);
    }
  }

  // Suppressed detectors = patterns Mergen learned to ignore (proof of calibration)
  if (suppressed.length > 0) {
    lines.push('');
    lines.push(`**Suppressed noise patterns:** ${suppressed.map(d => `\`${d.tag}\``).join(', ')}`);
    lines.push('_(Mergen suppresses detectors with < 20% accuracy — these fired but were consistently wrong)_');
  }

  lines.push('');
  lines.push(`## Files changed (${changedFiles.length})`);
  lines.push('');
  const grouped: Record<string, string[]> = {};
  for (const f of changedFiles.slice(0, 20)) {
    const dir = f.includes('/') ? f.split('/').slice(0, 2).join('/') : '.';
    grouped[dir] = grouped[dir] ?? [];
    grouped[dir].push(f);
  }
  for (const [dir, files] of Object.entries(grouped)) {
    lines.push(`**${dir}/**`);
    for (const f of files) lines.push(`- \`${f}\``);
  }
  if (changedFiles.length > 20) lines.push(`_...and ${changedFiles.length - 20} more_`);

  lines.push('');
  lines.push(`## Test plan`);
  lines.push('');
  lines.push('- [ ] Manually reproduced the scenario in the browser');
  lines.push('- [ ] Mergen buffer clean before merge (`mergen-server guard`)');
  lines.push('- [ ] Unit tests pass');
  if (changedFiles.some(f => /api|route|endpoint|controller|handler/i.test(f))) {
    lines.push('- [ ] API contract unchanged (or migration included)');
  }
  if (changedFiles.some(f => /auth|login|token|session/i.test(f))) {
    lines.push('- [ ] Auth flow tested (login, logout, token refresh)');
  }
  lines.push('');
  lines.push(`---`);
  lines.push(`_Generated by [Mergen](https://github.com/omertt27/Mergen) — runtime context captured automatically during development._`);

  const output = lines.join('\n');

  if (outputFile) {
    writeFileSync(outputFile, output, 'utf8');
    success(`PR description written to ${outputFile}`);
  } else if (copyFlag) {
    // Copy to clipboard via pbcopy (macOS), xclip (Linux), clip (Windows)
    try {
      const clipCmd = process.platform === 'darwin' ? 'pbcopy'
        : process.platform === 'win32' ? 'clip'
        : 'xclip -selection clipboard';
      const { execSync: exec2 } = await import('child_process');
      exec2(`echo ${JSON.stringify(output)} | ${clipCmd}`);
      success('PR description copied to clipboard.');
    } catch {
      console.log(output);
      log('(Could not copy to clipboard — output above)');
    }
  } else {
    console.log('\n' + output + '\n');
    log('Tip: --copy to copy to clipboard, --out=pr.md to write to file');
  }
}

// ── Demo command ───────────────────────────────────────────────────────────────

// ── Init command — configure Datadog credentials ───────────────────────────────

// ── Resolved command — explicit incident resolution capture (Option B) ─────────

async function resolvedCommand(args: string[]): Promise<void> {
  const summaryIdx = args.indexOf('--summary');
  const summary = summaryIdx !== -1 ? args[summaryIdx + 1] : undefined;
  const prUrl = args.find((a) => a.startsWith('--pr='))?.slice(5);

  if (!summary && !prUrl) {
    error('Usage: mergen-server resolved --summary "rolled back enable-bulk-capture flag"');
    error('       mergen-server resolved --pr=https://github.com/... --summary "hotfix"');
    process.exit(1);
  }

  let port = 3000;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(600) });
      if (r.ok) { port = p; break; }
    } catch {}
  }

  const body: Record<string, string | boolean> = { resolvedAt: String(Date.now()) };
  if (summary) body.fixSummary = summary;
  if (prUrl)   body.fixPrUrl   = prUrl;

  try {
    const r = await fetch(`http://127.0.0.1:${port}/incidents/resolve-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });

    if (!r.ok) {
      error(`Server returned ${r.status}`);
      process.exit(1);
    }

    const data = await r.json() as {
      ok: boolean;
      id?: number;
      attributionSha?: string;
      attributionConfidence?: number;
    };

    success('Incident marked resolved. MTTR recorded.');
    if (summary) log(`Summary: ${summary}`);

    // Attribution explicit feedback — only prompt when no PR SHA is available
    // (if a PR was provided, SHA comparison is automatic and more reliable)
    if (!prUrl && data.attributionSha && data.attributionConfidence !== undefined) {
      const pct   = Math.round(data.attributionConfidence * 100);
      const sha8  = data.attributionSha.slice(0, 8);
      console.log('');
      console.log(`⬡ Mergen attributed this incident to deploy \`${sha8}\` (${pct}% confidence).`);
      const answer = await ask('  Was that correct? [y/n/skip]: ');
      const lower  = answer.toLowerCase();
      if (lower === 'y' || lower === 'yes' || lower === 'n' || lower === 'no') {
        const attributionCorrect = lower === 'y' || lower === 'yes';
        try {
          await fetch(`http://127.0.0.1:${port}/incidents/resolve-active/attribution-feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: data.id, attributionCorrect }),
            signal: AbortSignal.timeout(3000),
          });
          success(`Attribution feedback recorded: ${attributionCorrect ? 'correct' : 'incorrect'}`);
          if (!attributionCorrect) {
            log('Feedback stored. Attribution weights will improve as more incidents are validated.');
          }
        } catch { /* non-fatal */ }
      } else {
        log('Attribution feedback skipped.');
      }
    }
  } catch {
    error('Server not running or unreachable. Start with: mergen-server start');
    process.exit(1);
  }
}

async function initCommand(): Promise<void> {
  console.log('⬡ Mergen Init — Connect Datadog\n');
  hr();

  const { mkdirSync: mkdir2, writeFileSync: write2, readFileSync: read2, existsSync: exists2 } = await import('fs');
  const { join: join2 } = await import('path');
  const { homedir: home2 } = await import('os');

  const configDir  = join2(home2(), '.mergen');
  const configPath = join2(configDir, 'config.json');

  // Load existing config if present
  let existing: Record<string, unknown> = {};
  if (exists2(configPath)) {
    try { existing = JSON.parse(read2(configPath, 'utf8')) as Record<string, unknown>; } catch {}
  }

  const dd = (existing.datadog ?? {}) as Record<string, string>;

  console.log('You will need:');
  console.log('  - DD_API_KEY  (Datadog → Organization Settings → API Keys)');
  console.log('  - DD_APP_KEY  (Datadog → Organization Settings → Application Keys)');
  console.log('');

  const apiKey = await ask(`Datadog API Key${dd.apiKey ? ' [keep existing]' : ''}: `);
  const appKey = await ask(`Datadog App Key${dd.appKey ? ' [keep existing]' : ''}: `);

  const sites: Record<string, string> = {
    '1': 'datadoghq.com',
    '2': 'datadoghq.eu',
    '3': 'us3.datadoghq.com',
    '4': 'us5.datadoghq.com',
    '5': 'ap1.datadoghq.com',
  };

  console.log('\nDatadog site:');
  console.log('  1. US1 - datadoghq.com (default)');
  console.log('  2. EU  - datadoghq.eu');
  console.log('  3. US3 - us3.datadoghq.com');
  console.log('  4. US5 - us5.datadoghq.com');
  console.log('  5. AP1 - ap1.datadoghq.com');
  const siteChoice = await ask('\nSite [1]: ');
  const site = sites[siteChoice.trim() || '1'] ?? 'datadoghq.com';

  const finalApiKey = apiKey.trim() || dd.apiKey || '';
  const finalAppKey = appKey.trim() || dd.appKey || '';

  if (!finalApiKey || !finalAppKey) {
    error('API Key and App Key are both required.');
    process.exit(1);
  }

  // Test connectivity
  process.stdout.write('\nTesting Datadog connection... ');
  try {
    const res = await fetch(`https://api.${site}/api/v1/validate`, {
      headers: { 'DD-API-KEY': finalApiKey, 'DD-APPLICATION-KEY': finalAppKey },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.log('✗');
      const body = await res.text();
      error(`Auth failed (${res.status}): ${body.slice(0, 100)}`);
      error('Double-check your API Key and App Key in Datadog Organization Settings.');
      process.exit(1);
    }
    console.log('✓');
  } catch (e) {
    console.log('✗');
    error(`Could not reach api.${site}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // Save config
  mkdir2(configDir, { recursive: true });
  const config = {
    ...existing,
    datadog: { apiKey: finalApiKey, appKey: finalAppKey, site },
  };
  write2(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });

  hr();
  success('Datadog credentials saved to ~/.mergen/config.json');
  console.log('');
  console.log('Available MCP tools:');
  console.log('  get_incident_context   → fetch + compact latest error trace');
  console.log('  get_datadog_trace      → compact a specific trace by ID');
  console.log('');
  console.log('PagerDuty auto-trigger (optional):');
  console.log('  Add a webhook in PagerDuty → Service → Webhooks:');
  console.log('  URL: http://127.0.0.1:3000/webhooks/pagerduty');
  console.log('  Type: V3 webhook');
  console.log('');
  log('Restart the server to apply: mergen-server start');
}

async function demoCommand(): Promise<void> {
  const { createServer } = await import('http');
  const { createApp } = await import('./app.js');
  const { loadSeedCorpus, SEED_COUNT } = await import('./seeds/corpus.js');

  console.log('\n⬡ Mergen\n');

  // Seed the replay corpus so replay demos work immediately on first run.
  process.stdout.write('Loading 50 sample incidents...');
  const { loaded } = loadSeedCorpus();
  console.log(` ✓  (${loaded > 0 ? `${loaded} loaded` : `${SEED_COUNT} ready`})`);

  // Show instant causal analysis on a sample incident before the browser opens
  try {
    const { listSnapshotPids, replayIncident } = await import('./intelligence/incident-replay.js');
    const pids = listSnapshotPids().filter((p) => p.startsWith('seed-'));
    if (pids.length > 0) {
      const pid = pids[0]; // seed-001: DB pool exhaustion — most common failure mode
      process.stdout.write('Running causal analysis...');
      const result = await replayIncident(pid);
      if (result) {
        const conf = Math.round((result.replayedHypothesis.confidenceScore ?? 0) * 100);
        // Format tag into a readable label: infra_db_connection_pool → DB connection pool
        const rawTag  = (result.replayedHypothesis.tag ?? 'unknown').replace(/^infra_/, '');
        const label   = rawTag.split('_').map((w, i) => (i === 0 ? w.toUpperCase() : w)).join(' ');
        const fix     = result.replayedHypothesis.fixHint ?? '';
        console.log(` ✓`);
        console.log('');
        console.log(`  Detected:   ${label}  [${conf}% confidence]`);
        if (fix) {
          console.log(`  Fix:        ${fix.split('.')[0]}.`);
        }
        console.log('');
      }
    }
  } catch { /* non-fatal — skip instant analysis if replay not available */ }

  // Scan for an available port — port 3000 is often taken by dev servers.
  const { createServer: createNetServer } = await import('net');
  let port = 3000;
  for (let p = 3000; p <= 3010; p++) {
    const available = await new Promise<boolean>((res) => {
      const probe = createNetServer();
      probe.once('error', () => res(false));
      probe.once('listening', () => { probe.close(() => res(true)); });
      probe.listen(p, '127.0.0.1');
    });
    if (available) { port = p; break; }
    if (p === 3010) {
      error('Ports 3000–3010 are all in use.');
      console.log('  Free one with: lsof -ti:3000 | xargs kill');
      process.exit(1);
    }
    log(`Port ${p} in use — trying ${p + 1}`, '↩');
  }

  process.stdout.write('Starting server...');
  const app = createApp({
    serverVersion: VERSION,
    localSecret: 'demo',
    port,
    bindHost: '127.0.0.1',
  });

  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  const url = `http://localhost:${port}/demo`;

  console.log(` ✓`);
  console.log(`  http://localhost:${port}\n`);
  console.log('────────────────────────────────────────');
  console.log('Connect your stack when ready (all optional):');
  console.log('  Watch any process:  mergen-server watch npm start');
  console.log('  Docker containers:  curl -X POST http://127.0.0.1:3000/watchers/docker');
  console.log('  Add to your IDE:    mergen-server setup');
  console.log('────────────────────────────────────────\n');

  // Open browser — try platform-specific commands.
  const open = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';

  try {
    const { exec } = await import('child_process');
    exec(`${open} "${url}"`);
  } catch { /* ignore if browser open fails */ }

  // Keep running until Ctrl-C.
  process.on('SIGINT', () => {
    console.log('\nDemo server stopped.');
    server.close();
    process.exit(0);
  });

  await new Promise<void>(() => { /* keep alive */ });
}

// ── Connect command ────────────────────────────────────────────────────────────
// mergen connect github --repo <owner/repo> [--token <pat>] [--mergen-url <url>]
//
// Registers the Mergen webhook in the target GitHub repository automatically.
// Eliminates the 4-step manual GitHub UI flow that caused most users to abandon
// setup before the commit_contexts table ever received a single row.

async function connectGitHubCommand(args: string[]): Promise<void> {
  const { randomBytes } = await import('crypto');
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');

  // ── Parse flags ─────────────────────────────────────────────────────────────
  let repo = '';
  let token = process.env.GITHUB_TOKEN ?? '';
  let mergenUrl = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo'       && args[i + 1]) { repo       = args[++i]; continue; }
    if (args[i] === '--token'      && args[i + 1]) { token      = args[++i]; continue; }
    if (args[i] === '--mergen-url' && args[i + 1]) { mergenUrl  = args[++i]; continue; }
    if (args[i].startsWith('--repo='))       { repo      = args[i].slice(7); continue; }
    if (args[i].startsWith('--token='))      { token     = args[i].slice(8); continue; }
    if (args[i].startsWith('--mergen-url=')) { mergenUrl = args[i].slice(13); continue; }
  }

  console.log('\nMergen × GitHub — Automated Webhook Setup\n');
  hr();

  // ── Collect missing inputs ───────────────────────────────────────────────────
  if (!repo) {
    repo = await ask('GitHub repo (owner/repo, e.g. acme/api): ');
    repo = repo.trim();
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    error(`Invalid repo format: "${repo}". Expected owner/repo.`);
    process.exit(1);
  }

  if (!token) {
    console.log('\nA GitHub Personal Access Token with repo:admin scope is required.');
    console.log('Create one at: https://github.com/settings/tokens/new');
    console.log('  → Required scope: "repo" (or "admin:repo_hook" for fine-grained tokens)\n');
    token = await ask('GitHub Personal Access Token: ');
    token = token.trim();
  }
  if (!token) {
    error('Token is required. Set GITHUB_TOKEN env var or pass --token.');
    process.exit(1);
  }

  if (!mergenUrl) {
    const port = process.env.HTTP_PORT ?? '3000';
    const defaultUrl = `http://127.0.0.1:${port}`;
    const input = await ask(`Mergen server URL [${defaultUrl}]: `);
    mergenUrl = input.trim() || defaultUrl;
  }
  mergenUrl = mergenUrl.replace(/\/$/, '');
  const webhookUrl = `${mergenUrl}/webhooks/github`;

  // ── Generate webhook secret ──────────────────────────────────────────────────
  const webhookSecret = randomBytes(32).toString('hex');

  // ── Check if webhook already exists ─────────────────────────────────────────
  process.stdout.write('\nChecking existing webhooks... ');
  let existingId: number | null = null;
  try {
    const listRes = await fetch(`https://api.github.com/repos/${repo}/hooks`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!listRes.ok) {
      console.log('✗');
      const body = await listRes.text();
      if (listRes.status === 401) {
        error('GitHub authentication failed. Check your personal access token.');
      } else if (listRes.status === 403) {
        error('Permission denied. Token needs "repo" or "admin:repo_hook" scope.');
      } else if (listRes.status === 404) {
        error(`Repository "${repo}" not found. Check the name and token permissions.`);
      } else {
        error(`GitHub API error ${listRes.status}: ${body.slice(0, 150)}`);
      }
      process.exit(1);
    }
    const hooks = await listRes.json() as Array<{ id: number; config: { url: string } }>;
    const existing = hooks.find((h) => h.config?.url?.includes('/webhooks/github'));
    if (existing) {
      existingId = existing.id;
      console.log(`✓ (found existing Mergen webhook id=${existingId})`);
    } else {
      console.log('✓ (none found)');
    }
  } catch (e) {
    console.log('✗');
    error(`Could not reach GitHub API: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // ── Create or update webhook ─────────────────────────────────────────────────
  const hookPayload = {
    name: 'web',
    active: true,
    events: ['pull_request', 'pull_request_review', 'push'],
    config: {
      url: webhookUrl,
      content_type: 'json',
      secret: webhookSecret,
      insecure_ssl: '0',
    },
  };

  if (existingId) {
    process.stdout.write(`Updating webhook ${existingId}... `);
  } else {
    process.stdout.write('Registering webhook... ');
  }

  try {
    const method  = existingId ? 'PATCH' : 'POST';
    const hookUrl = existingId
      ? `https://api.github.com/repos/${repo}/hooks/${existingId}`
      : `https://api.github.com/repos/${repo}/hooks`;

    const createRes = await fetch(hookUrl, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(hookPayload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!createRes.ok) {
      console.log('✗');
      const body = await createRes.text();
      error(`GitHub API error ${createRes.status}: ${body.slice(0, 200)}`);
      process.exit(1);
    }

    const hook = await createRes.json() as { id: number };
    console.log(`✓  (id=${hook.id})`);
  } catch (e) {
    console.log('✗');
    error(`Webhook registration failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // ── Persist the secret so the server can verify incoming payloads ────────────
  const configDir  = join(homedir(), '.mergen');
  const configPath = join(configDir, 'config.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try { existing = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>; } catch {}
  }
  mkdirSync(configDir, { recursive: true });

  const github = (existing.github ?? {}) as Record<string, unknown>;
  const repos  = (github.repos as string[] | undefined) ?? [];
  if (!repos.includes(repo)) repos.push(repo);

  const config = {
    ...existing,
    github: { ...github, webhookSecret, repos, token },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });

  // Write the secret to a standalone file so the server can load it without
  // parsing the full config (mirrors the pattern used by SECRET_FILE).
  const secretFile = join(configDir, 'github-webhook-secret');
  writeFileSync(secretFile, webhookSecret, { encoding: 'utf8', mode: 0o600 });

  // ── Summary ──────────────────────────────────────────────────────────────────
  hr();
  success(`GitHub webhook registered for ${repo}`);
  console.log('');
  console.log('What happens next:');
  console.log('  · Every merged PR now populates the intent archive automatically');
  console.log('  · In your AI IDE: ask "explain why service X has a 30s timeout"');
  console.log('  · The archive grows with every commit — no manual steps needed');
  console.log('');
  console.log('To verify the webhook is receiving events:');
  console.log('  mergen-server doctor   (checks GitHub webhook status)');
  console.log('');

  log('Restart the server to load the new secret: mergen-server start', 'ℹ');

  // Set in current process so a subsequent `mergen-server start` in the same
  // shell session picks it up immediately.
  process.env.GITHUB_WEBHOOK_SECRET = webhookSecret;
}

// ── Replay command ─────────────────────────────────────────────────────────────
// mergen-server replay <directory>
//
// Runs each .json incident file in <directory> through the causal pipeline and
// prints a scored accuracy report. No server process required.
//
// Incident file format:
//   {
//     "name":         "optional human-readable name",
//     "description":  "optional context string",
//     "expected_tag": "optional — e.g. infra_db_connection_pool",
//     "logs":         [...ConsoleEvent[]],
//     "network":      [...NetworkEvent[]],
//     "infra_events": [...InfraEvent[]],
//     "log_lines":    ["ERROR: Too many connections"],  // auto-converted
//     "firedAt":      1234567890000
//   }

async function replayCommand(args: string[]): Promise<void> {
  const dir = args[0];
  if (!dir) {
    error('Usage: mergen-server replay <directory>');
    console.log('\nRun historical incidents through the causal pipeline and score accuracy.');
    console.log('\nIncident file format (any .json file in the directory):');
    console.log('  {');
    console.log('    "name":         "db-pool-exhaustion-2024-01-15",');
    console.log('    "expected_tag": "infra_db_connection_pool",');
    console.log('    "log_lines":    ["ERROR: Too many connections to postgres:5432"]');
    console.log('  }');
    process.exit(1);
  }

  const { readdirSync, readFileSync, existsSync, statSync } = await import('fs');
  const { basename } = await import('path');

  const dirPath = resolve(dir);
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    error(`Not a directory: ${dirPath}`);
    process.exit(1);
  }

  const files = readdirSync(dirPath)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    error(`No .json incident files found in ${dirPath}`);
    console.log('\nCreate an incident file like this:');
    console.log('  { "name": "my-incident", "expected_tag": "infra_db_connection_pool",');
    console.log('    "log_lines": ["ERROR: Too many connections"] }');
    process.exit(1);
  }

  const { buildCausalChain } = await import('./intelligence/causal.js') as {
    buildCausalChain: (...args: unknown[]) => Promise<{
      hypotheses: Array<{ tag: string; confidenceScore: number; fixHint: string | null }>;
    }>;
  };

  console.log(`\nMergen Production Replay — ${files.length} incident${files.length !== 1 ? 's' : ''}\n`);

  type ReplayRow = {
    name:         string;
    status:       'PASS' | 'FAIL' | 'INFO' | 'ERR';
    actual_tag:   string | null;
    expected_tag: string | null;
    confidence:   number | null;
    fix_hint:     string | null;
    err_msg?:     string;
  };

  const rows: ReplayRow[] = [];
  let passed = 0, failed = 0, unscored = 0;

  for (const file of files) {
    const filePath = join(dirPath, file);
    let incident: Record<string, unknown>;

    try {
      incident = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      rows.push({ name: file, status: 'ERR', actual_tag: null, expected_tag: null, confidence: null, fix_hint: null, err_msg: 'invalid JSON' });
      continue;
    }

    const name        = typeof incident.name === 'string' ? incident.name : basename(file, '.json');
    const expectedTag = typeof incident.expected_tag === 'string' ? incident.expected_tag : null;
    const firedAt     = typeof incident.firedAt === 'number' ? incident.firedAt : Date.now();

    // Build log array — accept structured ConsoleEvents or plain log_lines strings.
    let logs = Array.isArray(incident.logs) ? incident.logs : [];
    if (Array.isArray(incident.log_lines)) {
      const lineEvents = (incident.log_lines as string[]).map((line, i) => ({
        level:     /error|fatal|critical/i.test(line) ? 'error' : /warn/i.test(line) ? 'warn' : 'log',
        args:      [line],
        timestamp: firedAt - ((incident.log_lines as string[]).length - i) * 1000,
        url:       'replay',
      }));
      logs = [...logs, ...lineEvents];
    }

    const network     = Array.isArray(incident.network)      ? incident.network      : [];
    const infraEvents = Array.isArray(incident.infra_events) ? incident.infra_events : [];

    try {
      const causal = await buildCausalChain(logs, network, [], firedAt, [], [], [], [], infraEvents);
      const top    = causal.hypotheses[0] ?? null;
      const actual = top?.tag ?? null;
      const conf   = top?.confidenceScore ?? null;
      const hint   = top?.fixHint ?? null;

      if (!expectedTag) {
        unscored++;
        rows.push({ name, status: 'INFO', actual_tag: actual, expected_tag: null, confidence: conf, fix_hint: hint });
      } else if (actual === expectedTag) {
        passed++;
        rows.push({ name, status: 'PASS', actual_tag: actual, expected_tag: expectedTag, confidence: conf, fix_hint: hint });
      } else {
        failed++;
        rows.push({ name, status: 'FAIL', actual_tag: actual, expected_tag: expectedTag, confidence: conf, fix_hint: hint });
      }
    } catch (e) {
      rows.push({ name, status: 'ERR', actual_tag: null, expected_tag: expectedTag, confidence: null, fix_hint: null, err_msg: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Print results ─────────────────────────────────────────────────────────────
  const nameW = Math.min(Math.max(...rows.map((r) => r.name.length), 20), 40);

  for (const r of rows) {
    const icon  = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : r.status === 'ERR' ? '!' : '○';
    const label = r.name.slice(0, nameW).padEnd(nameW);
    const pct   = r.confidence !== null ? `  ${Math.round(r.confidence * 100)}%` : '';
    const pad   = ' '.repeat(nameW + 10);

    if (r.status === 'PASS') {
      console.log(`  ${icon} PASS  ${label}  ${r.actual_tag}${pct}`);
    } else if (r.status === 'FAIL') {
      console.log(`  ${icon} FAIL  ${label}  expected: ${r.expected_tag}`);
      console.log(`  ${pad}  got:      ${r.actual_tag ?? '(no diagnosis)'}${pct}`);
      if (r.fix_hint) console.log(`  ${pad}  hint:     ${r.fix_hint.slice(0, 80)}`);
    } else if (r.status === 'INFO') {
      console.log(`  ${icon} INFO  ${label}  ${r.actual_tag ?? '(no diagnosis)'}${pct}`);
    } else {
      console.log(`  ${icon} ERR   ${label}  ${r.err_msg}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  const scored       = passed + failed;
  const accuracyPct  = scored > 0 ? Math.round((passed / scored) * 100) : null;
  const hr           = '─'.repeat(60);

  console.log(`\n${hr}`);

  if (scored > 0) {
    const marker = accuracyPct !== null && accuracyPct >= 90 ? '✓' : accuracyPct !== null && accuracyPct >= 70 ? '~' : '✗';
    const unscoredNote = unscored > 0 ? `  |  ${unscored} unscored` : '';
    console.log(`${marker} Accuracy: ${passed}/${scored} scored (${accuracyPct}%)${unscoredNote}`);
  } else {
    console.log(`○ ${unscored} incident${unscored !== 1 ? 's' : ''} — add "expected_tag" fields to score accuracy`);
  }

  if (accuracyPct !== null && accuracyPct < 90 && failed > 0) {
    console.log('\n  To improve: share failing incidents via mergen-server feedback <id>');
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

// ── Backfill command ───────────────────────────────────────────────────────────
// mergen backfill github --repo <owner/repo> [--since <Nd>] [--token <pat>]
//
// Imports historical merged PRs from GitHub into the local commit context archive.
// Solves the cold-start problem: without backfill, explain_why has nothing to
// retrieve until weeks of organic webhook data accumulates. With backfill, a new
// user has a rich archive in under a minute.

async function backfillGitHubCommand(args: string[]): Promise<void> {
  const path  = await import('path');
  const os    = await import('os');
  const fs    = await import('fs');

  // ── Parse flags ─────────────────────────────────────────────────────────────
  let repo    = '';
  let token   = process.env.GITHUB_TOKEN ?? '';
  let sinceMs = Date.now() - 180 * 24 * 60 * 60 * 1000; // default: 180 days

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--repo'  || args[i] === '-r') && args[i + 1]) { repo  = args[++i]; continue; }
    if ((args[i] === '--token' || args[i] === '-t') && args[i + 1]) { token = args[++i]; continue; }
    if (args[i] === '--since'  && args[i + 1]) {
      const raw = args[++i];
      const daysMatch = raw.match(/^(\d+)d$/i);
      if (daysMatch) {
        sinceMs = Date.now() - parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
      } else {
        const parsed = Date.parse(raw);
        if (!isNaN(parsed)) sinceMs = parsed;
        else { error(`Invalid --since value: "${raw}". Use e.g. 180d or 2024-01-01`); process.exit(1); }
      }
      continue;
    }
    if (args[i].startsWith('--repo='))  { repo  = args[i].slice(7);  continue; }
    if (args[i].startsWith('--token=')) { token = args[i].slice(8);  continue; }
    if (args[i].startsWith('--since=')) {
      const raw = args[i].slice(8);
      const daysMatch = raw.match(/^(\d+)d$/i);
      if (daysMatch) sinceMs = Date.now() - parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
      else { const parsed = Date.parse(raw); if (!isNaN(parsed)) sinceMs = parsed; }
      continue;
    }
  }

  console.log('\nMergen — GitHub Historical Backfill\n');
  hr();

  // ── Collect missing inputs ───────────────────────────────────────────────────
  if (!repo) {
    repo = await ask('GitHub repo (owner/repo): ');
    repo = repo.trim();
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    error(`Invalid repo format: "${repo}". Expected owner/repo.`);
    process.exit(1);
  }

  if (!token) {
    const configPath = path.join(os.homedir(), '.mergen', 'config.json');
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const gh  = (cfg.github ?? {}) as Record<string, unknown>;
      if (typeof gh.token === 'string') token = gh.token;
    } catch {}
  }
  if (!token) {
    console.log('\nA GitHub Personal Access Token with repo read scope is required.');
    token = await ask('GitHub Personal Access Token: ');
    token = token.trim();
  }
  if (!token) {
    error('Token is required. Set GITHUB_TOKEN env var or pass --token.');
    process.exit(1);
  }

  const sinceDate = new Date(sinceMs).toISOString().slice(0, 10);
  log(`Importing merged PRs for ${repo} since ${sinceDate}...`);
  console.log('');

  // ── Load the commit context store directly (no server required) ──────────────
  // We import the store module directly so the CLI can write to it without
  // starting the Express server. The store initialises its own SQLite instance.
  let upsertFn: ((ctx: import('./sensor/commit-context-store.js').CommitContext) => void) | null = null;
  try {
    const { commitContextStore } = await import('./sensor/commit-context-store.js');
    await commitContextStore.init();
    upsertFn = (ctx) => commitContextStore.upsert(ctx);
  } catch (e) {
    error(`Could not initialise commit context store: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const { extractLinkedIssues } = await import('./sensor/commit-context-store.js');
  const { detectAiCommit }      = await import('./intelligence/ai-commit.js');

  // ── Paginate through closed PRs ──────────────────────────────────────────────
  const headers = {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let page        = 1;
  let imported    = 0;
  let skipped     = 0;   // PRs before the --since cutoff (stop condition)
  let done        = false;
  const PAGE_SIZE = 100;

  process.stdout.write('Fetching: ');

  while (!done) {
    const url = `https://api.github.com/repos/${repo}/pulls`
      + `?state=closed&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`;

    let prs: unknown[];
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        console.log('');
        if (res.status === 401) { error('GitHub authentication failed — check your token.'); }
        else if (res.status === 403) {
          // Check for rate limit
          const remaining = res.headers.get('x-ratelimit-remaining');
          const reset     = res.headers.get('x-ratelimit-reset');
          if (remaining === '0' && reset) {
            const waitSec = Math.ceil(parseInt(reset) - Date.now() / 1000);
            error(`GitHub rate limit hit. Try again in ${waitSec}s, or use a different token.`);
          } else {
            error('GitHub permission denied — token needs "repo" read scope.');
          }
        } else if (res.status === 404) {
          error(`Repository "${repo}" not found. Check the name and token permissions.`);
        } else {
          error(`GitHub API error ${res.status}: ${await res.text().then(t => t.slice(0, 120))}`);
        }
        process.exit(1);
      }
      prs = await res.json() as unknown[];
    } catch (e) {
      console.log('');
      error(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }

    if (!Array.isArray(prs) || prs.length === 0) break;

    for (const pr of prs as Record<string, unknown>[]) {
      const mergedAt = pr.merged_at ? Date.parse(String(pr.merged_at)) : null;

      // Skip unmerged PRs (closed but not merged)
      if (!mergedAt) { skipped++; continue; }

      // Stop once we're past the --since window
      if (mergedAt < sinceMs) { done = true; break; }

      const sha = String(
        (pr.merge_commit_sha as string | null) ??
        ((pr.head as Record<string, unknown>)?.sha ?? ''),
      );
      if (!sha) { skipped++; continue; }

      const prNumber = typeof pr.number === 'number' ? pr.number : null;
      const prTitle  = typeof pr.title  === 'string' ? pr.title  : null;
      const prBody   = typeof pr.body   === 'string' ? pr.body   : null;
      const author   = (pr.user as Record<string, unknown> | null)?.login;
      const branch   = (pr.head as Record<string, unknown>)?.ref;
      const headSha  = String((pr.head as Record<string, unknown>)?.sha ?? '');

      const aiResult    = detectAiCommit(prTitle ?? '', typeof author === 'string' ? author : undefined);
      const linkedIssues = extractLinkedIssues(prBody ?? '');

      // Capture reviewers from requested_reviewers (approved reviews require extra API calls;
      // skip for backfill to stay within rate limits — real-time webhook captures them).
      const reviewers = (pr.requested_reviewers as Record<string, unknown>[] | null) ?? [];
      const approvers = reviewers.map((r) => String(r.login ?? '')).filter(Boolean);

      upsertFn!({
        sha,
        repo,
        branch: typeof branch === 'string' ? branch : null,
        prNumber,
        prTitle,
        prBody,
        author: typeof author === 'string' ? author : null,
        approvers,
        linkedIssues,
        aiGenerated: aiResult.detected,
        aiTool: aiResult.tool ?? null,
        filesChanged: [], // skipped for backfill — requires 1 extra API call per PR
        capturedAt: Date.now(),
        mergedAt,
      });

      imported++;
      if (imported % 10 === 0) process.stdout.write('.');
    }

    // GitHub returns fewer than PAGE_SIZE results on the last page
    if ((prs as unknown[]).length < PAGE_SIZE) break;
    page++;
  }

  console.log('');
  hr();
  success(`Imported ${imported} PRs from ${repo}`);
  if (skipped > 0) log(`${skipped} PRs skipped (unmerged or outside date window)`, 'ℹ');
  console.log('');
  console.log('The intent archive is now populated. Try it:');
  console.log(`  Ask your AI IDE: "explain why <service> works the way it does"`);
  console.log(`  Or run:          mergen-server timeline`);
  console.log('');
  log(`To keep the archive current, connect the live webhook: mergen-server connect github --repo ${repo}`, 'ℹ');
}

async function prShadowCommand(): Promise<void> {
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

  interface PRShadowStats {
    readyForPRComments: boolean;
    prCommentsEnabled: boolean;
    totalAnalyzed: number;
    wouldHaveShown: number;
    wouldHaveBeenUsefulRate: number | null;
    avgRelevanceScore: number | null;
    topTriggers: Array<{ trigger: string; count: number }>;
    readyConditions: {
      wouldHaveBeenUsefulRate: number | null;
      wouldHaveBeenUsefulRateThreshold: number;
      wouldHaveBeenUsefulRateOk: boolean;
      helpfulRate7d: number | null;
      helpfulRateThreshold: number;
      helpfulRateOk: boolean;
    };
    nextSteps: string[];
  }

  let data: PRShadowStats;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/pr-shadow/stats`, { signal: AbortSignal.timeout(3000) });
    data = await r.json() as PRShadowStats;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  hr();
  console.log('⬡ Mergen PR Shadow Mode\n');

  const readyIcon = data.readyForPRComments ? '✓' : '○';
  const enabledLabel = data.prCommentsEnabled ? ' (ENABLED)' : ' (shadow only)';
  console.log(`${readyIcon} PR Comments: ${data.readyForPRComments ? 'ready to enable' : 'not ready'}${enabledLabel}\n`);

  console.log(`  PRs analyzed:       ${data.totalAnalyzed}`);
  console.log(`  Would have shown:   ${data.wouldHaveShown}`);
  console.log(`  Useful rate:        ${data.wouldHaveBeenUsefulRate ?? 'N/A'}%  (need ≥${data.readyConditions.wouldHaveBeenUsefulRateThreshold}%)`);
  console.log(`  Avg relevance:      ${data.avgRelevanceScore ?? 'N/A'}`);
  console.log(`  Helpful rate (7d):  ${data.readyConditions.helpfulRate7d ?? 'N/A'}%  (need ≥${data.readyConditions.helpfulRateThreshold}%)`);

  if (data.topTriggers.length > 0) {
    console.log(`\n  Top triggers:`);
    for (const t of data.topTriggers.slice(0, 3)) {
      console.log(`    ${t.trigger}: ${t.count}`);
    }
  }

  if (data.nextSteps.length > 0) {
    console.log('\n  Next steps:');
    for (const step of data.nextSteps) {
      console.log(`    ${step}`);
    }
  }

  hr();
}

async function feedbackCommand(args: string[]): Promise<void> {
  // Usage: mergen-server feedback <id> --yes|--no
  const id = args[0];
  const flag = args[1];

  if (!id || (flag !== '--yes' && flag !== '--no')) {
    error('Usage: mergen-server feedback <id> --yes|--no');
    error('Example: mergen-server feedback ew-1a2b3c --yes');
    process.exit(1);
  }

  const helpful = flag === '--yes';

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

  try {
    const r = await fetch(`http://127.0.0.1:${port}/explain-why/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, helpful }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      error(`Server returned ${r.status}: ${body}`);
      process.exit(1);
    }
    success(helpful ? 'Marked as helpful. Thanks!' : 'Marked as not helpful. We\'ll use this to improve results.');
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function backfillCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'github') {
    await backfillGitHubCommand(args.slice(1));
    return;
  }
  console.log('Usage: mergen-server backfill <source>');
  console.log('');
  console.log('Available sources:');
  console.log('  github   Import historical merged PRs into the intent archive');
  console.log('');
  console.log('Example:');
  console.log('  mergen-server backfill github --repo acme/api --since 180d');
}

async function connectCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'github') {
    await connectGitHubCommand(args.slice(1));
    return;
  }
  console.log('Usage: mergen-server connect <integration>');
  console.log('');
  console.log('Available integrations:');
  console.log('  github   Auto-register GitHub PR/push webhook → populates intent archive');
  console.log('');
  console.log('Example:');
  console.log('  mergen-server connect github --repo acme/api');
}

// ── Quickstart command ─────────────────────────────────────────────────────────
// Guided wizard: from zero to first real insight in under 2 minutes.
// Asks for the app command, starts the server, watches the process, and surfaces
// the first analysis inline — no AI IDE or prior knowledge required.

async function quickstartCommand(): Promise<void> {
  console.log('\n⬡ Mergen — Quick Start\n');
  hr();
  log('From zero to your first real insight. Under 2 minutes.');
  console.log('');

  // 1. Ask for the app command
  const cmd = (await ask('What command starts your app? (e.g. npm start, python app.py): ')).trim();
  if (!cmd) { error('No command provided.'); process.exit(1); }

  // 2. Start server if not already running
  const mergenHost = process.env.MERGEN_HOST ?? '127.0.0.1';
  let serverPort = 3000;
  let serverFound = false;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://${mergenHost}:${p}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { serverPort = p; serverFound = true; break; }
    } catch {}
  }

  if (!serverFound) {
    const serverPath = resolve(__dirname, 'index.js');
    if (existsSync(serverPath)) {
      process.stdout.write('\nStarting Mergen server...');
      const { spawn: spawnSrv } = await import('child_process');
      const srv = spawnSrv('node', [serverPath], {
        stdio: 'ignore', detached: true,
        env: { ...process.env as Record<string, string>, NODE_ENV: 'production' },
      });
      srv.unref();
      for (let attempt = 0; attempt < 16 && !serverFound; attempt++) {
        await sleep(500);
        for (let p = 3000; p <= 3010; p++) {
          try {
            const r = await fetch(`http://${mergenHost}:${p}/health`, { signal: AbortSignal.timeout(300) });
            if (r.ok) { serverPort = p; serverFound = true; break; }
          } catch {}
        }
      }
      console.log(serverFound ? ` ✓  :${serverPort}` : ' ✗');
    }
  } else {
    success(`Server already running on :${serverPort}`);
  }

  // 3. Offer to configure the detected IDE (non-blocking)
  const ide = await detectIDE().catch(() => null);
  if (ide) {
    console.log('');
    const doIde = await ask(`Add Mergen to ${ide}? Your AI IDE will see live errors without copy-paste. (y/n): `);
    if (doIde.toLowerCase() === 'y') {
      await configureIDE(ide).catch(() => {});
      success(`${ide} configured — restart your IDE for the MCP tools to appear`);
    }
  }

  // 4. Start watching with inline analysis — reuse watchCommand which handles everything
  hr();
  console.log(`\nStarting: ${cmd}`);
  const div = '─'.repeat(58);
  console.log(div);
  log('Mergen is watching. Trigger an error in your app.');
  log('When it appears, Mergen will analyze it inline — no IDE needed.');
  log('Press Ctrl+C when done.\n');

  // Pass as watch args: watchCommand expects args[0] = 'watch'
  const parts = cmd.split(/\s+/);
  await watchCommand(['watch', ...parts]);
}

// ── Policy GitOps commands ─────────────────────────────────────────────────────

async function policyPushCommand(): Promise<void> {
  // Save current server policy → .mergen/policy.json in cwd (for git tracking)
  const port = await findPort();
  if (!port) { error('Server not running. Start it first: mergen-server start'); process.exit(1); }

  const resp = await fetch(`http://127.0.0.1:${port}/policies/export`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) { error(`Policy fetch failed: ${resp.status}`); process.exit(1); }
  const policy = await resp.json() as object;

  const { mkdirSync: mkd, writeFileSync: wf } = await import('fs');
  const dir = resolve(process.cwd(), '.mergen');
  mkd(dir, { recursive: true });
  const file = resolve(dir, 'policy.json');
  wf(file, JSON.stringify(policy, null, 2) + '\n', 'utf8');
  success(`Policy saved to .mergen/policy.json`);
  log('Commit this file to track policy changes in git:');
  log('  git add .mergen/policy.json && git commit -m "chore: update mergen policy"');
}

async function policyPullCommand(args: string[]): Promise<void> {
  // Load .mergen/policy.json from cwd → push to running server
  const mode = args.includes('--merge') ? 'merge' : 'replace';
  const { readFileSync: rf, existsSync: ex } = await import('fs');
  const file = resolve(process.cwd(), '.mergen', 'policy.json');
  if (!ex(file)) { error('No .mergen/policy.json found. Run: mergen-server policy-push first.'); process.exit(1); }

  let policy: unknown;
  try { policy = JSON.parse(rf(file, 'utf8')); } catch { error('Failed to parse .mergen/policy.json'); process.exit(1); }

  const port = await findPort();
  if (!port) { error('Server not running. Start it first: mergen-server start'); process.exit(1); }

  const resp = await fetch(`http://127.0.0.1:${port}/policies/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy, mode }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await resp.json() as { ok: boolean; ruleCount?: number; mode?: string; error?: unknown };
  if (!resp.ok || !data.ok) { error(`Policy import failed: ${JSON.stringify(data.error)}`); process.exit(1); }
  success(`Policy applied (${mode}): ${data.ruleCount} rules active`);
}

async function policyDiffCommand(): Promise<void> {
  const { readFileSync: rf, existsSync: ex } = await import('fs');
  const file = resolve(process.cwd(), '.mergen', 'policy.json');

  const port = await findPort();
  if (!port) { error('Server not running.'); process.exit(1); }

  const resp = await fetch(`http://127.0.0.1:${port}/policies/export`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) { error('Could not fetch live policy.'); process.exit(1); }
  const live = await resp.json() as { rules?: Array<{ id: string; action: string }> };
  const liveIds = new Set((live.rules ?? []).map((r) => r.id));

  if (!ex(file)) {
    log('No .mergen/policy.json — run mergen-server policy-push to create it');
    process.exit(0);
  }
  let disk: { rules?: Array<{ id: string; action: string }> };
  try { disk = JSON.parse(rf(file, 'utf8')); } catch { error('Cannot parse .mergen/policy.json'); process.exit(1); return; }
  const diskIds = new Set((disk.rules ?? []).map((r) => r.id));

  hr();
  console.log('⬡ Mergen — Policy Diff (.mergen/policy.json vs live server)\n');

  const onlyLive  = [...liveIds].filter((id) => !diskIds.has(id));
  const onlyDisk  = [...diskIds].filter((id) => !liveIds.has(id));
  const inBoth    = [...liveIds].filter((id) => diskIds.has(id));

  if (onlyLive.length === 0 && onlyDisk.length === 0) {
    success('Policy files are in sync — no differences');
  } else {
    if (onlyLive.length > 0)  console.log(`  + Live only (not in file): ${onlyLive.join(', ')}`);
    if (onlyDisk.length > 0)  console.log(`  - File only (not in live): ${onlyDisk.join(', ')}`);
    console.log(`  = Matching rules: ${inBoth.length}`);
    log('\nTo sync file → server: mergen-server policy-pull');
    log('To sync server → file: mergen-server policy-push');
  }
  hr();
}

// ── Export risk report command ──────────────────────────────────────────────────

async function exportRiskReportCommand(args: string[]): Promise<void> {
  const fmt = args.includes('--markdown') || args.includes('--md') ? 'md' : 'json';
  let port = 3000;
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(600) });
      if (r.ok) { port = p; break; }
    } catch {}
  }

  const { join } = await import('path');
  const { homedir } = await import('os');
  const { existsSync, readFileSync } = await import('fs');
  let secret = '';
  const secretPath = join(homedir(), '.mergen', 'secret');
  if (existsSync(secretPath)) {
    try { secret = readFileSync(secretPath, 'utf8').trim(); } catch {}
  }
  const headers: Record<string, string> = {};
  if (secret) headers['x-mergen-secret'] = secret;

  let resp: Response;
  try {
    resp = await fetch(`http://127.0.0.1:${port}/risk-report${fmt === 'md' ? '?format=md' : ''}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    error('Mergen server is not running. Start it first: mergen-server start');
    process.exit(1);
    return;
  }

  if (!resp.ok) {
    error(`Risk report request failed: ${resp.status}`);
    process.exit(1);
  }

  if (fmt === 'md') {
    const { writeFileSync: wf } = await import('fs');
    const filename = `mergen-risk-report-${new Date().toISOString().slice(0, 10)}.md`;
    const body = await resp.text();
    wf(filename, body, 'utf8');
    success(`CISO risk report saved: ${filename}`);
    log('Share this with your security team — all data sourced from your local infrastructure.');
  } else {
    const data = await resp.json() as { ok: boolean; report: Record<string, unknown> };
    if (!data.ok) { error('Failed to generate risk report.'); process.exit(1); }
    const { report } = data;
    hr();
    console.log('⬡ Mergen — AI Agent Security Risk Report\n');
    console.log(`  Risk Level  : ${String(report.riskScore ?? '').toUpperCase()}`);
    console.log(`  Assessment  : ${report.riskRationale}`);
    console.log(`  Total blocked (all time) : ${report.totalBlocked}`);
    console.log(`  Blocked — last 7 days   : ${report.last7Days}`);
    console.log(`  Blocked — last 30 days  : ${report.last30Days}`);
    console.log(`  Active block rules       : ${report.activeRules}`);
    console.log(`  Override corpus entries  : ${report.overrideCorpusSize}`);
    console.log('');
    log('For a shareable CISO document: mergen-server export-risk-report --markdown');
    hr();
  }
}

// ── Partner shortlist command ─────────────────────────────────────────────────

async function partnerShortlistCommand(subArgs: string[]): Promise<void> {
  const listPath = join(homedir(), '.mergen', 'partner-shortlist.json');
  const { mkdirSync } = await import('fs');

  type Candidate = { name: string; company: string; role: string; reach: string; notes: string; addedAt: string };

  if (subArgs[0] === '--add') {
    // mergen-server partner-shortlist --add "Name" "Company" "Role" "Reach" "Notes"
    const [, name = '', company = '', role = '', reach = '', ...noteParts] = subArgs;
    const notes = noteParts.join(' ');
    if (!name || !company) { error('Usage: partner-shortlist --add <name> <company> [role] [reach] [notes]'); process.exit(1); }
    mkdirSync(join(homedir(), '.mergen'), { recursive: true });
    let list: Candidate[] = [];
    try { list = JSON.parse(readFileSync(listPath, 'utf8')); } catch {}
    list.push({ name, company, role, reach, notes, addedAt: new Date().toISOString() });
    writeFileSync(listPath, JSON.stringify(list, null, 2) + '\n', 'utf8');
    success(`Added ${name} (${company}) to partner shortlist`);
    return;
  }

  if (subArgs[0] === '--list') {
    let list: Candidate[] = [];
    try { list = JSON.parse(readFileSync(listPath, 'utf8')); } catch {}
    if (list.length === 0) { log('No candidates yet. Add with: mergen-server partner-shortlist --add', 'ℹ'); return; }
    const div = '─'.repeat(60);
    console.log('\nMergen — Design-partner shortlist\n' + div);
    for (const c of list) {
      console.log(`  ${c.name.padEnd(22)} ${c.company.padEnd(20)} ${c.role}`);
      if (c.reach)  console.log(`    Reach: ${c.reach}`);
      if (c.notes)  console.log(`    Notes: ${c.notes}`);
    }
    console.log(div + '\n');
    return;
  }

  // Default: print criteria + template
  const W = 60;
  const div = '─'.repeat(W);
  console.log('\nMergen — Design-partner filter criteria');
  console.log(div);
  console.log('  The right first partner gives you a credible case study,');
  console.log('  not a friendly pilot that never stresses the gate.\n');
  console.log('  Required (all must be true):');
  console.log('    [ ] Public postmortem published in last 12 months');
  console.log('        (they already do blameless post-mortems → safety mindset)');
  console.log('    [ ] 2–5 person SRE / platform team');
  console.log('        (small enough for Mergen to matter, big enough to have incidents)');
  console.log('    [ ] On PagerDuty (webhook integration = Day 1 incident coverage)');
  console.log('    [ ] Someone with public reach (Twitter/X, blog, conference talk)');
  console.log('        (their Day-30 quote is worth 10× paid ads)\n');
  console.log('  Nice to have:');
  console.log('    [ ] Already using an AI coding agent (Claude Code / Cursor / Copilot)');
  console.log('    [ ] Compliance pressure (SOC 2, HIPAA, fintech) — AEG is mandatory for them');
  console.log('    [ ] Recent infrastructure incident (motivation is high)\n');
  console.log('  Disqualify if:');
  console.log('    [ ] > 150 developers (sale requires VP Eng buy-in, wrong stage)');
  console.log('    [ ] No PagerDuty / no incident workflow (Mergen has nothing to triage)');
  console.log('    [ ] Solo developer (Layer 2+ features don\'t apply yet)\n');
  console.log('  Day-30 pre-agreement (send before trial starts):');
  console.log('    "At Day 30 we\'ll run: mergen-server impact-report --slide"');
  console.log('    "We pre-agree these 5 numbers are the success criteria."');
  console.log('    "No new metrics after the trial starts."\n');
  console.log('  Commands:');
  console.log('    mergen-server partner-shortlist --add <name> <company> [role] [reach] [notes]');
  console.log('    mergen-server partner-shortlist --list');
  console.log(div + '\n');
}

// ── Exec command (second interception surface — protocol-agnostic CLI proxy) ──

async function execCommand(args: string[]): Promise<void> {
  // Usage: mergen-server exec [--actor <name>] [--service <name>] -- <command> [args...]
  let actor = 'claude';
  let service = 'cli';
  let dashDash = args.indexOf('--');
  const flagArgs = dashDash >= 0 ? args.slice(0, dashDash) : args;

  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === '--actor' && flagArgs[i + 1]) actor = flagArgs[++i];
    else if (flagArgs[i] === '--service' && flagArgs[i + 1]) service = flagArgs[++i];
  }

  const cmdParts = dashDash >= 0 ? args.slice(dashDash + 1) : args;
  if (cmdParts.length === 0) {
    error('Usage: mergen-server exec [--actor <name>] [--service <name>] -- <command> [args...]');
    process.exit(1);
  }

  const fullCommand = cmdParts.join(' ');

  // Evaluate against enterprise policy.
  // Always check the built-in default rules first (immutable layer), then the
  // user's on-disk policy. Verdict is the stricter of the two.
  const {
    evaluateEnterprisePolicy,
    loadEnterprisePolicy,
    DEFAULT_ENTERPRISE_POLICY: DEFAULT_POLICY,
    _resetPolicyCacheForTesting: _resetPolicy,
  } = await import('./intelligence/enterprise-policy-engine.js');

  const evalInput = { files: [], commands: [fullCommand], actor, service };

  const savedPolicy = loadEnterprisePolicy();
  _resetPolicy(DEFAULT_POLICY);
  const defaultResult = evaluateEnterprisePolicy(evalInput);
  _resetPolicy(savedPolicy);
  const userResult = evaluateEnterprisePolicy(evalInput);

  // Merge: block > warn > pass
  const verdictRank = (v: string) => v === 'block' ? 2 : v === 'warn' ? 1 : 0;
  const result = verdictRank(defaultResult.verdict) >= verdictRank(userResult.verdict)
    ? defaultResult
    : userResult;

  if (result.verdict === 'block') {
    hr();
    console.error('⬡ Mergen — BLOCKED\n');
    console.error(`  Command : ${fullCommand}`);
    console.error(`  Reason  : ${result.reasons[0] ?? 'Destructive pattern matched'}`);
    console.error('');
    console.error('  What to do instead:');
    console.error('    1. Check your runbooks: mergen-server status');
    console.error('    2. Request human approval: mergen-server approve --request');
    console.error('    3. Override (audit logged): set MERGEN_TRUSTED_HUMANS=<your-name>');
    hr();

    // Record to blunder log via server if available
    const { randomUUID } = await import('crypto');
    const blunder = {
      id: randomUUID(),
      recordedAt: Date.now(),
      type: 'blunder',
      blunderType: 'pipeline_block',
      command: fullCommand,
      blockReason: result.reasons[0] ?? 'Destructive pattern matched',
      service,
      actor,
    };

    let success = false;
    try {
      const port = await findPort();
      if (port) {
        const { join } = await import('path');
        const { homedir } = await import('os');
        const { existsSync, readFileSync } = await import('fs');
        let secret = '';
        const secretPath = join(homedir(), '.mergen', 'secret');
        if (existsSync(secretPath)) {
          try { secret = readFileSync(secretPath, 'utf8').trim(); } catch {}
        }
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (secret) headers['x-mergen-secret'] = secret;

        const resp = await fetch(`http://127.0.0.1:${port}/ingest`, {
          method: 'POST',
          headers,
          body: JSON.stringify(blunder),
          signal: AbortSignal.timeout(1000),
        });
        if (resp.ok) success = true;
      }
    } catch {}

    if (!success) {
      // Save locally as offline blunder
      try {
        const { appendFileSync, mkdirSync } = await import('fs');
        const { join, dirname } = await import('path');
        const { homedir } = await import('os');
        const file = join(homedir(), '.mergen', 'offline-blunders.jsonl');
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, JSON.stringify(blunder) + '\n', 'utf8');
      } catch {}
    }

    process.exit(1);
  }

  if (result.verdict === 'warn') {
    console.warn(`⬡ Mergen — WARNING: ${result.reasons[0] ?? 'Action requires review'}`);
    console.warn('  Proceeding — but this action has been flagged for audit.');
  }

  // Execute the command
  const { spawn: sp } = await import('child_process');
  const child = sp(cmdParts[0], cmdParts.slice(1), { stdio: 'inherit', shell: false });
  child.on('close', (code) => process.exit(code ?? 0));
  child.on('error', (err) => { error(`exec failed: ${err.message}`); process.exit(1); });
}

async function maybeFlushOfflineBlunders(port: number): Promise<void> {
  const { existsSync, readFileSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const file = join(homedir(), '.mergen', 'offline-blunders.jsonl');
  if (!existsSync(file)) return;

  let secret = '';
  const secretPath = join(homedir(), '.mergen', 'secret');
  if (existsSync(secretPath)) {
    try { secret = readFileSync(secretPath, 'utf8').trim(); } catch {}
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['x-mergen-secret'] = secret;

  let lines: string[];
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return;
  }

  const remaining: string[] = [];
  for (const line of lines) {
    try {
      const blunder = JSON.parse(line);
      const resp = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: 'POST',
        headers,
        body: JSON.stringify(blunder),
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) {
        remaining.push(line);
      }
    } catch {
      remaining.push(line);
    }
  }

  try {
    if (remaining.length > 0) {
      writeFileSync(file, remaining.join('\n') + '\n', 'utf8');
    } else {
      const { unlinkSync } = await import('fs');
      unlinkSync(file);
    }
  } catch {}
}

async function findPort(): Promise<number | null> {
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(300) });
      if (r.ok) {
        maybeFlushOfflineBlunders(p).catch(() => {});
        return p;
      }
    } catch {}
  }
  return null;
}

// ── Test-safety command (adversarial bypass test suite) ──────────────────────

async function testSafetyCommand(): Promise<void> {
  const port = await findPort();
  let results: Array<{ name: string; passed: boolean; expected: string; got: string; description?: string }>;

  if (port) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/safety-test?verbose=1`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json() as {
        allPassed: boolean;
        passed: number;
        failed: number;
        total: number;
        cases?: typeof results;
      };
      hr();
      console.log('⬡ Mergen — Safety Test Suite\n');
      console.log(`  ${data.passed}/${data.total} tests passed`);
      if (data.cases) {
        for (const c of data.cases) {
          const icon = c.passed ? '✓' : '✗';
          console.log(`  ${icon} ${c.name}`);
          if (!c.passed) console.log(`      expected=${c.expected} got=${c.got}`);
        }
      }
      hr();
      process.exit(data.allPassed ? 0 : 1);
      return;
    } catch { /* fall through to local evaluation */ }
  }

  // Server not running — evaluate locally
  log('Server not running — running safety tests locally');
  const { evaluateEnterprisePolicy, loadEnterprisePolicy, DEFAULT_ENTERPRISE_POLICY, _resetPolicyCacheForTesting } = await import('./intelligence/enterprise-policy-engine.js');
  const saved = loadEnterprisePolicy();
  _resetPolicyCacheForTesting(DEFAULT_ENTERPRISE_POLICY);

  const TEST_CASES = [
    { name: 'block_rm_rf', cmd: 'rm -rf /var/data', expected: 'block' },
    { name: 'block_terraform_destroy', cmd: 'terraform destroy prod', expected: 'block' },
    { name: 'block_drop_database', cmd: 'drop database production', expected: 'block' },
    { name: 'block_drop_table', cmd: 'drop table users', expected: 'block' },
    { name: 'block_kubectl_delete', cmd: 'kubectl delete namespace production', expected: 'block' },
    { name: 'hold_alter_table', cmd: 'alter table users add column x boolean', expected: 'warn' },
    { name: 'pass_safe_deploy', cmd: 'kubectl rollout status deployment/api', expected: 'pass' },
    { name: 'pass_git_commit', cmd: 'git commit -m "fix"', expected: 'pass' },
  ];

  let passed = 0;
  hr();
  console.log('⬡ Mergen — Safety Test Suite\n');
  for (const tc of TEST_CASES) {
    const r = evaluateEnterprisePolicy({ files: [], commands: [tc.cmd], actor: 'claude', service: 'test' });
    const ok = r.verdict === tc.expected;
    if (ok) passed++;
    const icon = ok ? '✓' : '✗';
    console.log(`  ${icon} ${tc.name}`);
    if (!ok) console.log(`      expected=${tc.expected} got=${r.verdict}`);
  }
  console.log(`\n  ${passed}/${TEST_CASES.length} tests passed`);
  hr();
  _resetPolicyCacheForTesting(saved);
  process.exit(passed === TEST_CASES.length ? 0 : 1);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      await initCommand();
      break;

    case 'resolved':
      await resolvedCommand(args.slice(1));
      break;

    case 'demo':
      await demoCommand();
      break;

    case 'pr':
      await prCommand(args.slice(1));
      break;

    case 'connect':
      await connectCommand(args.slice(1));
      break;

    case 'backfill':
      await backfillCommand(args.slice(1));
      break;

    case 'feedback':
      await feedbackCommand(args.slice(1));
      break;

    case 'pr-shadow':
      await prShadowCommand();
      break;

    case 'approve':
      await approveCommand(args.slice(1));
      break;

    case 'shadow-report':
      await shadowReportCommand();
      break;

    case 'allow':
      await allowCommand(args.slice(1));
      break;

    case 'impact-report':
      await impactReportCommand(args.slice(1));
      break;

    case 'setup':
      await setupCommand();
      break;

    case 'login':
      await loginCommand();
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

    case 'explain':
      await explainCommand(args.slice(1));
      break;

    case 'quickstart':
      await quickstartCommand();
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

    case 'export-risk-report':
      await exportRiskReportCommand(args.slice(1));
      break;

    case 'partner-shortlist':
      await partnerShortlistCommand(args.slice(1));
      break;

    case 'exec':
      await execCommand(args.slice(1));
      break;

    case 'test-safety':
      await testSafetyCommand();
      break;

    case 'policy-push':
      await policyPushCommand();
      break;

    case 'policy-pull':
      await policyPullCommand(args.slice(1));
      break;

    case 'policy-diff':
      await policyDiffCommand();
      break;

    case 'verify-log':
      await verifyLogCommand();
      break;

    case 'guard':
      await guardCommand(args);
      break;

    case 'replay':
      await replayCommand(args.slice(1));
      break;

    case 'version':
    case '--version':
    case '-v':
      console.log(`mergen-server v${VERSION}`);
      break;

    case undefined:
      // No args — start demo mode immediately. 50 sample incidents, zero config.
      await demoCommand();
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(`
Mergen — production incident intelligence

Usage:
  mergen-server                    Zero-config demo — loads 50 sample incidents instantly
  mergen-server start              Start server (production mode)
  mergen-server login              Authenticate Mergen CLI (automatic browser & manual fallback)
  mergen-server login --key <key>  Directly authenticate using a license key
  mergen-server approve <id>       Temporarily bypass a blocked command block (10 min)
  mergen-server setup              Interactive setup wizard (connect PagerDuty, OTLP, IDE)
  mergen-server setup --yes        Non-interactive setup (skip all prompts, use defaults)
  mergen-server setup --ide cursor Configure a specific IDE (cursor|vscode|claude-code|windsurf)
  mergen-server setup --skip-github     Skip GitHub connect step
  mergen-server demo               Same as no args — demo with sample incidents
  mergen-server status             Live snapshot: server health, buffer, errors, MCP activity
  mergen-server doctor             Full health-check: env vars, IDE config, integrations
  mergen-server connect github     Auto-register GitHub webhook → populates intent archive
  mergen-server backfill github    Import historical PRs → enables explain_why on day 1
  mergen-server init               Connect Datadog (guided setup)
  mergen-server pr                 Generate a PR description from your debug session
  mergen-server pr --copy          Same, but copies to clipboard
  mergen-server quickstart         Guided wizard — from zero to first real insight in 2 min
  mergen-server watch <cmd>        Stream any process into Mergen (auto-starts server if needed)
  mergen-server explain [file]     Analyze a log file or piped input — no server required
  mergen-server invite             Generate a team invite URL
  mergen-server join <url>         Join a team Mergen instance
  mergen-server postmortem [h]     Generate a postmortem document (default: last 1 hour)
  mergen-server timeline [seconds] Unified causal timeline
  mergen-server export [label]     Export session as JSON + HTML report
  mergen-server export-risk-report Print CISO security risk report
  mergen-server export-risk-report --markdown  Save as shareable Markdown file
  mergen-server exec -- <cmd>      Run a command through the Mergen policy gate
  mergen-server impact-report      Print the 5 pre-agreed Day-30 metrics
  mergen-server impact-report --slide     Screenshot-ready 5-number card
  mergen-server impact-report --baseline  Save Day-1 numbers (compare at Day 30)
  mergen-server impact-report --compare   Show delta vs. saved baseline
  mergen-server impact-report --html      Write full HTML report to disk
  mergen-server partner-shortlist  Print design-partner filter criteria and commands
  mergen-server partner-shortlist --add <name> <company> [role] [reach] [notes]
  mergen-server partner-shortlist --list  Show saved candidates
  mergen-server test-safety        Run adversarial bypass test suite against the gate
  mergen-server policy-push        Save live server policy → .mergen/policy.json (for git)
  mergen-server policy-pull        Apply .mergen/policy.json → live server
  mergen-server policy-pull --merge  Merge (add new rules only, keep existing)
  mergen-server policy-diff        Show diff between .mergen/policy.json and live server
  mergen-server replay <dir>       Score historical incidents against the detector pipeline
  mergen-server verify-log         Verify Agent Blunder Log hash chain (tamper-evident audit)
  mergen-server guard              Pre-commit runtime check (includes incident history for staged services)
  mergen-server guard --install    Install as git pre-commit hook
  mergen-server test               Validate installation
  mergen-server ci                 CI smoke test (exit 0 = healthy)
  mergen-server --version          Show version

Examples:
  npx mergen-server                # instant demo — no config needed
  mergen-server setup --yes        # non-interactive setup in CI
  mergen-server setup --ide cursor --skip-github
  mergen-server start &            # production server in background
  mergen-server connect github --repo acme/api
  mergen-server watch npm start

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
