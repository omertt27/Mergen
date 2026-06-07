/**
 * override-corpus.ts — Team-specific override knowledge graph.
 *
 * Every time an engineer decides NOT to apply Mergen's recommendation, they
 * call POST /overrides with a categorical reason. This module stores those
 * events and answers one question before autonomous execution:
 *
 *   "Has this action been overridden for this service in this time window before?"
 *
 * If yes, autopilot pauses and notifies Slack. The corpus is consulted before
 * execution, so a pattern like "never auto-resize the DB pool on Friday
 * evenings" emerges from real incidents — without any explicit configuration.
 *
 * Why categorical reasons matter:
 *   Free-text notes are unsearchable. A typed enum makes the corpus queryable:
 *   you can ask "how many batch-window overrides happened for this service?"
 *   and get a meaningful answer. After 12 months of real data, this corpus is
 *   essentially non-portable — it is the team's operational knowledge in
 *   structured form.
 *
 * Storage: ~/.mergen/override-corpus.json (bounded ring, 2000 events)
 * Privacy: no stack traces, no URLs, no error messages stored — only tags,
 *   service names, categorical reasons, and command strings (clamped).
 */

import fs from 'fs';
import { randomUUID } from 'crypto';
import { OVERRIDE_CORPUS_FILE, DATA_DIR } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type OverrideReason =
  | 'batch-window'         // team runs batch jobs that make the action unsafe at this time
  | 'cost-constraint'      // action would exceed budget ceiling (resize, scale-up)
  | 'on-call-discretion'   // on-call had context Mergen did not have
  | 'compliance-hold'      // change requires CAB approval or change freeze
  | 'prefer-read-replica'  // team policy to use replica; Mergen proposed primary fix
  | 'maintenance-window'   // system already scheduled for maintenance
  | 'wrong-diagnosis'      // root cause was misidentified
  | 'wrong-fix'            // root cause correct but proposed fix was wrong
  | 'other';               // free-text note required when this is chosen

/** Runtime array of all valid override reasons — used for Zod enum validation in routes. */
export const OVERRIDE_REASONS: OverrideReason[] = [
  'batch-window',
  'cost-constraint',
  'on-call-discretion',
  'compliance-hold',
  'prefer-read-replica',
  'maintenance-window',
  'wrong-diagnosis',
  'wrong-fix',
  'other',
];

export type OverrideOutcome = 'resolved' | 'escalated' | 'unresolved';

export interface OverrideEvent {
  id: string;
  incidentTag: string;
  /** Clamped to 500 chars to keep the file size bounded. */
  proposedCommand: string;
  overrideReason: OverrideReason;
  /** Required when reason is 'other'. Optional context otherwise. Clamped to 200 chars. */
  note?: string;
  service: string;
  environment: string;
  /** 0=Sunday … 6=Saturday, captured at record time in UTC. */
  dayOfWeek: number;
  /** 0–23 UTC, captured at record time. */
  hourOfDay: number;
  /** What the engineer actually did instead. Clamped to 500 chars. */
  manualAction?: string;
  outcome?: OverrideOutcome;
  recordedAt: number;
  actor: string;
}

interface CorpusFile {
  version: 1;
  events: OverrideEvent[];
}

// ── Storage ──────────────────────────────────────────────────────────────────

const MAX_EVENTS = 2_000;

let _events: OverrideEvent[] = [];
let _loaded = false;

function load(): void {
  if (_loaded) return;
  if (!fs.existsSync(OVERRIDE_CORPUS_FILE)) { _loaded = true; return; }
  try {
    const raw = fs.readFileSync(OVERRIDE_CORPUS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as CorpusFile;
    if (parsed?.version === 1 && Array.isArray(parsed.events)) {
      _events = parsed.events.slice(-MAX_EVENTS);
    }
    _loaded = true;
  } catch (err) {
    logger.warn({ err }, 'override-corpus: failed to load — starting fresh');
    _events = [];
    _loaded = true;
  }
}

let _tmpCounter = 0;

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload: CorpusFile = { version: 1, events: _events };
    _tmpCounter = (_tmpCounter + 1) >>> 0;
    const tmp = `${OVERRIDE_CORPUS_FILE}.tmp.${process.pid}.${Date.now().toString(36)}.${_tmpCounter.toString(36)}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, OVERRIDE_CORPUS_FILE);
  } catch (err) {
    logger.warn({ err }, 'override-corpus: failed to persist');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Record an engineer override. Returns the saved event with its assigned id. */
export function recordOverride(input: Omit<OverrideEvent, 'id' | 'dayOfWeek' | 'hourOfDay' | 'recordedAt'>): OverrideEvent {
  load();
  const now = new Date();
  const event: OverrideEvent = {
    ...input,
    id: randomUUID(),
    proposedCommand: input.proposedCommand.slice(0, 500),
    note: input.note?.slice(0, 200),
    manualAction: input.manualAction?.slice(0, 500),
    dayOfWeek: now.getUTCDay(),
    hourOfDay: now.getUTCHours(),
    recordedAt: now.getTime(),
  };
  _events.push(event);
  if (_events.length > MAX_EVENTS) _events = _events.slice(-MAX_EVENTS);
  persist();
  logger.info({ id: event.id, tag: event.incidentTag, reason: event.overrideReason, service: event.service }, 'override-corpus: override recorded');
  return event;
}

/** Update the outcome of a previously recorded override. */
export function updateOutcome(id: string, outcome: OverrideOutcome): boolean {
  load();
  const ev = _events.find((e) => e.id === id);
  if (!ev) return false;
  ev.outcome = outcome;
  persist();
  return true;
}

/**
 * Returns true if this (tag, service) combination has been overridden in a
 * matching time window within the last 90 days.
 *
 * Time matching: same day-of-week ± 1 hour. This captures recurring patterns
 * ("Friday evening batch window") without requiring exact time matching.
 */
export function hasRecentOverride(
  incidentTag: string,
  service: string,
  dayOfWeek: number,
  hourOfDay: number,
): boolean {
  load();
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  return _events.some((e) => {
    if (e.incidentTag !== incidentTag) return false;
    if (e.service !== service) return false;
    if (e.recordedAt < cutoff) return false;
    if (e.dayOfWeek !== dayOfWeek) return false;
    const hourDiff = Math.abs(e.hourOfDay - hourOfDay);
    return hourDiff <= 1 || hourDiff >= 23; // handles midnight wrap-around
  });
}

/** Returns the most frequently cited override reason for this tag+service pair. */
export function dominantOverrideReason(
  incidentTag: string,
  service: string,
): OverrideReason | null {
  load();
  const counts = new Map<OverrideReason, number>();
  for (const e of _events) {
    if (e.incidentTag !== incidentTag || e.service !== service) continue;
    counts.set(e.overrideReason, (counts.get(e.overrideReason) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: OverrideReason | null = null;
  let bestCount = 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) { best = reason; bestCount = count; }
  }
  return best;
}

/** Raw override history for a specific detector tag. */
export function getOverridesForTag(tag: string): OverrideEvent[] {
  load();
  return _events.filter((e) => e.incidentTag === tag);
}

/** Look up a single override by its id. */
export function getOverrideById(id: string): OverrideEvent | null {
  load();
  return _events.find((e) => e.id === id) ?? null;
}

/** All override events (read-only snapshot). */
export function getAllOverrides(): readonly OverrideEvent[] {
  load();
  return _events;
}

/**
 * Aggregated summary per detector tag — used by GET /override-corpus.
 * Returns each tag that has at least one override, with counts, dominant
 * reason, time-of-week heat, and outcome breakdown.
 */
export interface OverrideSummary {
  tag: string;
  total: number;
  dominantReason: OverrideReason | null;
  services: string[];
  /** Rough description of when overrides cluster, e.g. "Friday 20–22 UTC". */
  timePattern: string | null;
  outcomes: { resolved: number; escalated: number; unresolved: number; unknown: number };
}

export function getOverrideSummary(): OverrideSummary[] {
  load();
  const byTag = new Map<string, OverrideEvent[]>();
  for (const e of _events) {
    const list = byTag.get(e.incidentTag) ?? [];
    list.push(e);
    byTag.set(e.incidentTag, list);
  }

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const out: OverrideSummary[] = [];
  for (const [tag, events] of byTag) {
    const reasonCounts = new Map<OverrideReason, number>();
    const services = new Set<string>();
    const dayCounts = new Map<number, number>();
    const outcomes = { resolved: 0, escalated: 0, unresolved: 0, unknown: 0 };

    for (const e of events) {
      reasonCounts.set(e.overrideReason, (reasonCounts.get(e.overrideReason) ?? 0) + 1);
      services.add(e.service);
      dayCounts.set(e.dayOfWeek, (dayCounts.get(e.dayOfWeek) ?? 0) + 1);
      if (e.outcome) outcomes[e.outcome]++;
      else outcomes.unknown++;
    }

    let dominant: OverrideReason | null = null;
    let bestCount = 0;
    for (const [r, c] of reasonCounts) {
      if (c > bestCount) { dominant = r; bestCount = c; }
    }

    // Find the most common day-of-week to describe the time pattern
    let dominantDay: number | null = null;
    let dominantDayCount = 0;
    for (const [day, count] of dayCounts) {
      if (count > dominantDayCount) { dominantDay = day; dominantDayCount = count; }
    }

    let timePattern: string | null = null;
    if (dominantDay !== null && dominantDayCount / events.length >= 0.4) {
      // At least 40% of overrides cluster on one day — worth surfacing
      const hoursOnDay = events
        .filter((e) => e.dayOfWeek === dominantDay)
        .map((e) => e.hourOfDay);
      const minHour = Math.min(...hoursOnDay);
      const maxHour = Math.max(...hoursOnDay);
      timePattern = maxHour > minHour
        ? `${DAY_NAMES[dominantDay]} ${minHour}–${maxHour} UTC`
        : `${DAY_NAMES[dominantDay]} ${minHour} UTC`;
    }

    out.push({
      tag,
      total: events.length,
      dominantReason: dominant,
      services: [...services],
      timePattern,
      outcomes,
    });
  }

  out.sort((a, b) => b.total - a.total);
  return out;
}
