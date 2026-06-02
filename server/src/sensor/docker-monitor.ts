/**
 * docker-monitor.ts — Local container observability.
 *
 * Monitors two failure modes that leave no application-level logs:
 *
 *   1. Docker OOM kills (exit code 137 = 128 + SIGKILL).
 *      Streams `docker events --filter event=oom` and pushes a
 *      process_exit event to the buffer so the causal engine can explain
 *      sudden container crashes.
 *
 *   2. V8 heap vs container memory limit.
 *      Reads /sys/fs/cgroup/memory.limit_in_bytes (cgroups v1) or
 *      /sys/fs/cgroup/memory.max (cgroups v2) and compares it to
 *      process.memoryUsage().heapTotal. Warns when the heap is within
 *      40 MB of the container ceiling — before the Linux OOM killer fires.
 *
 * Both features are best-effort: errors are logged but never thrown.
 * If Docker is not installed or the process is not in a container, this
 * module does nothing.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import type { ProcessExitEvent } from './buffer.js';
import { store } from './buffer.js';
import logger from './logger.js';

const HEAP_CHECK_INTERVAL_MS = 30_000;
const HEAP_WARN_MARGIN_BYTES = 40 * 1024 * 1024;

function readCgroupMemoryLimit(): number | null {
  try {
    const v2 = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (v2 !== 'max') return parseInt(v2, 10);
  } catch {
    // not cgroups v2
  }

  try {
    const v1 = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
    const limit = parseInt(v1, 10);
    if (limit > 0 && limit < 9e18) return limit;
  } catch {
    // not cgroups v1
  }

  return null;
}

let _heapTimer: ReturnType<typeof setInterval> | null = null;
let _lastHeapWarnAt = 0;

export function startHeapMonitor(): void {
  if (_heapTimer) return;

  const limit = readCgroupMemoryLimit();
  if (!limit) return;

  const limitMb = Math.round(limit / 1024 / 1024);
  logger.info({ limitMb }, 'container memory limit detected — starting heap monitor');

  _heapTimer = setInterval(() => {
    const { rss } = process.memoryUsage();
    const headroom = limit - rss;

    if (headroom < HEAP_WARN_MARGIN_BYTES) {
      const now = Date.now();
      if (now - _lastHeapWarnAt < 5 * 60_000) return;
      _lastHeapWarnAt = now;

      const rssMb = Math.round(rss / 1024 / 1024);
      const headroomMb = Math.round(headroom / 1024 / 1024);
      logger.warn({ rssMb, limitMb, headroomMb }, 'heap approaching container memory limit — OOM risk');

      const event: ProcessExitEvent = {
        type: 'process_exit',
        process: 'current-process',
        exitCode: -1,
        reason: 'oom',
        memoryLimitBytes: limit,
        timestamp: now,
      };
      store.push(event);
    }
  }, HEAP_CHECK_INTERVAL_MS);

  if (typeof _heapTimer.unref === 'function') _heapTimer.unref();
}

export function stopHeapMonitor(): void {
  if (_heapTimer) {
    clearInterval(_heapTimer);
    _heapTimer = null;
  }
}

let _dockerProc: ReturnType<typeof spawn> | null = null;

export function startDockerMonitor(): void {
  if (_dockerProc) return;

  try {
    _dockerProc = spawn(
      'docker',
      ['events', '--filter', 'event=oom', '--filter', 'event=die', '--format', '{{json .}}'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return;
  }

  if (!_dockerProc.stdout) return;

  let buffer = '';
  _dockerProc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as {
          Action?: string;
          Actor?: { ID?: string; Attributes?: Record<string, string> };
          time?: number;
        };

        if (ev.Action === 'oom' || (ev.Action === 'die' && ev.Actor?.Attributes?.exitCode === '137')) {
          const containerName = ev.Actor?.Attributes?.name ?? ev.Actor?.ID?.slice(0, 12) ?? 'unknown';

          logger.warn({ containerName, action: ev.Action }, 'Docker OOM kill detected');

          const event: ProcessExitEvent = {
            type: 'process_exit',
            process: containerName,
            exitCode: 137,
            reason: 'oom',
            signal: 'SIGKILL',
            timestamp: (ev.time ?? Date.now() / 1000) * 1000,
          };
          store.push(event);
        }
      } catch {
        // malformed JSON from docker events
      }
    }
  });

  _dockerProc.on('error', () => {
    _dockerProc = null;
  });

  _dockerProc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      logger.debug({ code }, 'docker events process exited');
    }
    _dockerProc = null;
  });

  logger.info('Docker OOM monitor started');
}

export function stopDockerMonitor(): void {
  if (_dockerProc) {
    // Destroy the readable stream before killing so no buffered data events
    // fire after the process is gone and cause noisy pipe errors on exit.
    _dockerProc.stdout?.destroy();
    _dockerProc.kill();
    _dockerProc = null;
  }
  stopHeapMonitor();
}
