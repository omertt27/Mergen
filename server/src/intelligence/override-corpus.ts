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
import { lockAndExecute } from '../sensor/file-lock.js';
import path from 'path';
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
// 2000ms TTL: long enough to collapse repeated reads within a single autopilot
// run (which issues several corpus lookups per incident in rapid succession)
// without serving stale data to the next distinct incident.
// Write operations (recordOverride, updateOutcome) always force-reload inside
// the file lock, so in-memory state stays consistent with the file on writes.
const READ_CACHE_TTL_MS = 2_000;
let _lastForcedLoadAt = 0;

// ── Compaction cache (dirty flag) ─────────────────────────────────────────────
// compactCorpus() is O(n) over _events. We memoize the result and only
// recompute when _events has changed. This makes getRulesForTag() O(1) for
// repeated calls within the same autopilot run.
let _compactedRules: CompactedRule[] | null = null;
let _corpusDirty = true; // starts dirty so the first call always computes

function load(force = false): void {
  if (_loaded && !force) return;
  if (!fs.existsSync(OVERRIDE_CORPUS_FILE)) { _events = []; _loaded = true; return; }
  try {
    const raw = fs.readFileSync(OVERRIDE_CORPUS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as CorpusFile;
    if (parsed?.version === 1 && Array.isArray(parsed.events)) {
      _events = parsed.events.slice(-MAX_EVENTS);
    } else {
      _events = [];
    }
    _loaded = true;
    _lastForcedLoadAt = Date.now();
  } catch (err) {
    logger.warn({ err }, 'override-corpus: failed to load — starting fresh');
    _events = [];
    _loaded = true;
  }
}

/** Load for read paths: re-read from disk at most once per READ_CACHE_TTL_MS. */
function loadForRead(): void {
  if (!_loaded || Date.now() - _lastForcedLoadAt > READ_CACHE_TTL_MS) {
    load(true);
  }
}

let _tmpCounter = 0;

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(OVERRIDE_CORPUS_FILE), { recursive: true });
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

  return lockAndExecute(`${OVERRIDE_CORPUS_FILE}.lock`, () => {
    load(true);
    _events.push(event);
    if (_events.length > MAX_EVENTS) _events = _events.slice(-MAX_EVENTS);
    _corpusDirty = true;
    persist();
    logger.info({ id: event.id, tag: event.incidentTag, reason: event.overrideReason, service: event.service }, 'override-corpus: override recorded');
    return event;
  });
}

/** Update the outcome of a previously recorded override. */
export function updateOutcome(id: string, outcome: OverrideOutcome): boolean {
  return lockAndExecute(`${OVERRIDE_CORPUS_FILE}.lock`, () => {
    load(true);
    const ev = _events.find((e) => e.id === id);
    if (!ev) return false;
    ev.outcome = outcome;
    _corpusDirty = true;
    persist();
    return true;
  });
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
  loadForRead();
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
  loadForRead();
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
  loadForRead();
  return _events.filter((e) => e.incidentTag === tag);
}

/** Look up a single override by its id. */
export function getOverrideById(id: string): OverrideEvent | null {
  loadForRead();
  return _events.find((e) => e.id === id) ?? null;
}

/** All override events (read-only snapshot). */
export function getAllOverrides(): readonly OverrideEvent[] {
  loadForRead();
  return _events;
}

// ── Corpus compaction ─────────────────────────────────────────────────────────

/**
 * A generalized rule distilled from multiple override events.
 *
 * Rules are the compressed form of the override corpus. Instead of scanning
 * 2,000 raw events for every autopilot decision, callers query compacted rules
 * which are grouped, time-windowed, and bounded in count regardless of incident
 * volume. This is what keeps storage flat and lookup cost O(1) rather than O(n).
 */
export interface CompactedRule {
  /** Detector tag this rule applies to (e.g. 'db_pool_exhaustion'). */
  incidentTag: string;
  /** Service this rule applies to. */
  service: string;
  /** Most common override reason driving this rule. */
  overrideReason: OverrideReason;
  /** Day-of-week (0=Sun … 6=Sat) this rule clusters on, or null if no day pattern. */
  dayOfWeek: number | null;
  /**
   * UTC hour window [start, end) where overrides cluster, or null.
   * e.g. [20, 23] means Friday 20–22 UTC.
   */
  hourWindow: [number, number] | null;
  /** Number of override events this rule was distilled from. */
  occurrences: number;
  compactedAt: number;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Distills the override event ring into a compact set of actionable rules.
 *
 * Each rule represents a recurring (incidentTag, service, overrideReason) pattern.
 * The corpus compresses naturally over time: 1,000 Friday-DB-pool overrides collapse
 * into one rule instead of occupying 1,000 ring-buffer slots.
 *
 * Intended use: call at startup and after bulk imports. For per-incident lookups
 * use getRulesForTag() which calls this internally.
 */
export function compactCorpus(): CompactedRule[] {
  load();

  // Return memoized result when _events hasn't changed since last compaction.
  if (!_corpusDirty && _compactedRules !== null) return _compactedRules;

  // Group by (incidentTag, service, overrideReason) — the three dimensions that
  // determine whether an override pattern is actionable.
  const buckets = new Map<string, OverrideEvent[]>();
  for (const e of _events) {
    const key = `${e.incidentTag}\x00${e.service}\x00${e.overrideReason}`;
    const list = buckets.get(key) ?? [];
    list.push(e);
    buckets.set(key, list);
  }

  const rules: CompactedRule[] = [];

  for (const events of buckets.values()) {
    if (events.length === 0) continue;
    const first = events[0];

    // Day clustering: surface dominant day only when ≥40% of overrides fall on it.
    const dayCounts = new Map<number, number>();
    for (const e of events) dayCounts.set(e.dayOfWeek, (dayCounts.get(e.dayOfWeek) ?? 0) + 1);

    let dominantDay: number | null = null;
    let dominantDayCount = 0;
    for (const [day, count] of dayCounts) {
      if (count > dominantDayCount) { dominantDay = day; dominantDayCount = count; }
    }
    if (dominantDay !== null && dominantDayCount / events.length < 0.4) dominantDay = null;

    // Hour window for the dominant day (or all events if no day pattern).
    let hourWindow: [number, number] | null = null;
    const hoursToWindow = dominantDay !== null
      ? events.filter((e) => e.dayOfWeek === dominantDay).map((e) => e.hourOfDay)
      : events.map((e) => e.hourOfDay);
    if (hoursToWindow.length > 0) {
      const minH = Math.min(...hoursToWindow);
      const maxH = Math.max(...hoursToWindow);
      // Only compact into a rule if the override pattern is narrow (< 20-hour span), otherwise too broad to be actionable.
      if (maxH - minH < 20) hourWindow = [minH, maxH + 1];
    }

    rules.push({
      incidentTag:    first.incidentTag,
      service:        first.service,
      overrideReason: first.overrideReason,
      dayOfWeek:      dominantDay,
      hourWindow,
      occurrences:    events.length,
      compactedAt:    Date.now(),
    });
  }

  rules.sort((a, b) => b.occurrences - a.occurrences);
  _compactedRules = rules;
  _corpusDirty = false;
  return rules;
}

/**
 * Returns all compacted rules that match a given (incidentTag, service) pair,
 * sorted by occurrence count descending.
 *
 * This is the primary entry point for planning-gate and corpus-first routing:
 * a rule hit here means the override pattern is documented and recurring.
 */
export function getRulesForTag(incidentTag: string, service: string): CompactedRule[] {
  return compactCorpus().filter(
    (r) => r.incidentTag === incidentTag && r.service === service,
  );
}

/**
 * Human-readable description of the strongest rule for a (tag, service) pair.
 * Returns null when no rules exist.
 *
 * Example: "db_pool_exhaustion for api — batch-window (Friday 20–22 UTC, 14 overrides)"
 */
export function describeTopRule(incidentTag: string, service: string): string | null {
  const rules = getRulesForTag(incidentTag, service);
  if (rules.length === 0) return null;
  const r = rules[0];
  const timePart = r.dayOfWeek !== null
    ? ` (${DAY_NAMES[r.dayOfWeek]}${r.hourWindow ? ` ${r.hourWindow[0]}–${r.hourWindow[1] - 1} UTC` : ''}, ${r.occurrences} overrides)`
    : ` (${r.occurrences} overrides)`;
  return `${r.incidentTag} for ${r.service} — ${r.overrideReason}${timePart}`;
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
  loadForRead();
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

/**
 * Automatically parses a Slack thread to extract override decisions.
 * Maps keywords to explicit OverrideReasons, parses commands/actions,
 * and records the override directly into the Override Corpus.
 *
 * This implements the core logic of Phase 4: Organizational Learning,
 * turning human Slack discussions into structured machine policies.
 */
export function compileOverrideFromSlackThread(
  slackThread: string,
  service: string = 'unknown'
): OverrideEvent | null {
  if (!slackThread) return null;

  // Extract commands inside backticks. e.g. `kubectl rollout restart deployment/api`
  const backtickCommands = [...slackThread.matchAll(/`([^`]{4,200})`/g)].map(m => m[1].trim());

  // 1. Identify proposed command and manual action taken
  // Often the team discusses a proposed action that they rejected, and a manual action they ran instead.
  let proposedCommand = '';
  let manualAction = '';

  for (const cmd of backtickCommands) {
    if (/^(kubectl|docker|systemctl|service|npm|yarn|pnpm|make)\s/i.test(cmd)) {
      if (/restart|stop|scale|revert|rollback|install/i.test(cmd)) {
        if (!proposedCommand) {
          proposedCommand = cmd;
        } else if (!manualAction && cmd !== proposedCommand) {
          manualAction = cmd;
        }
      }
    }
  }

  // Fallbacks if no backticked commands are found
  if (!proposedCommand) {
    const lines = slackThread.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(kubectl|docker|systemctl|service|npm|yarn|pnpm|make)\s/i.test(trimmed)) {
        proposedCommand = trimmed;
        break;
      }
    }
  }

  // If we can't find a proposed command, we cannot establish an override pattern
  if (!proposedCommand) {
    return null;
  }

  // 2. Identify the OverrideReason
  let reason: OverrideReason = 'on-call-discretion';
  let note = 'Extracted from Slack thread discussion';

  const lowerThread = slackThread.toLowerCase();

  if (lowerThread.includes('window') || lowerThread.includes('settlement') || lowerThread.includes('friday') || lowerThread.includes('batch')) {
    reason = 'batch-window';
    note = 'Override reason mapping: batch-window context discussed';
  } else if (lowerThread.includes('cost') || lowerThread.includes('budget') || lowerThread.includes('scale') || lowerThread.includes('expensive')) {
    reason = 'cost-constraint';
    note = 'Override reason mapping: cost constraints discussed';
  } else if (lowerThread.includes('cab') || lowerThread.includes('freeze') || lowerThread.includes('compliance') || lowerThread.includes('security')) {
    reason = 'compliance-hold';
    note = 'Override reason mapping: compliance hold or change freeze discussed';
  } else if (lowerThread.includes('replica') || lowerThread.includes('read') || lowerThread.includes('primary')) {
    reason = 'prefer-read-replica';
    note = 'Override reason mapping: read-replica routing preference discussed';
  } else if (lowerThread.includes('maintenance') || lowerThread.includes('scheduled')) {
    reason = 'maintenance-window';
    note = 'Override reason mapping: maintenance window discussed';
  } else if (lowerThread.includes('wrong diagnosis') || lowerThread.includes('misidentified') || lowerThread.includes('incorrect root')) {
    reason = 'wrong-diagnosis';
    note = 'Override reason mapping: wrong root-cause diagnosis discussed';
  } else if (lowerThread.includes('wrong fix') || lowerThread.includes('bad command') || lowerThread.includes('incorrect fix')) {
    reason = 'wrong-fix';
    note = 'Override reason mapping: wrong remediation command discussed';
  }

  // 3. Identify failure mode tag from text or keywords
  let incidentTag = 'infra_db_connection_pool'; // default fallback
  if (lowerThread.includes('oom') || lowerThread.includes('memory') || lowerThread.includes('limit')) {
    incidentTag = 'infra_oom_kill';
  } else if (lowerThread.includes('rate') || lowerThread.includes('limit') || lowerThread.includes('throttl')) {
    incidentTag = 'infra_rate_limit_cascade';
  } else if (lowerThread.includes('cert') || lowerThread.includes('tls') || lowerThread.includes('expiry') || lowerThread.includes('ssl')) {
    incidentTag = 'infra_certificate_expiry';
  } else if (lowerThread.includes('disk') || lowerThread.includes('space') || lowerThread.includes('full')) {
    incidentTag = 'infra_disk_pressure';
  } else if (lowerThread.includes('slow') || lowerThread.includes('query') || lowerThread.includes('latency')) {
    incidentTag = 'infra_slow_query';
  }

  // 4. Record into Override Corpus
  const event = recordOverride({
    incidentTag,
    proposedCommand,
    overrideReason: reason,
    note,
    service,
    environment: 'production',
    manualAction: manualAction || undefined,
    actor: 'Slack NLP Parser',
  });

  return event;
}
