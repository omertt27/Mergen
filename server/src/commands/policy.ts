/**
 * commands/policy.ts — extracted from cli.ts (C2 refactor).
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

export async function approveCommand(cmdArgs: string[]): Promise<void> {
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

export async function shadowReportCommand(): Promise<void> {
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

export async function allowCommand(args: string[]): Promise<void> {
  const { loadEnterprisePolicy, saveEnterprisePolicy } = await import('../intelligence/enterprise-policy-engine.js');

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

export async function verifyLogCommand(): Promise<void> {
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

export async function guardCommand(args: string[]): Promise<void> {
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

export async function policyPushCommand(): Promise<void> {
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

export async function policyPullCommand(args: string[]): Promise<void> {
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

export async function policyDiffCommand(): Promise<void> {
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

export async function testSafetyCommand(): Promise<void> {
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
  const { evaluateEnterprisePolicy, loadEnterprisePolicy, DEFAULT_ENTERPRISE_POLICY, _resetPolicyCacheForTesting } = await import('../intelligence/enterprise-policy-engine.js');
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
