/**
 * agent-blunder-store.ts — Persistent log of every action Mergen blocked.
 *
 * Each entry is a "near-miss" — an autonomous action that the safety layer
 * intercepted. These are the raw events behind the Agent Blunder Log metric:
 * "Mergen prevented X potentially harmful actions this quarter."
 *
 * Persisted as a JSON ring buffer (cap: 500) under ~/.mergen/agent-blunders.json.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR, zeroRetentionMode } from './paths.js';
import logger from './logger.js';

const BLUNDER_FILE = path.join(DATA_DIR, 'agent-blunders.json');
const MAX_BLUNDERS = 500;

export type BlunderType =
  | 'allowlist_block'    // command not on the allowlist
  | 'injection_attempt'  // injection pattern detected in command
  | 'rbac_block'         // actor missing required role
  | 'override_corpus_block' // execution blocked by override corpus history
  | 'pipeline_block'     // governance pipeline blocked (non-corpus reason)
  | 'planning_gate_block'; // planning gate confidence/blast-radius check failed

export interface BlunderEvent {
  id: string;
  recordedAt: number;
  blunderType: BlunderType;
  command: string | null;
  blockReason: string;
  service: string | null;
  tag: string | null;
  actor: string | null;
  pid: string | null;
  confidenceScore: number | null;
}

interface BlunderFile { version: 1; blunders: BlunderEvent[]; }

let _blunders: BlunderEvent[] = [];
let _loaded = false;

function load(): void {
  if (_loaded) return;
  _loaded = true;
  if (!fs.existsSync(BLUNDER_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(BLUNDER_FILE, 'utf8')) as BlunderFile;
    if (parsed?.version === 1 && Array.isArray(parsed.blunders)) _blunders = parsed.blunders;
  } catch {}
}

function persist(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${BLUNDER_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, blunders: _blunders } satisfies BlunderFile), 'utf8');
    fs.renameSync(tmp, BLUNDER_FILE);
  } catch (err) {
    logger.warn({ err }, 'agent-blunder-store: persist failed');
  }
}

export function recordBlunder(event: Omit<BlunderEvent, 'id' | 'recordedAt'>): void {
  load();
  _blunders.push({ id: randomUUID(), recordedAt: Date.now(), ...event });
  if (_blunders.length > MAX_BLUNDERS) _blunders = _blunders.slice(-MAX_BLUNDERS);
  persist();
  logger.info(
    { blunderType: event.blunderType, cmd: event.command?.slice(0, 80), service: event.service },
    'agent-blunder: intercepted',
  );
}

export function getBlunders(): BlunderEvent[] {
  load();
  return [..._blunders];
}

export function getBlunderStats(): {
  total: number;
  byType: Record<string, number>;
  last7Days: number;
  last30Days: number;
} {
  load();
  const now = Date.now();
  const ms7  = 7  * 24 * 60 * 60 * 1000;
  const ms30 = 30 * 24 * 60 * 60 * 1000;
  const byType: Record<string, number> = {};
  let last7Days = 0, last30Days = 0;
  for (const b of _blunders) {
    byType[b.blunderType] = (byType[b.blunderType] ?? 0) + 1;
    if (b.recordedAt >= now - ms7)  last7Days++;
    if (b.recordedAt >= now - ms30) last30Days++;
  }
  return { total: _blunders.length, byType, last7Days, last30Days };
}
