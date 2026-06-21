/**
 * calibration-git-sync.ts — Git-backed audit trail for calibration verdicts.
 *
 * When MERGEN_GIT_SYNC=true, every verdict written to calibration.json is
 * committed to a dedicated git repository at ~/.mergen/. This gives you:
 *
 *   - Persistence that survives reinstalls (push the repo to a private remote)
 *   - A human-readable history of how confidence calibration evolved over time
 *   - A diff-based audit trail a CISO can review before approving autopilot
 *
 * On first run, ~/.mergen/ is auto-initialised as a git repo with a sensible
 * .gitignore (excludes the secret file, session tokens, and SQLite WAL files).
 * Commits are non-blocking — a spawn() call that never delays the verdict write.
 *
 * Enable: MERGEN_GIT_SYNC=true
 * Remote: cd ~/.mergen && git remote add origin <url> && git push -u origin main
 */

import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

const GIT_DIR    = DATA_DIR;
const GIT_LOCK   = path.join(GIT_DIR, '.git');
const GITIGNORE  = path.join(GIT_DIR, '.gitignore');

const GITIGNORE_CONTENT = [
  '# Mergen data directory — only calibration and override corpus are tracked',
  'secret',
  'session.json',
  'license.json',
  'telemetry.json',
  '*.db',
  '*.db-wal',
  '*.db-shm',
  '*.tmp.*',
].join('\n') + '\n';

function isEnabled(): boolean {
  return process.env.MERGEN_GIT_SYNC === 'true';
}

function ensureRepo(): Promise<void> {
  return new Promise((resolve) => {
    if (fs.existsSync(GIT_LOCK)) { resolve(); return; }
    fs.mkdirSync(GIT_DIR, { recursive: true });
    if (!fs.existsSync(GITIGNORE)) {
      fs.writeFileSync(GITIGNORE, GITIGNORE_CONTENT, 'utf8');
    }
    execFile('git', ['-C', GIT_DIR, 'init', '-b', 'main'], (err) => {
      if (err) {
        // git < 2.28 doesn't support -b; fall back to init + branch rename
        execFile('git', ['-C', GIT_DIR, 'init'], (err2) => {
          if (err2) { logger.warn({ err: err2 }, 'calibration-git-sync: git init failed'); resolve(); return; }
          execFile('git', ['-C', GIT_DIR, 'checkout', '-b', 'main'], () => resolve());
        });
        return;
      }
      resolve();
    });
  });
}

/**
 * Fire-and-forget: stage calibration.json and commit with a descriptive message.
 * Safe to call on every verdict — git is idempotent when nothing changed.
 */
export function gitSyncCalibration(tag: string, verdict: string, pid: string): void {
  if (!isEnabled()) return;

  const commit = async () => {
    try {
      await ensureRepo();
      const msg = `calibration: ${tag} → ${verdict} (pid: ${pid.slice(0, 8)})`;
      const files = ['calibration.json', 'override-corpus.json', 'shadow-log.json']
        .map((f) => path.join(GIT_DIR, f))
        .filter((f) => fs.existsSync(f))
        .map((f) => path.relative(GIT_DIR, f));

      if (files.length === 0) return;

      spawn('git', ['-C', GIT_DIR, 'add', '--', ...files], { stdio: 'ignore' }).on('close', (addCode) => {
        if (addCode !== 0) return;
        spawn('git', ['-C', GIT_DIR, 'commit', '--allow-empty-message', '-m', msg, '--author', 'Mergen <mergen@localhost>'], {
          stdio: 'ignore',
          env: { ...process.env, GIT_AUTHOR_NAME: 'Mergen', GIT_COMMITTER_NAME: 'Mergen', GIT_AUTHOR_EMAIL: 'mergen@localhost', GIT_COMMITTER_EMAIL: 'mergen@localhost' },
        });
      });
    } catch (err) {
      logger.debug({ err }, 'calibration-git-sync: commit skipped');
    }
  };

  // Defer past the debounced persist (1 s) so we commit the written file, not the stale one.
  setTimeout(() => { void commit(); }, 1_500);
}
