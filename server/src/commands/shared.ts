/**
 * commands/shared.ts — shared helpers + path anchors for the mergen CLI.
 *
 * SERVER_ENTRY resolves the compiled server entry (dist/index.js) relative to
 * THIS module's location so command modules under commands/ resolve it the same
 * way the old cli.ts did via __dirname — the reason this constant exists.
 */
import { createInterface } from 'readline';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SERVER_ENTRY = resolve(__dirname, '../index.js');
const _pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };
export const VERSION = _pkg.version;

export function log(msg: string, icon = 'ℹ'): void {
  console.log(`${icon} ${msg}`);
}

export function success(msg: string): void {
  console.log(`✓ ${msg}`);
}

export function error(msg: string): void {
  console.error(`✗ ${msg}`);
}

export function hr(): void {
  console.log('─'.repeat(60));
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function maybeFlushOfflineBlunders(port: number): Promise<void> {
  const { existsSync, readFileSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const file = join(homedir(), '.mergen', 'offline-blunders.jsonl');
  if (!existsSync(file)) return;

  let secret = '';
  const secretPath = join(homedir(), '.mergen', 'secret');
  if (existsSync(secretPath)) {
    try { secret = readFileSync(secretPath, 'utf8').trim(); } catch {}
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['x-mergen-secret'] = secret;

  let lines: string[];
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return;
  }

  const remaining: string[] = [];
  for (const line of lines) {
    try {
      const blunder = JSON.parse(line);
      const resp = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: 'POST',
        headers,
        body: JSON.stringify(blunder),
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) {
        remaining.push(line);
      }
    } catch {
      remaining.push(line);
    }
  }

  try {
    if (remaining.length > 0) {
      writeFileSync(file, remaining.join('\n') + '\n', 'utf8');
    } else {
      const { unlinkSync } = await import('fs');
      unlinkSync(file);
    }
  } catch {}
}

export async function findPort(): Promise<number | null> {
  for (let p = 3000; p <= 3010; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(300) });
      if (r.ok) {
        maybeFlushOfflineBlunders(p).catch(() => {});
        return p;
      }
    } catch {}
  }
  return null;
}
