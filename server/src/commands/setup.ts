/**
 * commands/setup.ts — extracted from cli.ts (C2 refactor).
 */
import { execSync, spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { resolve, dirname, join } from 'path';
import * as os from 'os';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { log, success, error, hr, ask, sleep, VERSION, SERVER_ENTRY, CLI_ENTRY, findPort, maybeFlushOfflineBlunders } from './shared.js';
import { connectCommand, backfillCommand } from './github.js';
import { guardCommand } from './policy.js';
import { watchCommand } from './incident.js';

export async function seedBuiltinRunbooks(): Promise<void> {
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

export async function loginCommand(): Promise<void> {
  const { createServer } = await import('http');
  const { exec } = await import('child_process');
  const { activateKey } = await import('../intelligence/license.js');
  const { getPlan } = await import('../intelligence/plans.js');

  const CAP_LABELS: Record<string, string> = {
    hitlApproval:          'HITL approve/deny holds',
    overrideCorpusEnforce: 'override-corpus enforcement',
    ciGate:                'CI/CD blast-radius gate',
    agentIam:              'Agent IAM + ephemeral credentials',
  };
  const planSummary = (planId: unknown): string => {
    const plan = getPlan(typeof planId === 'string' ? planId : undefined);
    const caps = Object.entries(plan.capabilities)
      .filter(([, on]) => on)
      .map(([cap]) => CAP_LABELS[cap] ?? cap);
    const suffix = caps.length > 0 ? ` — unlocks ${caps.join(', ')}` : '';
    return `${plan.name}${suffix}`;
  };

  const args = process.argv.slice(3);
  const keyIndex = args.indexOf('--key');
  if (keyIndex !== -1 && args[keyIndex + 1]) {
    const key = args[keyIndex + 1];
    log(`Activating license key: ${key.substring(0, 12)}...`);
    try {
      const result = await activateKey(key);
      success(`License activated! Plan: ${planSummary(result.planId)}`);
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
        success(`License activated! Plan: ${planSummary(result.planId)}`);
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
        success(`Successfully authenticated! Plan: ${planSummary(result.planId)}`);
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

export async function setupCommand(): Promise<void> {
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

      // Verify the token against Slack's API before writing anything — a copy-paste
      // mistake here otherwise fails silently until the first real incident fires.
      let verifiedToken = slackToken;
      if (verifiedToken) {
        process.stdout.write('  Verifying token with Slack... ');
        try {
          const res = await fetch('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: { Authorization: `Bearer ${verifiedToken}` },
            signal: AbortSignal.timeout(5_000),
          });
          const body = await res.json() as { ok?: boolean; team?: string; error?: string };
          if (body.ok) {
            console.log(`✓ (workspace: ${body.team ?? 'unknown'})`);
          } else {
            console.log(`✗ (${body.error ?? 'invalid token'})`);
            const saveAnyway = await ask('  Token failed verification — save it anyway? (y/n): ');
            if (saveAnyway.toLowerCase() !== 'y') verifiedToken = '';
          }
        } catch (err) {
          console.log(`✗ (${err instanceof Error ? err.message : 'network error'})`);
          const saveAnyway = await ask('  Could not reach Slack to verify — save it anyway? (y/n): ');
          if (saveAnyway.toLowerCase() !== 'y') verifiedToken = '';
        }
      }

      if (verifiedToken) {
        const envPath = path.join(process.cwd(), '.env');
        try {
          const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
          let updated = existing;
          if (!updated.includes('MERGEN_SLACK_BOT_TOKEN')) updated += `\nMERGEN_SLACK_BOT_TOKEN=${verifiedToken}`;
          if (!updated.includes('MERGEN_SLACK_CHANNEL'))   updated += `\nMERGEN_SLACK_CHANNEL=${slackChannel}`;
          writeFileSync(envPath, updated.trimStart() + '\n', 'utf8');
          success(`Slack configured (channel: ${slackChannel}), written to .env`);
        } catch {
          success('Slack configured for this session');
          log(`Set these in your .env to persist:\n  MERGEN_SLACK_BOT_TOKEN=${verifiedToken}\n  MERGEN_SLACK_CHANNEL=${slackChannel}`, 'ℹ');
        }
      } else {
        log('No token saved — skipped.', 'ℹ');
      }
    } else {
      log('Skipped. To add later: set MERGEN_SLACK_BOT_TOKEN and MERGEN_SLACK_CHANNEL in .env', 'ℹ');
    }
  }
  _markStep('Slack setup');

  // 6. PagerDuty webhook — where incidents originate
  hr();
  log('\nPagerDuty webhook (recommended — where incidents originate):');
  console.log('  Connecting PagerDuty lets Mergen catch incident.triggered events, fetch traces,');
  console.log('  and post the diagnosis to Slack. Autopilot (if enabled) runs the fix loop from here.');

  if (!yes) {
    const enablePD = await ask('\nConnect PagerDuty now? (y/n): ');
    if (enablePD.toLowerCase() === 'y') {
      const port = process.env.HTTP_PORT ?? '3000';
      console.log('');
      console.log('  1. PagerDuty → Service → Integrations → Add a webhook (v3)');
      console.log(`  2. Endpoint URL: https://your-host:${port}/webhooks/pagerduty`);
      console.log('  3. Copy the "Webhook signing secret" shown after creation');
      console.log('');
      const pdSecret = (await ask('  Webhook signing secret: ')).trim();
      if (pdSecret) {
        // No round-trip validation is possible here — PagerDuty only calls the
        // webhook when a real incident fires. Do a basic sanity check instead.
        if (pdSecret.length < 16) {
          log('That looks short for a PagerDuty signing secret — double-check you copied the whole value.', '⚠');
        }
        const envPath = path.join(process.cwd(), '.env');
        try {
          const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
          let updated = existing;
          if (!updated.includes('MERGEN_PAGERDUTY_SECRET')) updated += `\nMERGEN_PAGERDUTY_SECRET=${pdSecret}`;
          writeFileSync(envPath, updated.trimStart() + '\n', 'utf8');
          success('PagerDuty configured, written to .env');
        } catch {
          success('PagerDuty configured for this session');
          log(`Set this in your .env to persist:\n  MERGEN_PAGERDUTY_SECRET=${pdSecret}`, 'ℹ');
        }
        log('Trigger a test event from PagerDuty once the server is running to confirm delivery end-to-end.', 'ℹ');
      } else {
        log('No secret entered — skipped.', 'ℹ');
      }
    } else {
      log('Skipped. To add later: set MERGEN_PAGERDUTY_SECRET in .env (webhook → /webhooks/pagerduty)', 'ℹ');
    }
  }
  _markStep('PagerDuty setup');

  // 7. GitHub intent archive
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

  // 8. Git Pre-commit Hook (Recommended for Codex / non-VS Code users)
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

  // 9. Seed built-in runbooks
  await seedBuiltinRunbooks();
  _markStep('Runbook seed');

  // 10. Summary + start server
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

export async function testCommand(): Promise<void> {
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

export async function ciCommand(): Promise<void> {
  const serverPath = SERVER_ENTRY;

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

export async function startCommand(): Promise<void> {
  const rawArgs = process.argv.slice(3);
  const thenIdx = rawArgs.indexOf('--then');
  const thenCmd = thenIdx !== -1 ? rawArgs[thenIdx + 1] : null;

  const serverPath = SERVER_ENTRY;

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

    // ── Onboarding shadow preview ─────────────────────────────────────────────
    // If there are gate events from the last 24h, show a shadow summary so the
    // user can see what Mergen would have blocked before they've enabled anything.
    // This is the "try before you buy" moment for policy enforcement.
    if (ready) {
      try {
        const mergenHost2 = process.env.MERGEN_HOST ?? '127.0.0.1';
        const r = await fetch(`http://${mergenHost2}:${serverPort}/gate/heatmap`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (r.ok) {
          const heatmap = await r.json() as { services?: Array<{ service: string; calls: number; avgBlastScore?: number }> };
          const services = heatmap.services ?? [];
          if (services.length > 0) {
            console.log('');
            console.log('⬡ Onboarding snapshot — what Mergen has observed so far:');
            for (const svc of services.slice(0, 5)) {
              const blast = svc.avgBlastScore != null ? ` (avg blast-radius: ${Math.round((svc.avgBlastScore ?? 0) * 100)}%)` : '';
              console.log(`  • ${svc.service}: ${svc.calls} gate calls${blast}`);
            }
            console.log('  Run: mergen-server shadow-report   for the full picture');
            console.log('');
          }
        }
      } catch { /* non-fatal — never block startup */ }
    }

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

export async function detectIDE(): Promise<string> {
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

export async function configureIDE(ide: string): Promise<void> {
  const serverPath = SERVER_ENTRY;

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
      installClaudeCodePreToolUseHook();
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

/**
 * Registers `mergen-server gate-check` as a Claude Code PreToolUse hook for
 * the Bash tool, in ~/.claude/settings.json. This closes the gap where the
 * MCP gate (tool-guard.ts) only covers MCP tool calls — Claude Code's Bash
 * tool goes through the model's own tool-execution path, not MCP, so without
 * this hook a raw shell command was completely unobserved by Mergen.
 *
 * NOTE: the exact PreToolUse hook I/O contract (settings.json shape, stdin
 * JSON payload fields, exit-code semantics) was not verified against live
 * Claude Code documentation when this was written — gate-check's stdin
 * parser (commands/gate.ts) is written defensively and fails closed if the
 * payload shape doesn't match what's expected here, but this installer
 * should be treated as best-effort and verified in a real Claude Code
 * session (run a destructive command via the Bash tool with the hook
 * installed and confirm it's actually blocked) before relying on it.
 *
 * Merges into any existing settings.json rather than overwriting it, and is
 * idempotent — re-running setup does not duplicate the hook entry.
 *
 * settingsPath is overridable (tests point it at a scratch file rather than
 * mutating the real ~/.claude/settings.json).
 */
export function installClaudeCodePreToolUseHook(
  settingsPath: string = resolve(homedir(), '.claude', 'settings.json'),
): void {
  try {
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      } catch {
        log(`~/.claude/settings.json exists but is not valid JSON — skipping automatic hook install. Add it manually (see: mergen-server --help).`, '⚠');
        return;
      }
    }

    const hookCommand = `node "${CLI_ENTRY}" gate-check`;
    const hooks = (settings.hooks as Record<string, unknown> | undefined) ?? {};
    const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse as Array<Record<string, unknown>> : [];

    const alreadyInstalled = preToolUse.some((entry) => {
      const entryHooks = Array.isArray(entry.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
      return entryHooks.some((h) => h.type === 'command' && h.command === hookCommand);
    });
    if (alreadyInstalled) {
      log('Claude Code PreToolUse hook already installed.');
      return;
    }

    preToolUse.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: hookCommand }],
    });
    settings.hooks = { ...hooks, PreToolUse: preToolUse };

    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    log(`Installed a PreToolUse hook for the Bash tool → ${settingsPath}`);
    log('This covers Claude Code\'s Bash tool specifically — it does not extend MCP gate coverage to other IDEs or raw terminal use outside Claude Code.', 'ℹ');
  } catch (err) {
    log(`Could not install the Claude Code PreToolUse hook automatically: ${err instanceof Error ? err.message : String(err)}`, '⚠');
  }
}

export async function checkBinary(): Promise<void> {
  const serverPath = SERVER_ENTRY;
  if (!existsSync(serverPath)) {
    throw new Error(`Server not found at ${serverPath}`);
  }
}

export async function checkServerStarts(): Promise<void> {
  const serverPath = SERVER_ENTRY;
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

export async function checkHealth(): Promise<void> {
  const serverPath = SERVER_ENTRY;
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

export async function checkIngest(): Promise<void> {
  const serverPath = SERVER_ENTRY;
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

export async function checkIDEConfig(): Promise<void> {
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

export async function doctorCommand(): Promise<void> {
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
    const p = SERVER_ENTRY;
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

export async function quickstartCommand(): Promise<void> {
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
    const serverPath = SERVER_ENTRY;
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
