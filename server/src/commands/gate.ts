/**
 * commands/gate.ts — shared HTTP client for POST /gate/evaluate (routes/gate.ts),
 * plus the `gate-check` CLI subcommand used by the Claude Code PreToolUse hook.
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { error, hr } from './shared.js';
import { findPort } from './shared.js';

export type GateEvaluation =
  | { reachable: true; isError: boolean; text: string }
  | { reachable: false };

function readLocalSecret(): string {
  const secretPath = join(homedir(), '.mergen', 'secret');
  if (existsSync(secretPath)) {
    try { return readFileSync(secretPath, 'utf8').trim(); } catch { /* fall through */ }
  }
  return '';
}

/**
 * Evaluates `command` through the real gate (same decision path an MCP tool
 * call goes through — policy, HITL hold/wait, blast radius, injection
 * detection, blunder logging). Returns { reachable: false } if no
 * mergen-server is running locally — callers must decide how to handle that
 * (fail closed by default; `exec --allow-offline` is the one opt-out).
 */
export async function evaluateViaGate(command: string, toolName?: string): Promise<GateEvaluation> {
  const port = await findPort();
  if (!port) return { reachable: false };

  const secret = readLocalSecret();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['x-mergen-secret'] = secret;

  const resp = await fetch(`http://127.0.0.1:${port}/gate/evaluate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command, toolName }),
    signal: AbortSignal.timeout(5 * 60_000), // generous — a HOLD suspends until a human approves/denies
  });
  if (!resp.ok) {
    throw new Error(`gate evaluation request failed: HTTP ${resp.status}`);
  }
  const body = await resp.json() as { isError: boolean; text: string };
  return { reachable: true, isError: body.isError, text: body.text };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/**
 * Extracts the shell command from a Claude Code PreToolUse hook's stdin JSON
 * payload. Checked defensively against a few plausible field paths since this
 * hook I/O shape was not verified against live Claude Code docs at the time
 * this was written — if the shape has changed, extraction fails and the
 * caller fails closed (blocks) rather than silently allowing.
 */
export function extractCommandFromHookPayload(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const toolInput = obj.tool_input as Record<string, unknown> | undefined;
  const candidate =
    toolInput?.command ??
    toolInput?.cmd ??
    obj.command ??
    obj.cmd;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * `mergen-server gate-check -- <command...>` — decision only, does not
 * execute. Two invocation modes:
 *   1. Explicit command: `gate-check -- <command>` (scripts, manual testing)
 *   2. Claude Code PreToolUse hook mode: invoked with no `--` args, reads the
 *      hook's JSON payload from stdin. Exit code is the contract Claude Code
 *      hooks use to allow (0) or block (non-zero) — see
 *      extractCommandFromHookPayload's doc comment re: unverified I/O shape.
 */
export async function gateCheckCommand(args: string[]): Promise<void> {
  const dashDash = args.indexOf('--');
  const cmdParts = dashDash >= 0 ? args.slice(dashDash + 1) : args;

  let fullCommand: string;
  if (cmdParts.length > 0) {
    fullCommand = cmdParts.join(' ');
  } else {
    const raw = await readStdin();
    const extracted = raw ? extractCommandFromHookPayload(raw) : null;
    if (!extracted) {
      error('gate-check: no command given (pass -- <command>, or a Claude Code hook JSON payload on stdin) — failing closed.');
      process.exit(1);
      return;
    }
    fullCommand = extracted;
  }

  let evaluation: GateEvaluation;
  try {
    evaluation = await evaluateViaGate(fullCommand);
  } catch (err) {
    error(`gate-check: could not reach mergen-server — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  if (!evaluation.reachable) {
    hr();
    error('gate-check: no mergen-server is running — refusing to allow (fail closed).');
    console.error('  Start it with: mergen-server start');
    hr();
    process.exit(1);
  }

  if (evaluation.isError) {
    hr();
    console.error('⬡ Mergen — BLOCKED\n');
    console.error(evaluation.text);
    hr();
    process.exit(1);
  }

  // Pass (or a HOLD that was subsequently approved) — exit 0, caller executes the command.
  process.exit(0);
}
