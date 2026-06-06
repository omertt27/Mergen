/**
 * autonomy.ts — Sandboxed remediation execution for the autonomous triage agent.
 *
 * Provides `executeRemediation()` which runs a shell command derived from a
 * hypothesis fixHint. Hard safety gates prevent destructive operations.
 *
 * Safety model:
 *   1. Blocklist: commands matching dangerous patterns are rejected before exec.
 *   2. Timeout: 60s max execution. Long-running commands are killed.
 *   3. Output cap: 16KB of stdout/stderr captured; remainder discarded.
 *   4. Audit: every execution (including rejections) is written to the audit log.
 *   5. No auto-apply without `confirm: true` from the caller — the MCP tool
 *      requires the AI to explicitly pass confirm=true after showing the user
 *      what will be executed.
 *
 * What this is NOT:
 *   - Not a general-purpose shell executor. It only runs commands derived from
 *     hypothesis fixHints which are narrowly scoped (npm install, git checkout,
 *     env var changes, service restarts).
 *   - Not autonomous without a confidence gate. The triage_incident tool only
 *     calls this when confidenceScore >= 0.85 (HIGH HIGH).
 */

import { spawn } from 'child_process';
import fs from 'fs';
import { AUDIT_LOG } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

// ── Safety blocklist ──────────────────────────────────────────────────────────
// Patterns matched against the full command string. Any match = hard reject.
const BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+-rf?\s+[^-]/i,          // rm -rf <anything>
  /rm\s+.*\//i,                  // rm with path separators
  />\s*\/dev\/sd/i,              // writes to disk devices
  /dd\s+if=/i,                   // disk dump
  /mkfs/i,                       // filesystem format
  /:\(\)\s*\{.*:\|:&/i,          // fork bomb
  /curl.*\|\s*(bash|sh|zsh)/i,   // curl | shell
  /wget.*\|\s*(bash|sh|zsh)/i,   // wget | shell
  /chmod\s+777/i,                // world-writable
  /chown\s+.*\.\./i,             // chown traversal
  /sudo\s+rm/i,                  // sudo remove
  /DROP\s+TABLE/i,               // SQL drop
  /DROP\s+DATABASE/i,            // SQL drop db
  /TRUNCATE\s+TABLE/i,           // SQL truncate
  /git\s+push\s+.*--force/i,     // force push
  /git\s+reset\s+--hard/i,       // hard reset
];

const MAX_OUTPUT_BYTES = 16 * 1024; // 16 KB
const EXEC_TIMEOUT_MS  = 60_000;   // 60 s

export interface RemediationResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  blocked: boolean;
  blockReason?: string;
}

function _auditExecution(cmd: string, result: RemediationResult): void {
  try {
    const entry = JSON.stringify({
      t: new Date().toISOString(),
      event: 'autonomy.execute',
      cmd: cmd.slice(0, 500),
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      blocked: result.blocked,
      blockReason: result.blockReason,
      timedOut: result.timedOut,
    });
    fs.appendFileSync(AUDIT_LOG, entry + '\n', 'utf8');
  } catch {
    // Audit log failures must never crash the server.
  }
}

/**
 * Execute a shell command derived from a hypothesis fixHint.
 *
 * @param command - The command to execute (passed to /bin/sh -c)
 * @param cwd     - Working directory (defaults to process.cwd())
 */
export async function executeRemediation(
  command: string,
  opts: { cwd?: string; dryRun?: boolean } = {},
): Promise<RemediationResult> {
  const start = Date.now();

  // ── Safety check ─────────────────────────────────────────────────────────────
  const blocked = BLOCKED_PATTERNS.find((p) => p.test(command));
  if (blocked) {
    const result: RemediationResult = {
      ok: false, exitCode: null, stdout: '', stderr: '',
      durationMs: Date.now() - start, timedOut: false, blocked: true,
      blockReason: `Command matches blocked pattern: ${blocked.toString()}`,
    };
    _auditExecution(command, result);
    logger.warn({ command, pattern: blocked.toString() }, 'autonomy: command blocked by safety filter');
    return result;
  }

  if (opts.dryRun) {
    const result: RemediationResult = {
      ok: true, exitCode: 0, stdout: `[dry-run] would execute: ${command}`,
      stderr: '', durationMs: 0, timedOut: false, blocked: false,
    };
    _auditExecution(command, result);
    return result;
  }

  // ── Execute ───────────────────────────────────────────────────────────────────
  logger.info({ command, cwd: opts.cwd }, 'autonomy: executing remediation command');

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('/bin/sh', ['-c', command], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 2000);
    }, EXEC_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const result: RemediationResult = {
        ok: (code === 0) && !timedOut,
        exitCode: code,
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        durationMs: Date.now() - start,
        timedOut,
        blocked: false,
      };
      _auditExecution(command, result);
      logger.info(
        { exitCode: code, durationMs: result.durationMs, timedOut },
        'autonomy: command completed',
      );
      resolve(result);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      const result: RemediationResult = {
        ok: false, exitCode: null,
        stdout, stderr: stderr + '\n' + String(err),
        durationMs: Date.now() - start, timedOut: false, blocked: false,
      };
      _auditExecution(command, result);
      resolve(result);
    });
  });
}

/**
 * Extract an executable shell command from a fixHint string.
 * Returns null if the hint doesn't appear to contain a runnable command.
 *
 * Looks for: backtick code spans, $ prompts, or lines starting with known
 * package manager / shell commands.
 */
export function extractCommand(fixHint: string): string | null {
  if (!fixHint) return null;

  // Backtick code span: `npm install foo`
  const backtick = fixHint.match(/`([^`]{4,200})`/);
  if (backtick) return backtick[1].trim();

  // $ prompt: $ npm run build
  const prompt = fixHint.match(/\$\s+([^\n]{4,200})/);
  if (prompt) return prompt[1].trim();

  // Starts with a known CLI keyword
  const CLI_PREFIXES = /^(npm|yarn|pnpm|pip|python|node|git|docker|kubectl|make|cargo|go|brew|apt|systemctl|service)\s/i;
  const lines = fixHint.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (CLI_PREFIXES.test(trimmed)) return trimmed;
  }

  return null;
}
