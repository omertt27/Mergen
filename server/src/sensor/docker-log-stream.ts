/**
 * docker-log-stream.ts — Stream running container logs into the buffer.
 *
 * Extends docker-monitor.ts (which handles OOM kills) with continuous
 * log streaming so the causal engine can correlate browser errors with
 * backend container output.
 *
 * Activation: set MERGEN_DOCKER_LOGS=true (opt-in, not default).
 *
 * Design:
 *   1. On startup: enumerate running containers via `docker ps --format json`.
 *   2. For each container: spawn `docker logs --follow --tail 50 <id>` and
 *      pipe each line into the buffer as a terminal event with
 *      terminalName = "docker:<container-name>".
 *   3. Subscribe to `docker events` to pick up containers that start AFTER
 *      Mergen does, and stop streaming when they die.
 *   4. All errors are best-effort — broken streams never crash the server.
 *
 * Rate limiting: shared with process-watcher — max 30 lines/sec per container.
 */

import { spawn } from 'child_process';
import { store } from './buffer.js';
import type { TerminalOutputEvent } from './buffer.js';
import logger from './logger.js';

const MAX_LINES_PER_SEC = 30;
const RATE_WINDOW_MS    = 1_000;
const MAX_LINE_LENGTH   = 2_000;
const TAIL_LINES        = 50;

interface ContainerStream {
  id: string;
  name: string;
  kill: () => void;
  lineCount: number;
  windowStart: number;
}

const _streams = new Map<string, ContainerStream>();
let _eventProc: ReturnType<typeof spawn> | null = null;
let _active = false;

function pushLine(stream: ContainerStream, raw: string): void {
  const now = Date.now();
  if (now - stream.windowStart > RATE_WINDOW_MS) {
    stream.lineCount  = 0;
    stream.windowStart = now;
  }
  if (stream.lineCount >= MAX_LINES_PER_SEC) return;
  stream.lineCount++;

  const event: TerminalOutputEvent = {
    type: 'terminal',
    terminalName: `docker:${stream.name}`,
    data: raw.slice(0, MAX_LINE_LENGTH),
    timestamp: Date.now(),
  };
  try { store.push(event); } catch { /* never crash */ }
}

function streamContainer(id: string, name: string): void {
  if (_streams.has(id)) return;

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn('docker', ['logs', '--follow', `--tail=${TAIL_LINES}`, id], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return;
  }

  const stream: ContainerStream = {
    id, name, kill: () => { try { proc.kill(); } catch {} },
    lineCount: 0, windowStart: Date.now(),
  };
  _streams.set(id, stream);

  function handleChunk(chunk: Buffer, prefix: string): void {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = (prefix ? `[${prefix}] ` : '') + line.trim();
      if (trimmed) pushLine(stream, trimmed);
    }
  }

  if (proc.stdout) proc.stdout.on('data', (c: Buffer) => handleChunk(c, ''));
  if (proc.stderr) proc.stderr.on('data', (c: Buffer) => handleChunk(c, 'stderr'));

  proc.on('close', () => { _streams.delete(id); });
  proc.on('error', () => { _streams.delete(id); });

  logger.info({ containerId: id.slice(0, 12), name }, 'docker-log-stream: streaming');
}

async function enumerateContainers(): Promise<void> {
  return new Promise((resolve) => {
    let out = '';
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('docker', ['ps', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve(); return; }

    if (proc.stdout) proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });

    proc.on('close', () => {
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as { ID?: string; Names?: string };
          const id   = obj.ID ?? '';
          const name = (obj.Names ?? obj.ID ?? 'unknown').replace(/^\//, '');
          if (id) streamContainer(id, name);
        } catch { /* malformed JSON */ }
      }
      resolve();
    });

    proc.on('error', () => resolve());
  });
}

function subscribeToDockerEvents(): void {
  try {
    _eventProc = spawn(
      'docker',
      ['events', '--filter', 'type=container', '--filter', 'event=start', '--filter', 'event=die', '--format', '{{json .}}'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch { return; }

  if (!_eventProc.stdout) return;

  let buf = '';
  _eventProc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as { Action?: string; Actor?: { ID?: string; Attributes?: Record<string, string> } };
        const id   = ev.Actor?.ID ?? '';
        const name = ev.Actor?.Attributes?.name ?? id.slice(0, 12);
        if (ev.Action === 'start' && id) {
          streamContainer(id, name);
        } else if (ev.Action === 'die' && id) {
          _streams.get(id)?.kill();
          _streams.delete(id);
        }
      } catch { /* malformed */ }
    }
  });

  _eventProc.on('error', () => { _eventProc = null; });
  _eventProc.on('exit',  () => { _eventProc = null; });
}

export async function startDockerLogStream(): Promise<void> {
  if (_active) return;
  _active = true;

  await enumerateContainers();
  subscribeToDockerEvents();

  logger.info({ containers: _streams.size }, 'docker-log-stream: started');
}

export function stopDockerLogStream(): void {
  _active = false;
  for (const s of _streams.values()) s.kill();
  _streams.clear();
  try { _eventProc?.kill(); } catch {}
  _eventProc = null;
}

export function listStreamedContainers(): string[] {
  return [..._streams.values()].map((s) => `${s.name} (${s.id.slice(0, 12)})`);
}
