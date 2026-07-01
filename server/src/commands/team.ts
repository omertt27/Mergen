/**
 * commands/team.ts — extracted from cli.ts (C2 refactor).
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

export async function inviteCommand(): Promise<void> {
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

export async function joinCommand(args: string[]): Promise<void> {
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

export async function impactReportCommand(args: string[]): Promise<void> {
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

export async function exportCommand(args: string[]): Promise<void> {
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

export async function initCommand(): Promise<void> {
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

export async function demoCommand(): Promise<void> {
  const { createServer } = await import('http');
  const { createApp } = await import('../app.js');
  const { loadSeedCorpus, SEED_COUNT } = await import('../seeds/corpus.js');

  console.log('\n⬡ Mergen\n');

  // Seed the replay corpus so replay demos work immediately on first run.
  process.stdout.write('Loading 50 sample incidents...');
  const { loaded } = loadSeedCorpus();
  console.log(` ✓  (${loaded > 0 ? `${loaded} loaded` : `${SEED_COUNT} ready`})`);

  // Show instant causal analysis on a sample incident before the browser opens
  try {
    const { listSnapshotPids, replayIncident } = await import('../intelligence/incident-replay.js');
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

export async function exportRiskReportCommand(args: string[]): Promise<void> {
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

export async function partnerShortlistCommand(subArgs: string[]): Promise<void> {
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

export async function execCommand(args: string[]): Promise<void> {
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
  } = await import('../intelligence/enterprise-policy-engine.js');

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
