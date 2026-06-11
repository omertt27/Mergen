/**
 * habituation-store.ts — Tracks weekly unprompted engineer engagement with Mergen.
 *
 * "Organic Habituation" metric: after Mergen posts a comment on a PR,
 * what fraction of those engineers engage (submit a review, etc.) that same week?
 * A rising habituationRate signals Mergen is becoming part of the workflow.
 *
 * Persisted as a JSON ring buffer (cap: 1000) under ~/.mergen/habituation.json.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, zeroRetentionMode } from './paths.js';
import logger from './logger.js';

const HABITUATION_FILE = path.join(DATA_DIR, 'habituation.json');
const MAX_EVENTS = 1000;

export type HabituationEventType = 'comment_posted' | 'pr_review_submitted';

export interface HabituationEvent {
  recordedAt: number;
  eventType: HabituationEventType;
  actor: string;
  repo: string;
  prNumber: number;
  relevanceScore?: number;
}

interface HabituationFile { version: 1; events: HabituationEvent[]; }

let _events: HabituationEvent[] = [];
let _loaded = false;

function load(): void {
  if (_loaded) return;
  _loaded = true;
  if (!fs.existsSync(HABITUATION_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(HABITUATION_FILE, 'utf8')) as HabituationFile;
    if (parsed?.version === 1 && Array.isArray(parsed.events)) _events = parsed.events;
  } catch {}
}

function persist(): void {
  if (zeroRetentionMode()) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${HABITUATION_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, events: _events } satisfies HabituationFile), 'utf8');
    fs.renameSync(tmp, HABITUATION_FILE);
  } catch (err) {
    logger.warn({ err }, 'habituation-store: persist failed');
  }
}

function isoWeekKey(ts: number): string {
  const d = new Date(ts);
  // ISO week: week containing the first Thursday of the year is week 1.
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - (d.getDay() + 6) % 7 + 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week = 1 + Math.round((thursday.getTime() - jan4.getTime()) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function recordHabituationEvent(event: HabituationEvent): void {
  load();
  _events.push(event);
  if (_events.length > MAX_EVENTS) _events = _events.slice(-MAX_EVENTS);
  persist();
}

export function getHabituationEvents(): HabituationEvent[] {
  load();
  return [..._events];
}

export interface WeeklyHabituation {
  week: string;
  engineersWithComments: number;
  engineersEngaged: number;
  engagementRate: number;
  commentsPosted: number;
}

export function getWeeklyHabituation(windowWeeks = 8): WeeklyHabituation[] {
  load();
  const cutoff = Date.now() - windowWeeks * 7 * 24 * 60 * 60 * 1000;
  const recent = _events.filter((e) => e.recordedAt >= cutoff);

  const byWeek = new Map<string, { commented: Set<string>; engaged: Set<string>; count: number }>();
  for (const e of recent) {
    const wk = isoWeekKey(e.recordedAt);
    if (!byWeek.has(wk)) byWeek.set(wk, { commented: new Set(), engaged: new Set(), count: 0 });
    const w = byWeek.get(wk)!;
    if (e.eventType === 'comment_posted') { w.commented.add(e.actor); w.count++; }
    else                                   { w.engaged.add(e.actor); }
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, w]) => ({
      week,
      engineersWithComments: w.commented.size,
      engineersEngaged:      w.engaged.size,
      engagementRate:        w.commented.size > 0 ? w.engaged.size / w.commented.size : 0,
      commentsPosted:        w.count,
    }));
}
