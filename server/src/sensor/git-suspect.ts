/**
 * git-suspect.ts — Identify the suspect commit for a given file + line number.
 *
 * Implements the same heuristic used by Sentry and Datadog:
 *   1. git blame -L <line>,<line> --porcelain <file>  → commit SHA, author, summary
 *   2. git diff HEAD -- <file>                         → uncommitted local changes
 *   3. Conventional Commits weighting:
 *        feat/fix/refactor → HIGH causal weight (likely introduced the bug)
 *        chore/style/docs  → LOW  causal weight (unlikely)
 */

import { execFile } from 'child_process';
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
