/**
 * commands/github.ts — extracted from cli.ts (C2 refactor).
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

export async function prCommand(args: string[]): Promise<void> {
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

export async function connectGitHubCommand(args: string[]): Promise<void> {
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

export async function backfillGitHubCommand(args: string[]): Promise<void> {
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
  let upsertFn: ((ctx: import('../sensor/commit-context-store.js').CommitContext) => void) | null = null;
  try {
    const { commitContextStore } = await import('../sensor/commit-context-store.js');
    await commitContextStore.init();
    upsertFn = (ctx) => commitContextStore.upsert(ctx);
  } catch (e) {
    error(`Could not initialise commit context store: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const { extractLinkedIssues } = await import('../sensor/commit-context-store.js');
  const { detectAiCommit }      = await import('../intelligence/ai-commit.js');

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

export async function prShadowCommand(): Promise<void> {
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

export async function feedbackCommand(args: string[]): Promise<void> {
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

export async function backfillCommand(args: string[]): Promise<void> {
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

export async function connectCommand(args: string[]): Promise<void> {
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
