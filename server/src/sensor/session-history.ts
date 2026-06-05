/**
 * session-history.ts — Multi-session archive for replay and historical queries.
 *
 * Each time the buffer is cleared or the server shuts down, the current events
 * are written to ~/.mergen/sessions/<ISO-timestamp>-<label>.json.
 * Capped at MAX_SESSIONS files (oldest evicted). Enables the query:
 *   "What errors were happening yesterday at 3pm?"
 */

import fs from 'fs';
import path from 'path';
import { SESSIONS_DIR } from './paths.js';
import type { BrowserEvent } from './buffer.js';
import logger from './logger.js';

const SCHEMA_VERSION = 1;
const MAX_SESSIONS   = 30;

interface SessionHistoryFile {
  v: number;
  savedAt: number;
  label: string;
  eventCount: number;
  events: BrowserEvent[];
}

export interface SessionMeta {
  id: string;
  savedAt: number;
  eventCount: number;
  label: string;
  filename: string;
}

function ensureDir(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function toSafeFilename(ts: number, label: string): string {
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
  return `${new Date(ts).toISOString().replace(/[:.]/g, '-')}-${safe}.json`;
}

export function saveSessionToHistory(events: BrowserEvent[], label = 'session'): void {
  if (events.length === 0) return;
  try {
    ensureDir();
    const ts       = Date.now();
    const filename = toSafeFilename(ts, label);
    const payload: SessionHistoryFile = { v: SCHEMA_VERSION, savedAt: ts, label, eventCount: events.length, events };
    fs.writeFileSync(path.join(SESSIONS_DIR, filename), JSON.stringify(payload), 'utf8');
    pruneOldSessions();
    logger.info({ count: events.length, filename }, 'session saved to history');
  } catch (err) {
    logger.warn({ err }, 'session history save failed');
  }
}

function listFiles(): string[] {
  try {
    ensureDir();
    return fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

function pruneOldSessions(): void {
  const files = listFiles();
  if (files.length <= MAX_SESSIONS) return;
  for (const f of files.slice(0, files.length - MAX_SESSIONS)) {
    try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch { /* ignore */ }
  }
}

export function listSessionMetas(): SessionMeta[] {
  return listFiles().map(filename => {
    try {
      const raw    = fs.readFileSync(path.join(SESSIONS_DIR, filename), 'utf8');
      const parsed = JSON.parse(raw) as SessionHistoryFile;
      return { id: filename.replace('.json', ''), savedAt: parsed.savedAt, eventCount: parsed.eventCount, label: parsed.label, filename };
    } catch {
      return null;
    }
  }).filter((m): m is SessionMeta => m !== null).reverse(); // newest first
}

export function loadSessionsByTimeRange(since: number, until: number): BrowserEvent[] {
  const metas = listSessionMetas().filter(m => m.savedAt >= since && m.savedAt <= until);
  const all: BrowserEvent[] = [];
  for (const meta of metas) {
    try {
      const raw    = fs.readFileSync(path.join(SESSIONS_DIR, meta.filename), 'utf8');
      const parsed = JSON.parse(raw) as SessionHistoryFile;
      if (parsed.v === SCHEMA_VERSION) all.push(...parsed.events);
    } catch { /* skip corrupt files */ }
  }
  return all.sort((a, b) => a.timestamp - b.timestamp);
}
