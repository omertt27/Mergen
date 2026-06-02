/**
 * git-suspect.ts — Identify the suspect commit for a given file + line number.
 *
 * Implements the same heuristic used by Sentry and Datadog:
 *   1. git blame -L <line>,<line> --porcelain <file>  → commit SHA, author, summary
 *   2. git diff HEAD -- <file>                         → uncommitted local changes
 *   3. Conventional Commits weighting:
 *        feat/fix/refactor → HIGH causal weight (likely introduced the bug)
 *        chore/style/docs  → LOW  causal weight (unlikely)
 *
 * NOTE: Weighting is a heuristic, not a guarantee. A `feat:` that introduces
 * a bug scores HIGH correctly, but a `chore: update deps` that breaks a
 * transitive dependency scores LOW. Treat causalWeight as a signal to
 * investigate, not a determination of root cause.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const CONVENTIONAL_HIGH = /^(feat|fix|refactor|perf)(\(.*?\))?!?:/;
const CONVENTIONAL_LOW  = /^(chore|style|docs|ci|build|test)(\(.*?\))?!?:/;

export interface SuspectCommit {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  summary: string;
  timestamp: number;
  causalWeight: 'high' | 'medium' | 'low';
  hasLocalDiff: boolean;
  localDiffStat: string;
}

/**
 * Run git blame on a specific line of a file.
 * Returns null if git is unavailable, the file is untracked, or the line is invalid.
 */
export async function findSuspectCommit(
  filePath: string,
  line: number,
  cwd: string,
): Promise<SuspectCommit | null> {
  try {
    const rel = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;

    const { stdout: blameOut } = await execFileAsync(
      'git', ['blame', `-L${line},${line}`, '--porcelain', rel],
      { cwd, timeout: 5_000 },
    );

    const sha = blameOut.slice(0, 40);
    if (!sha || sha === '0'.repeat(40)) return null;

    const lines = blameOut.split('\n');
    const get = (prefix: string) =>
      lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';

    const author = get('author ');
    const authorEmail = get('author-mail').replace(/[<>]/g, '');
    const summary = get('summary');
    const tsStr = get('author-time');
    const timestamp = tsStr ? parseInt(tsStr, 10) * 1000 : 0;

    let causalWeight: SuspectCommit['causalWeight'] = 'medium';
    if (CONVENTIONAL_HIGH.test(summary)) causalWeight = 'high';
    else if (CONVENTIONAL_LOW.test(summary)) causalWeight = 'low';

    let hasLocalDiff = false;
    let localDiffStat = '';
    try {
      const { stdout: diffOut } = await execFileAsync(
        'git', ['diff', 'HEAD', '--stat', '--', rel],
        { cwd, timeout: 3_000 },
      );
      hasLocalDiff = diffOut.trim().length > 0;
      const statLine = diffOut.trim().split('\n').pop() ?? '';
      localDiffStat = statLine.replace(/\s+\|\s+.*/, '').trim();
    } catch {
      // file may not be tracked
    }

    return {
      sha,
      shortSha: sha.slice(0, 8),
      author,
      authorEmail,
      summary,
      timestamp,
      causalWeight,
      hasLocalDiff,
      localDiffStat,
    };
  } catch {
    return null;
  }
}

// ── CODEOWNERS ────────────────────────────────────────────────────────────────

export interface CodeOwnerResult {
  owners: string[];       // e.g. ['@auth-team', '@alice']
  pattern: string;        // the matching rule, e.g. 'src/auth/'
  source: string;         // which CODEOWNERS file was read
}

const _coCache = new Map<string, { parsed: Array<{ pattern: string; owners: string[] }>; mtime: number }>();

function _loadCodeowners(cwd: string): Array<{ pattern: string; owners: string[] }> | null {
  const candidates = [
    path.join(cwd, '.github', 'CODEOWNERS'),
    path.join(cwd, 'CODEOWNERS'),
    path.join(cwd, 'docs', 'CODEOWNERS'),
  ];

  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      const cached = _coCache.get(p);
      if (cached && cached.mtime === stat.mtimeMs) return cached.parsed;

      const lines = fs.readFileSync(p, 'utf8').split('\n');
      const parsed: Array<{ pattern: string; owners: string[] }> = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;
        parsed.push({ pattern: parts[0], owners: parts.slice(1) });
      }
      // Reverse so later (more specific) rules take precedence on first-match
      parsed.reverse();
      _coCache.set(p, { parsed, mtime: stat.mtimeMs });
      return parsed;
    } catch { /* file not found */ }
  }
  return null;
}

function _matchesPattern(filePath: string, pattern: string): boolean {
  // Normalise to forward slashes for matching
  const fp = filePath.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');

  // Directory pattern (ends with /)
  if (pat.endsWith('/')) return fp.startsWith(pat.slice(1)) || fp.startsWith(pat);

  // Glob * (single segment)
  if (pat.includes('*')) {
    const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(escaped + '$').test(fp) || new RegExp(escaped + '$').test(fp.split('/').pop() ?? '');
  }

  // Exact file or directory prefix
  return fp === pat || fp === pat.replace(/^\//, '') || fp.endsWith('/' + pat) || fp.startsWith(pat + '/') || fp.startsWith(pat.replace(/^\//, '') + '/');
}

/**
 * Find the CODEOWNERS entries for a given file path.
 * Returns null if no CODEOWNERS file is found or no rule matches.
 */
export function findCodeOwners(filePath: string, cwd: string): CodeOwnerResult | null {
  try {
    const rules = _loadCodeowners(cwd);
    if (!rules) return null;

    const rel = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
    const normalised = rel.replace(/\\/g, '/');

    for (const rule of rules) {
      if (_matchesPattern(normalised, rule.pattern)) {
        const source = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']
          .find((f) => { try { fs.statSync(path.join(cwd, f)); return true; } catch { return false; } }) ?? 'CODEOWNERS';
        return { owners: rule.owners, pattern: rule.pattern, source };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the working-directory diff for a specific file.
 * Returns the unified diff string (empty if no local changes).
 */
export async function getLocalDiff(filePath: string, cwd: string): Promise<string> {
  try {
    const rel = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
    const { stdout } = await execFileAsync(
      'git', ['diff', 'HEAD', '--', rel],
      { cwd, timeout: 5_000 },
    );
    return stdout.slice(0, 3_000);
  } catch {
    return '';
  }
}
