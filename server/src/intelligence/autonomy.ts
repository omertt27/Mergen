/**
 * autonomy.ts — Sandboxed remediation execution for the autonomous triage agent.
 *
 * Provides `executeRemediation()` which runs a shell command derived from a
 * hypothesis fixHint. Hard safety gates prevent destructive operations.
 *
 * Safety model:
 *   1. Allowlist: only commands matching a known-safe form are permitted.
 *      Anything not on the allowlist is rejected — safer than enumerating
 *      every dangerous variant (denylist gaps are silent; allowlist gaps are loud).
 *   2. Whitespace normalization: collapse tabs/multi-spaces before matching so
 *      "npm  install" cannot bypass a pattern that expects single spaces.
 *   3. Timeout: 60s max execution. Long-running commands are killed.
 *   4. Output cap: 16KB of stdout/stderr captured; remainder discarded.
 *   5. Audit: every execution (including rejections) is written to the audit log.
 *   6. No auto-apply without `confirm: true` from the caller — the MCP tool
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
import os from 'os';
import path from 'path';
import { recordExecutionAudit } from '../sensor/audit-log.js';
import { hasPermission } from '../sensor/rbac.js';
import { recordBlunder } from '../sensor/agent-blunder-store.js';
import logger from '../sensor/logger.js';
import { SAFETY_POLICY_FILE } from '../sensor/paths.js';

// ── Layer 3: Safety Policy (Immutable Guardrails) ───────────────────────────
export interface SafetyPolicy {
  version: number;
  blockedKeywords: string[];
  blockedServices: string[];
}

const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  version: 1,
  blockedKeywords: [
    'rm -rf',
    'drop table',
    'truncate',
    'delete',
    'production-db',
    'postgres',
    'mysql',
    'redis',
    'mongo'
  ],
  blockedServices: [
    'payments',
    'auth-service',
    'database'
  ]
};

let _safetyPolicy: SafetyPolicy | null = null;

export function loadSafetyPolicy(force = false): SafetyPolicy {
  if (_safetyPolicy && !force) return _safetyPolicy;
  
  if (!fs.existsSync(SAFETY_POLICY_FILE)) {
    try {
      fs.mkdirSync(path.dirname(SAFETY_POLICY_FILE), { recursive: true });
      fs.writeFileSync(SAFETY_POLICY_FILE, JSON.stringify(DEFAULT_SAFETY_POLICY, null, 2), 'utf8');
      logger.info({ path: SAFETY_POLICY_FILE }, 'autonomy: created default safety-policy.json');
    } catch (err) {
      logger.warn({ err }, 'autonomy: failed to write default safety policy');
    }
    _safetyPolicy = DEFAULT_SAFETY_POLICY;
    return _safetyPolicy;
  }

  try {
    const raw = fs.readFileSync(SAFETY_POLICY_FILE, 'utf8');
    const parsed = JSON.parse(raw) as SafetyPolicy;
    if (parsed && Array.isArray(parsed.blockedKeywords) && Array.isArray(parsed.blockedServices)) {
      _safetyPolicy = parsed;
    } else {
      _safetyPolicy = DEFAULT_SAFETY_POLICY;
    }
  } catch (err) {
    logger.warn({ err }, 'autonomy: failed to load safety policy — using defaults');
    _safetyPolicy = DEFAULT_SAFETY_POLICY;
  }
  return _safetyPolicy;
}

export function checkSafetyPolicy(command: string): { allowed: boolean; blockReason?: string } {
  const policy = loadSafetyPolicy();
  const normalized = normalizeWhitespace(command).toLowerCase();

  // Check blocked keywords
  for (const keyword of policy.blockedKeywords) {
    if (normalized.includes(keyword.toLowerCase())) {
      return {
        allowed: false,
        blockReason: `Command matches safety-policy blocked keyword/pattern: '${keyword}'`
      };
    }
  }

  // Check targeted blocked services
  for (const service of policy.blockedServices) {
    if (normalized.includes(service.toLowerCase())) {
      return {
        allowed: false,
        blockReason: `Command targets safety-policy blocked service: '${service}'`
      };
    }
  }

  return { allowed: true };
}

// ── Allowlist (primary gate) ──────────────────────────────────────────────────
// Only commands matching one of these forms are executed. Everything else is
// rejected. This is intentionally narrow: false positives (blocking a valid fix)
// are far less dangerous than false negatives (executing an injected command).
//
// Each entry is matched against the whitespace-normalized command string so that
// injection attempts using extra spaces, tabs, or Unicode whitespace are caught.
const ALLOWED_COMMANDS: Array<{ pattern: RegExp; description: string }> = [
  // Package managers
  { pattern: /^npm (install|ci|rebuild|run \S+|update \S+)(\s|$)/i,   description: 'npm install / ci / rebuild / run / update' },
  { pattern: /^yarn (install|run \S+|add \S+)(\s|$)/i,               description: 'yarn install / run / add' },
  { pattern: /^pnpm (install|run \S+|update \S+|add \S+)(\s|$)/i,    description: 'pnpm install / run / update / add' },
  // pip install: only allow package-name installs. Block URL schemes (https://, git+),
  // and flags that write to arbitrary paths (--target, --prefix).
  { pattern: /^pip3? install (?!https?:\/\/|git\+|--target[\s=]|--prefix[\s=])[\w.-]/i, description: 'pip install <package-name> (no URL or path installs)' },
  // Git — safe, read-side / restore operations only
  { pattern: /^git checkout [a-f0-9]{4,40}(\s|$)/i,                  description: 'git checkout <sha>' },
  { pattern: /^git fetch(\s|$)/i,                                     description: 'git fetch' },
  { pattern: /^git stash (push|pop)(\s|$)/i,                          description: 'git stash push / pop' },
  { pattern: /^git pull --ff-only(\s|$)/i,                            description: 'git pull --ff-only' },
  // Container orchestration
  { pattern: /^docker (restart|stop|start|logs) \S+/i,               description: 'docker restart/stop/start/logs <container>' },
  { pattern: /^kubectl rollout (restart|undo) /i,                     description: 'kubectl rollout restart / undo' },
  { pattern: /^kubectl scale deployment /i,                           description: 'kubectl scale deployment' },
  // Service control
  { pattern: /^systemctl (restart|stop|start|reload) \S+/i,          description: 'systemctl restart/stop/start/reload' },
  { pattern: /^service \S+ (restart|stop|start)/i,                   description: 'service <name> restart/stop/start' },
  // Build — restricted to known-safe targets only. Makefile targets can execute
  // arbitrary shell code, so we permit only a fixed set rather than \S+ (any target).
  { pattern: /^make (build|test|install|restart|reload|start|stop|clean|lint|check)(\s|$)/i, description: 'make <build|test|install|restart|reload|start|stop|clean|lint|check>' },
];

export const ALLOWED_COMMAND_DESCRIPTIONS = ALLOWED_COMMANDS.map((r) => r.description);

/** Collapse all whitespace sequences to a single space before matching. */
function normalizeWhitespace(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ');
}

// Shell metacharacters that can chain or inject commands regardless of the prefix.
// A command that starts with "npm install" but contains "$(…)" or ";" is still
// an injection attempt. Reject before the prefix pattern even runs.
const SHELL_METACHAR_RE = /[;&|`$(){}[\]<>\\!]/;

function checkAllowlist(command: string): { allowed: boolean; matchedRule?: string; blockReason?: string } {
  const normalized = normalizeWhitespace(command);

  if (SHELL_METACHAR_RE.test(normalized)) {
    return {
      allowed: false,
      blockReason: 'Command contains shell metacharacter — possible injection attempt',
    };
  }

  const match = ALLOWED_COMMANDS.find((r) => r.pattern.test(normalized));
  if (match) return { allowed: true, matchedRule: match.description };
  return {
    allowed: false,
    blockReason:
      `Command does not match any allowed pattern. ` +
      `Allowed forms: ${ALLOWED_COMMAND_DESCRIPTIONS.join(', ')}`,
  };
}

const MAX_OUTPUT_BYTES = 16 * 1024; // 16 KB
const EXEC_TIMEOUT_MS  = 60_000;   // 60 s

/**
 * Validate a caller-supplied working directory.
 * Only accepts real, existing directories rooted under the server's cwd
 * or the current user's home directory. Rejects path-traversal attempts
 * and any path that does not exist on disk.
 *
 * Shared by executeRemediation() and routes/incident-webhook.ts.
 */
export function validateCwd(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const resolved = path.resolve(raw);
  const safePrefixes = [process.cwd(), os.homedir()];
  const isUnderSafeRoot = safePrefixes.some(
    (p) => resolved === p || resolved.startsWith(p + path.sep),
  );
  if (!isUnderSafeRoot) {
    logger.warn({ cwd: raw, resolved }, 'autonomy: rejected cwd outside safe root');
    return undefined;
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return resolved;
}

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

function _auditExecution(cmd: string, result: RemediationResult, actor = 'unknown'): void {
  try {
    recordExecutionAudit({
      ts: new Date().toISOString(),
      event: 'autonomy.execute',
      actor,
      cmd: cmd.slice(0, 500),
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      blocked: result.blocked,
      blockReason: result.blockReason ?? '',
      timedOut: result.timedOut,
    });
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
  opts: { cwd?: string; dryRun?: boolean; actor?: string } = {},
): Promise<RemediationResult> {
  const start = Date.now();
  const actor = opts.actor ?? 'unknown';

  // ── RBAC check ────────────────────────────────────────────────────────────────
  if (!hasPermission(actor, 'responder')) {
    const result: RemediationResult = {
      ok: false, exitCode: null, stdout: '', stderr: '',
      durationMs: 0, timedOut: false, blocked: true,
      blockReason: `Actor '${actor}' does not have the 'responder' role required for fix execution`,
    };
    _auditExecution(command, result, actor);
    logger.warn({ actor, command }, 'autonomy: command blocked by RBAC (insufficient role)');
    recordBlunder({ blunderType: 'rbac_block', command, blockReason: result.blockReason!, service: null, tag: null, actor, pid: null, confidenceScore: null });
    return result;
  }

  // ── Safety check (allowlist) ─────────────────────────────────────────────────
  const { allowed, matchedRule, blockReason } = checkAllowlist(command);
  if (!allowed) {
    const result: RemediationResult = {
      ok: false, exitCode: null, stdout: '', stderr: '',
      durationMs: Date.now() - start, timedOut: false, blocked: true,
      blockReason,
    };
    _auditExecution(command, result, actor);
    logger.warn({ command, blockReason }, 'autonomy: command blocked by allowlist');
    const blunderType = typeof blockReason === 'string' && /inject/i.test(blockReason) ? 'injection_attempt' : 'allowlist_block';
    recordBlunder({ blunderType, command, blockReason: blockReason ?? '', service: null, tag: null, actor, pid: null, confidenceScore: null });
    return result;
  }

  // ── Layer 3: Safety Policy Check ─────────────────────────────────────────────
  const safetyCheck = checkSafetyPolicy(command);
  if (!safetyCheck.allowed) {
    const result: RemediationResult = {
      ok: false, exitCode: null, stdout: '', stderr: '',
      durationMs: Date.now() - start, timedOut: false, blocked: true,
      blockReason: safetyCheck.blockReason,
    };
    _auditExecution(command, result, actor);
    logger.warn({ command, blockReason: safetyCheck.blockReason }, 'autonomy: command blocked by safety policy');
    recordBlunder({
      blunderType: 'pipeline_block',
      command,
      blockReason: safetyCheck.blockReason ?? '',
      service: null,
      tag: null,
      actor,
      pid: null,
      confidenceScore: null
    });
    return result;
  }

  logger.debug({ command, matchedRule }, 'autonomy: command passed allowlist');

  if (opts.dryRun) {
    const result: RemediationResult = {
      ok: true, exitCode: 0, stdout: `[dry-run] would execute: ${command}`,
      stderr: '', durationMs: 0, timedOut: false, blocked: false,
    };
    _auditExecution(command, result, actor);
    return result;
  }

  // ── Execute ───────────────────────────────────────────────────────────────────
  // Validate the caller-supplied cwd: only allow paths under process.cwd() or
  // the home directory. Falls back to process.cwd() if invalid or absent.
  const safeCwd = validateCwd(opts.cwd) ?? process.cwd();
  logger.info({ command, cwd: safeCwd }, 'autonomy: executing remediation command');

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('/bin/sh', ['-c', command], {
      cwd: safeCwd,
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
      _auditExecution(command, result, actor);
      logger.info(
        { exitCode: code, durationMs: result.durationMs, timedOut, actor },
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
      _auditExecution(command, result, actor);
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
// Prefix pattern shared by backtick extraction and line scanning.
// Only strings starting with a known CLI keyword are treated as commands.
// This prevents log-content injection: a fixHint containing an error message
// like `could not run make deploy` would previously extract "make deploy"
// from the backtick span. Now the span must start with a CLI keyword to qualify.
const CLI_PREFIXES = /^(npm|yarn|pnpm|pip3?|python3?|node|git|docker|kubectl|make|cargo|go|brew|apt|systemctl|service)\s/i;

export function extractCommand(fixHint: string): string | null {
  if (!fixHint) return null;

  // Backtick code span — only accept if it starts with a known CLI keyword.
  // Rejecting arbitrary backtick spans prevents log-content strings like
  // `database connection refused` from being mistaken for executable commands.
  const backtickMatches = [...fixHint.matchAll(/`([^`]{4,200})`/g)];
  for (const m of backtickMatches) {
    const candidate = m[1].trim();
    if (CLI_PREFIXES.test(candidate)) return candidate;
  }

  // $ prompt: $ npm run build
  const prompt = fixHint.match(/\$\s+([^\n]{4,200})/);
  if (prompt) {
    const candidate = prompt[1].trim();
    if (CLI_PREFIXES.test(candidate)) return candidate;
  }

  // Line starting with a known CLI keyword
  const lines = fixHint.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (CLI_PREFIXES.test(trimmed)) return trimmed;
  }

  return null;
}
