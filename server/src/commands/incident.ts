/**
 * commands/incident.ts — extracted from cli.ts (C2 refactor).
 */
import { execSync, spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { resolve, dirname, join } from 'path';
import * as os from 'os';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { log, success, error, hr, ask, sleep, VERSION, SERVER_ENTRY, findPort, maybeFlushOfflineBlunders } from './shared.js';

export async function postmortemCommand(args: string[]): Promise<void> {
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

export async function timelineCommand(args: string[]): Promise<void> {
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

export async function watchCommand(args: string[]): Promise<void> {
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
    const serverPath = SERVER_ENTRY;
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

export async function explainCommand(args: string[]): Promise<void> {
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
    const { buildCausalChain } = await import('../intelligence/causal.js');
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

export async function statusCommand(): Promise<void> {
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

export async function resolvedCommand(args: string[]): Promise<void> {
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

export async function replayCommand(args: string[]): Promise<void> {
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

  const { buildCausalChain } = await import('../intelligence/causal.js') as {
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
