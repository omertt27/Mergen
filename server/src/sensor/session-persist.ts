import fs from 'fs';
import { SESSION_FILE, DATA_DIR } from './paths.js';
import type { BrowserEvent } from './buffer.js';
import logger from './logger.js';

const SCHEMA_VERSION = 1;
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // discard sessions older than 8 h

interface SessionFile {
  v: number;
  savedAt: number;
  events: BrowserEvent[];
}

export function saveSession(events: BrowserEvent[]): void {
  if (events.length === 0) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload: SessionFile = { v: SCHEMA_VERSION, savedAt: Date.now(), events };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(payload), 'utf8');
    logger.info({ count: events.length }, 'session persisted to disk');
  } catch (err) {
    logger.warn({ err }, 'session persist failed — buffer will be lost on restart');
  }
}

export function loadSession(): BrowserEvent[] | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const parsed = JSON.parse(raw) as SessionFile;
    if (parsed.v !== SCHEMA_VERSION) return null;
    const age = Date.now() - parsed.savedAt;
    if (age > SESSION_MAX_AGE_MS) {
      fs.unlinkSync(SESSION_FILE);
      logger.info({ ageMs: age }, 'stale session discarded');
      return null;
    }
    return parsed.events;
  } catch (err) {
    logger.warn({ err }, 'session load failed');
    return null;
  }
}
