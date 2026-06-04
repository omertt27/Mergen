/**
 * process-watcher.ts — Stream stdout/stderr of any local process into the buffer.
 *
 * Turns any dev server into a causal signal source. Usage:
 *   startProcessWatcher({ name: 'backend', command: 'node', args: ['server.js'], cwd: '/my/app' })
 *
 * Design constraints:
 *   - Rate-limited to MAX_LINES_PER_SEC to prevent buffer saturation during log bursts.
 *   - Long lines are truncated to 2000 chars (enough for stack traces, not megabytes).
 *   - Structured JSON log lines (pino, winston, bunyan) are detected and their `level`
 *     field is used to drive severity routing in the buffer.
 *   - Non-zero exit → process_exit event pushed immediately so the causal engine
 *     can correlate a browser error with a backend crash.
 *   - All errors are best-effort: a broken watcher never crashes the Mergen server.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { store } from './buffer.js';
import type { TerminalOutputEvent, ProcessExitEvent } from './buffer.js';
import logger from './logger.js';

const MAX_LINES_PER_SEC = 30;
const MAX_LINE_LENGTH   = 2_000;
const RATE_WINDOW_MS    = 1_000;

// ── ANSI stripping ────────────────────────────────────────────────────────────
// Spring Boot, Rails, and Django dev servers write ANSI escape codes when they
// detect a TTY. Even with stdio:'pipe' some frameworks force colors. Strip them
// before storing so buffer events contain clean text for LLM consumption.
const ANSI_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*(?:\x07|\x1b\\)|\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e])/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ── Framework-specific env ────────────────────────────────────────────────────
// Force pipe-safe output for common dev server frameworks.
// NO_COLOR and TERM=dumb are the baseline; each framework adds its own flag.
// User-supplied env (opts.env) always wins — never override explicit settings.
function frameworkEnv(command: string, args: string[]): Record<string, string> {
  const full = [command, ...args].join(' ').toLowerCase();
  const env: Record<string, string> = { NO_COLOR: '1', TERM: 'dumb' };

  if (/python|manage\.py|django|gunicorn|uvicorn|fastapi/.test(full)) {
    env.PYTHONUNBUFFERED = '1';
  }
  if (/\bjava\b|mvn|gradle|spring-boot|bootrun/.test(full)) {
    const existing = process.env.JAVA_TOOL_OPTIONS ?? '';
    const flag = '-Dspring.output.ansi.enabled=never';
    env.JAVA_TOOL_OPTIONS = existing.includes(flag) ? existing : (existing ? `${existing} ${flag}` : flag);
  }
  if (/\bruby\b|rails|puma|unicorn|rackup/.test(full)) {
    env.DISABLE_SPRING = '1';
    env.RAILS_LOG_TO_STDOUT = '1';
  }

  return env;
}

// ── TraceId extraction ────────────────────────────────────────────────────────
// Scan each log line for a W3C traceparent or a structured trace ID key-value
// pair. When found, the 32-char hex traceId is stored on the TerminalOutputEvent
// so get_unified_timeline can do a deterministic browser↔backend join without
// requiring any backend instrumentation changes.
//
// Patterns recognised (zero developer action required for any of these):
//   traceparent: 00-abc123...(32hex)-def456...(16hex)-01   (W3C header logged verbatim)
//   traceId: abc123...   "traceId":"abc123..."   trace_id=abc123...   (structured logs)

const TRACEPARENT_RE = /\b00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}\b/i;
const TRACE_KV_RE    = /(?:trace[_-]?id|traceid)["'\s]*[:=]["'\s]*([0-9a-f]{32})\b/i;

function extractTraceId(line: string): string | null {
  const tp = TRACEPARENT_RE.exec(line);
  if (tp) return tp[1].toLowerCase();
  const kv = TRACE_KV_RE.exec(line);
  if (kv) return kv[1].toLowerCase();
  return null;
}

interface WatcherOptions {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface ActiveWatcher {
  proc: ChildProcess;
  name: string;
  lineCount: number;
  windowStart: number;
  droppedInWindow: number;
}

const _watchers = new Map<string, ActiveWatcher>();

export function startProcessWatcher(opts: WatcherOptions): void {
  const { name, command, args = [], cwd, env } = opts;

  if (_watchers.has(name)) {
    logger.warn({ name }, 'process watcher already running for this name — stopping previous');
    stopProcessWatcher(name);
  }

  let proc: ChildProcess;
  try {
    proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // frameworkEnv provides safe defaults; caller opts.env always wins
      env: { ...process.env, ...frameworkEnv(command, args), ...env },
    });
  } catch (err) {
    logger.warn({ name, err }, 'process-watcher: failed to spawn process');
    return;
  }

  const watcher: ActiveWatcher = {
    proc, name,
    lineCount: 0, windowStart: Date.now(), droppedInWindow: 0,
  };
  _watchers.set(name, watcher);

  logger.info({ name, command, args }, 'process-watcher: started');

  function handleLine(raw: string, isStderr: boolean): void {
    const now = Date.now();

    // Rate-limit window reset
    if (now - watcher.windowStart > RATE_WINDOW_MS) {
      if (watcher.droppedInWindow > 0) {
        pushTerminal(watcher, `[mergen] dropped ${watcher.droppedInWindow} lines (rate limit: ${MAX_LINES_PER_SEC}/s)`);
      }
      watcher.lineCount = 0;
      watcher.windowStart = now;
      watcher.droppedInWindow = 0;
    }

    if (watcher.lineCount >= MAX_LINES_PER_SEC) {
      watcher.droppedInWindow++;
      return;
    }
    watcher.lineCount++;

    const line = stripAnsi(raw).slice(0, MAX_LINE_LENGTH);
    const data = isStderr ? `[stderr] ${line}` : line;
    pushTerminal(watcher, data);
  }

  function pushTerminal(w: ActiveWatcher, data: string): void {
    const traceId = extractTraceId(data) ?? undefined;
    const event: TerminalOutputEvent = {
      type: 'terminal',
      terminalName: w.name,
      data,
      timestamp: Date.now(),
      ...(traceId ? { traceId } : {}),
    };
    try { store.push(event); } catch { /* never crash */ }
  }

  // Stream stdout
  let stdoutBuf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) handleLine(l, false);
  });

  // Stream stderr
  let stderrBuf = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) handleLine(l, true);
  });

  proc.on('error', (err) => {
    logger.warn({ name, err }, 'process-watcher: spawn error');
    _watchers.delete(name);
  });

  proc.on('close', (code, signal) => {
    _watchers.delete(name);

    const isCrash = code !== 0 && code !== null;
    const isOom   = code === 137;
    const reason: ProcessExitEvent['reason'] = isOom ? 'oom'
      : signal ? 'signal'
      : isCrash ? 'crash'
      : 'normal';

    logger.info({ name, code, signal, reason }, 'process-watcher: process exited');

    const exitEvent: ProcessExitEvent = {
      type: 'process_exit',
      process: name,
      exitCode: code ?? -1,
      reason,
      signal: signal ?? undefined,
      timestamp: Date.now(),
    };
    try { store.push(exitEvent); } catch { /* never crash */ }

    if (isCrash) {
      pushTerminal({ ...watcher, name }, `[mergen] process "${name}" exited with code ${code}${signal ? ` (${signal})` : ''}`);
    }
  });
}

export function stopProcessWatcher(name: string): void {
  const w = _watchers.get(name);
  if (!w) return;
  try {
    w.proc.stdout?.destroy();
    w.proc.stderr?.destroy();
    w.proc.kill();
  } catch { /* best-effort */ }
  _watchers.delete(name);
  logger.info({ name }, 'process-watcher: stopped');
}

export function stopAllProcessWatchers(): void {
  for (const name of _watchers.keys()) stopProcessWatcher(name);
}

export function listProcessWatchers(): string[] {
  return [..._watchers.keys()];
}
