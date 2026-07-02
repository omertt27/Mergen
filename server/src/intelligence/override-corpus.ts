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
import { normalizeForMatching } from './normalize.js';

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
  /** Why past-you made this call — plain language rationale preserved for future on-call. Clamped to 300 chars. */
  rationale?: string;
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
  /** 'community' = pre-seeded default; 'team' (or undefined) = recorded by this team. */
  source?: 'team' | 'community';
  /** Unix ms when an operator last explicitly re-affirmed this entry is still valid. */
  reviewedAt?: number;
  /**
   * Expiry timestamp (Unix ms). After this time the entry is excluded from gate
   * evaluation and flagged as stale in GET /overrides/expiring-soon.
   * Default: recordedAt + 90 days. Set to 0 to make the entry permanent.
   */
  expiresAt?: number;
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

/** Default corpus entry lifetime: 90 days. Set expiresAt: 0 to make permanent. */
const DEFAULT_EXPIRY_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * Detect logical conflicts between a new override and existing entries for the
 * same tag+service. A conflict exists when one entry says "always do X" and
 * another says "never do X" for the same incident tag.
 *
 * Returns a list of conflicting entry IDs if any contradictions are found.
 * This is purely advisory — the new entry is still recorded.
 */
export function detectConflicts(input: Pick<OverrideEvent, 'incidentTag' | 'service' | 'overrideReason' | 'proposedCommand'>): string[] {
  loadForRead();
  const now = Date.now();
  const CONFLICT_PAIRS: Array<[OverrideReason, OverrideReason]> = [
    ['batch-window',      'wrong-fix'],
    ['maintenance-window','wrong-diagnosis'],
    ['compliance-hold',   'on-call-discretion'],
  ];
  const conflicts: string[] = [];
  for (const ev of _events) {
    if (ev.incidentTag !== input.incidentTag) continue;
    if (ev.service !== input.service) continue;
    // Skip expired entries
    if (ev.expiresAt && ev.expiresAt > 0 && ev.expiresAt < now) continue;
    // Conflict: same proposed command, but contradictory override reasons
    const commandOverlap = ev.proposedCommand.slice(0, 50).toLowerCase() === input.proposedCommand.slice(0, 50).toLowerCase();
    if (commandOverlap) {
      for (const [a, b] of CONFLICT_PAIRS) {
        if ((ev.overrideReason === a && input.overrideReason === b) ||
            (ev.overrideReason === b && input.overrideReason === a)) {
          conflicts.push(ev.id);
        }
      }
    }
  }
  return conflicts;
}

/** Record an engineer override. Returns the saved event with its assigned id and any detected conflicts. */
export function recordOverride(input: Omit<OverrideEvent, 'id' | 'dayOfWeek' | 'hourOfDay' | 'recordedAt'>): OverrideEvent & { conflictsWith?: string[] } {
  const now = new Date();
  const conflicts = detectConflicts({
    incidentTag:     input.incidentTag,
    service:         input.service,
    overrideReason:  input.overrideReason,
    proposedCommand: input.proposedCommand,
  });
  // Compute expiry: honour explicit expiresAt=0 (permanent), otherwise default 90 days
  const expiresAt = input.expiresAt === 0 ? 0 : (input.expiresAt ?? now.getTime() + DEFAULT_EXPIRY_MS);
  const event: OverrideEvent = {
    ...input,
    id: randomUUID(),
    proposedCommand: input.proposedCommand.slice(0, 500),
    note: input.note?.slice(0, 200),
    rationale: input.rationale?.slice(0, 300),
    manualAction: input.manualAction?.slice(0, 500),
    dayOfWeek: now.getUTCDay(),
    hourOfDay: now.getUTCHours(),
    recordedAt: now.getTime(),
    expiresAt,
  };

  return lockAndExecute(`${OVERRIDE_CORPUS_FILE}.lock`, () => {
    load(true);
    _events.push(event);
    if (_events.length > MAX_EVENTS) _events = _events.slice(-MAX_EVENTS);
    _corpusDirty = true;
    persist();
    if (conflicts.length > 0) {
      logger.warn({ id: event.id, tag: event.incidentTag, conflicts }, 'override-corpus: conflict detected with existing entries');
    }
    logger.info({ id: event.id, tag: event.incidentTag, reason: event.overrideReason, service: event.service, expiresAt }, 'override-corpus: override recorded');
    return { ...event, conflictsWith: conflicts.length > 0 ? conflicts : undefined };
  });
}

/**
 * Returns corpus entries expiring within the next windowDays (default: 14).
 * Used by GET /overrides/expiring-soon to surface renewal prompts.
 */
export function getExpiringSoon(windowDays = 14): OverrideEvent[] {
  loadForRead();
  const now      = Date.now();
  const cutoffMs = now + windowDays * 24 * 60 * 60 * 1_000;
  return _events.filter((e) => {
    if (!e.expiresAt || e.expiresAt === 0) return false; // permanent
    return e.expiresAt > now && e.expiresAt < cutoffMs;
  });
}

// ── Policy packs (export / import) ────────────────────────────────────────────
// A pack is the shareable form of the corpus: the pattern fields only, with
// team-local provenance (id, actor, recordedAt, reviewedAt) stripped. Packs are
// what a team publishes ("our Friday settlement-window rules") and what a fresh
// install imports to start with a non-empty corpus.

export interface OverridePackEntry {
  incidentTag: string;
  proposedCommand: string;
  overrideReason: OverrideReason;
  note?: string;
  rationale?: string;
  service: string;
  environment: string;
  /** 0=Sunday … 6=Saturday, UTC — part of the pattern, preserved on import. */
  dayOfWeek: number;
  /** 0–23 UTC — part of the pattern, preserved on import. */
  hourOfDay: number;
  manualAction?: string;
  outcome?: OverrideOutcome;
  /**
   * Relative lifetime applied at import time. Omitted = permanent (expiresAt: 0):
   * pack entries encode structural policy, not recent incident history, so they
   * don't get the 90-day default that team-recorded overrides do.
   */
  expiresInDays?: number;
}

export interface OverridePack {
  format: 'mergen-pack';
  version: 1;
  name?: string;
  exportedAt: number;
  entryCount: number;
  entries: OverridePackEntry[];
}

/**
 * Pattern identity of an entry — same key the community seeder uses. Two
 * entries with the same key encode the same policy pattern, so import skips
 * duplicates and export collapses them.
 */
export function overridePackKey(
  e: Pick<OverrideEvent, 'incidentTag' | 'overrideReason' | 'dayOfWeek' | 'hourOfDay' | 'service'>,
): string {
  return `${e.incidentTag}:${e.overrideReason}:${e.dayOfWeek}:${e.hourOfDay}:${e.service}`;
}

/**
 * Build a shareable pack from corpus events. Pure — callers fetch events from
 * whichever store backs the deployment. Community-sourced entries are excluded
 * by default so re-exporting doesn't echo imported packs back into circulation.
 */
export function buildOverridePack(
  events: readonly OverrideEvent[],
  opts: { name?: string; includeCommunity?: boolean } = {},
): OverridePack {
  const seen = new Set<string>();
  const entries: OverridePackEntry[] = [];
  for (const e of events) {
    if (e.source === 'community' && !opts.includeCommunity) continue;
    const key = overridePackKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      incidentTag:     e.incidentTag,
      proposedCommand: e.proposedCommand,
      overrideReason:  e.overrideReason,
      ...(e.note ? { note: e.note } : {}),
      ...(e.rationale ? { rationale: e.rationale } : {}),
      service:         e.service,
      environment:     e.environment,
      dayOfWeek:       e.dayOfWeek,
      hourOfDay:       e.hourOfDay,
      ...(e.manualAction ? { manualAction: e.manualAction } : {}),
      ...(e.outcome ? { outcome: e.outcome } : {}),
    });
  }
  return {
    format: 'mergen-pack',
    version: 1,
    ...(opts.name ? { name: opts.name } : {}),
    exportedAt: Date.now(),
    entryCount: entries.length,
    entries,
  };
}

/**
 * Import pack entries into the corpus. Unlike recordOverride, this preserves
 * each entry's dayOfWeek/hourOfDay — the time window is part of the pattern
 * ("Friday settlement window"), not a record-time artifact. Entries whose
 * pattern key already exists are skipped, so import is idempotent and team
 * overrides always take precedence over pack content.
 */
export function importOverrides(
  entries: OverridePackEntry[],
  opts: { source?: 'team' | 'community'; actor?: string } = {},
): { imported: number; skipped: number } {
  const source = opts.source ?? 'community';
  const actor  = opts.actor ?? source;
  return lockAndExecute(`${OVERRIDE_CORPUS_FILE}.lock`, () => {
    load(true);
    const existingKeys = new Set(_events.map(overridePackKey));
    const now = Date.now();
    let imported = 0;
    let skipped  = 0;
    for (const entry of entries) {
      const dayOfWeek = Math.min(6, Math.max(0, Math.trunc(entry.dayOfWeek)));
      const hourOfDay = Math.min(23, Math.max(0, Math.trunc(entry.hourOfDay)));
      const key = overridePackKey({ ...entry, dayOfWeek, hourOfDay });
      if (existingKeys.has(key)) { skipped++; continue; }
      existingKeys.add(key);
      _events.push({
        id:              randomUUID(),
        incidentTag:     entry.incidentTag,
        proposedCommand: entry.proposedCommand.slice(0, 500),
        overrideReason:  entry.overrideReason,
        note:            entry.note?.slice(0, 200),
        rationale:       entry.rationale?.slice(0, 300),
        service:         entry.service,
        environment:     entry.environment,
        dayOfWeek,
        hourOfDay,
        manualAction:    entry.manualAction?.slice(0, 500),
        outcome:         entry.outcome,
        recordedAt:      now,
        actor,
        source,
        expiresAt:       entry.expiresInDays ? now + entry.expiresInDays * 24 * 60 * 60 * 1_000 : 0,
      });
      imported++;
    }
    if (imported > 0) {
      if (_events.length > MAX_EVENTS) _events = _events.slice(-MAX_EVENTS);
      _corpusDirty = true;
      persist();
      logger.info({ imported, skipped, source }, 'override-corpus: pack imported');
    }
    return { imported, skipped };
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
 * Excludes expired entries from evaluation.
 */
export function hasRecentOverride(
  incidentTag: string,
  service: string,
  dayOfWeek: number,
  hourOfDay: number,
): boolean {
  loadForRead();
  const now    = Date.now();
  const cutoff = now - 90 * 24 * 60 * 60 * 1000;
  return _events.some((e) => {
    if (e.incidentTag !== incidentTag) return false;
    if (e.service !== service) return false;
    if (e.recordedAt < cutoff) return false;
    // Skip expired entries — they should not affect gate decisions
    if (e.expiresAt && e.expiresAt > 0 && e.expiresAt < now) return false;
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
  /**
   * Normalized command signatures (first few significant tokens) drawn from
   * this bucket's actual proposedCommand text — e.g. 'kubectl set env' rather
   * than the full 'kubectl set env deployment/api DB_POOL_MAX=50'. Scopes any
   * synthesized policy rule to the commands that were actually overridden
   * instead of every AI action against the service. Empty only if every event
   * in the bucket had an unparseable command.
   */
  commandSignatures: string[];
  compactedAt: number;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Number of leading whitespace-separated tokens kept as a command's "signature" —
// enough to identify the operation (e.g. 'kubectl set env', 'terraform destroy')
// without pinning to the specific resource name / value that varies per incident.
const SIGNATURE_TOKEN_COUNT = 3;
// Cap on distinct signatures carried into a single synthesized rule — keeps the
// rule from ballooning into an unbounded commands list when a bucket really does
// span many unrelated commands.
export const MAX_COMMAND_SIGNATURES = 5;

/** Exported so storage backends (e.g. pg-override-corpus.ts) compact with the same algorithm. */
export function commandSignature(proposedCommand: string): string {
  const normalized = normalizeForMatching(proposedCommand).trim();
  return normalized.split(' ').slice(0, SIGNATURE_TOKEN_COUNT).join(' ');
}

/** Exported so storage backends (e.g. pg-override-corpus.ts) compact with the same algorithm. */
export function dominantCommandSignatures(events: OverrideEvent[]): string[] {
  const sigCounts = new Map<string, number>();
  for (const e of events) {
    const sig = commandSignature(e.proposedCommand);
    if (sig) sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
  }
  return [...sigCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COMMAND_SIGNATURES)
    .map(([sig]) => sig);
}

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

    // Command signatures: rank distinct signatures by frequency, keep the top
    // MAX_COMMAND_SIGNATURES. Drops empty signatures (blank/unparseable commands).
    const commandSignatures = dominantCommandSignatures(events);

    rules.push({
      incidentTag:    first.incidentTag,
      service:        first.service,
      overrideReason: first.overrideReason,
      dayOfWeek:      dominantDay,
      hourWindow,
      occurrences:    events.length,
      commandSignatures,
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

// ── Slack thread analysis — shared classification tables ─────────────────────
// These mirror git-adr-sync.ts so both ingestion paths use identical rules.

const _TAG_HINTS: Array<[RegExp, string]> = [
  [/\bpool\b|connection.?limit|max.?conn/i,         'infra_db_connection_pool'],
  [/\boom\b|out.of.memory|heap|memory.?leak/i,      'infra_oom_kill'],
  [/rate.?limit|throttl/i,                          'infra_rate_limit_cascade'],
  [/\bauth\b|\btoken\b|session|oauth|\bjwt\b/i,     'auth_token_not_persisted'],
  [/\bcache\b|\bredis\b|memcach/i,                  'cache_invalidation'],
  [/\bdeploy\b|rollout|release/i,                   'deploy_config_drift'],
  [/\bcert\b|\btls\b|\bssl\b/i,                     'infra_certificate_expiry'],
  [/\bdisk\b|storage|volume|\bspace\b/i,            'infra_disk_pressure'],
  [/migrat|schema|alter.?table/i,                   'db_migration_lock'],
  [/friday|settlement|batch|weekend|end.of.day/i,   'batch_window_conflict'],
  [/\bscale\b|replica|pod.?count|instance/i,        'infra_scaling'],
  [/slow.?query|high.?latency|\bp99\b|\bp95\b/i,   'infra_slow_query'],
];

const _REASON_HINTS: Array<[RegExp, OverrideReason]> = [
  [/\b(friday|saturday|sunday|settlement|batch.window|end.of.day|after.hours|market.hours|trading.hours)\b/i, 'batch-window'],
  [/\b(cost|budget|billing|too.expensive|over.budget|cost.ceiling)\b/i,                                      'cost-constraint'],
  [/\b(cab|change.?control|change.?freeze|compliance|requires.approval|approval.required)\b/i,               'compliance-hold'],
  [/\b(read.?replica|replica.?routing|prefer.replica|read.only.replica)\b/i,                                'prefer-read-replica'],
  [/\b(maintenance.?window|scheduled.downtime|downtime.window)\b/i,                                         'maintenance-window'],
  [/\b(wrong.?diag|misidentif|incorrect.root.cause|false.?positive|misdiagnos)\b/i,                        'wrong-diagnosis'],
  [/\b(wrong.?fix|bad.command|revert|made.it.worse|incorrect.fix|undo)\b/i,                                'wrong-fix'],
];

function _inferTag(text: string): string {
  for (const [re, tag] of _TAG_HINTS) {
    if (re.test(text)) return tag;
  }
  return 'operational_constraint';
}

function _inferReason(text: string): OverrideReason {
  for (const [re, reason] of _REASON_HINTS) {
    if (re.test(text)) return reason;
  }
  return 'on-call-discretion';
}

// Bare CLI invocation at the start of a line — captures commands written
// without backticks, e.g. "kubectl rollout restart deploy/api", "terraform apply".
// Anchored to the (trimmed) line start and limited to a known binary vocabulary
// so it does not match prose lines that merely mention these tools mid-sentence.
const _CLI_START_RE = /^(kubectl|oc|docker|docker-compose|podman|terraform|tofu|pulumi|ansible(?:-playbook)?|helm|kubeadm|nomad|vault|consul|systemctl|service|supervisorctl|pm2|npm|yarn|pnpm|npx|make|rake|rails|flyway|liquibase|alembic|psql|mysql|mongosh|mongo|redis-cli|aws|gcloud|az|git|pg_dump|pg_restore|createdb|dropdb|nginx|apachectl|kill|pkill|rm|chmod|chown|scp|rsync|bash|sh)\b/i;

// Action verbs that appear in operational constraints
const _ACTION_RE = /\b(restart|kill|delete|drop|destroy|scale|resize|run|migrate|execute|deploy|push|apply|rollback|terminate|truncate|alter|reboot|flush|drain|update|patch)\b/i;

// Negative decision prefixes — "don't X", "we decided not to X", "avoid X"
const _NEG_RE = /\b(don'?t|do\s+not|avoid|never|should\s+not|shouldn'?t|must\s+not|mustn'?t|cannot|can'?t|won'?t|will\s+not|decided\s+(?:not|against)(?:\s+to)?|refrain\s+from|hold\s+off\s+on|no\s+(?:more\s+)?)\b/i;

// Phrases that signal a human lesson or constraint being declared
const _CONSTRAINT_SIGNAL_RE = /\b(constraint:|policy:|rule:|adr:|decided:|going\s+forward[,:]?|lesson(?:\s+learned)?[s:]?|we\s+learned|action\s+item[s:]?|takeaway[s:]?|we\s+(?:shouldn'?t|should\s+not|decided\s+not|won'?t|will\s+not))\b/i;

// Temporal constraint patterns — "don't touch X until Y", "freeze Z this weekend"
// These phrases signal time-bounded operational holds.
const _TEMPORAL_RE = /\b(until|freeze|freeze\s+all|hold\s+off\s+until|not\s+until|embargo|blackout|lock\s+down|halt.*until|pause.*until|suspend.*until|stop.*until|don'?t.*until|this\s+(?:weekend|week|friday|monday|evening|night|morning)|end\s+of\s+(?:day|week|month|sprint|quarter))\b/i;

// Parse a rough duration in ms from a temporal phrase (best-effort)
function _parseTemporalExpiry(sentence: string): number | undefined {
  const lc = sentence.toLowerCase();
  if (/this\s+(weekend|saturday|sunday)/.test(lc)) {
    // Expires Monday 06:00 UTC
    const now = new Date();
    const daysUntilMon = (8 - now.getUTCDay()) % 7 || 7;
    const expiry = new Date(now);
    expiry.setUTCDate(now.getUTCDate() + daysUntilMon);
    expiry.setUTCHours(6, 0, 0, 0);
    return expiry.getTime();
  }
  if (/end\s+of\s+day|tonight|this\s+evening/.test(lc)) {
    const expiry = new Date();
    expiry.setUTCHours(23, 59, 0, 0);
    if (expiry.getTime() < Date.now()) expiry.setUTCDate(expiry.getUTCDate() + 1);
    return expiry.getTime();
  }
  if (/this\s+week|end\s+of\s+week/.test(lc)) {
    return Date.now() + 7 * 24 * 60 * 60 * 1_000;
  }
  if (/end\s+of\s+month/.test(lc)) {
    return Date.now() + 30 * 24 * 60 * 60 * 1_000;
  }
  if (/end\s+of\s+(sprint|quarter)/.test(lc)) {
    return Date.now() + 14 * 24 * 60 * 60 * 1_000;
  }
  return undefined;
}

interface _Candidate {
  command: string;
  note: string;
  isNegative: boolean;
  manualAction?: string;
  /** Optional auto-computed expiry timestamp for temporal constraints. */
  expiresAt?: number;
}

function _extractCandidates(thread: string): _Candidate[] {
  const candidates: _Candidate[] = [];
  const seen = new Set<string>();

  function _add(command: string, note: string, isNegative: boolean, manualAction?: string, expiresAt?: number): void {
    const key = command.toLowerCase().slice(0, 50);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ command: command.slice(0, 500), note: note.slice(0, 300), isNegative, manualAction, expiresAt });
    }
  }

  // ── Path 1: backtick-quoted commands — pair first=proposed, second=manualAction ──
  // Postmortem threads often follow: "don't run `X`, I ran `Y` instead."
  // Capturing them as one entry preserves context and avoids double-counting.
  const backtickCmds = [...thread.matchAll(/`([^`]{4,300})`/g)].map(m => m[1].trim());
  if (backtickCmds.length > 0) {
    const proposed = backtickCmds[0];
    const manual   = backtickCmds[1]; // may be undefined
    _add(proposed, proposed, false, manual);
    if (manual) seen.add(manual.toLowerCase().slice(0, 50)); // prevent re-adding as separate entry
    for (const cmd of backtickCmds.slice(2)) _add(cmd, cmd, false);
  }

  // ── Path 2: bare CLI lines ────────────────────────────────────────────────
  for (const line of thread.split('\n')) {
    const t = line.trim();
    if (_CLI_START_RE.test(t)) _add(t, t, false);
  }

  // ── Path 3: negative decision sentences ───────────────────────────────────
  // "don't restart the DB during settlement window"
  // "we decided not to scale the pool"
  // "avoid running migrations on Friday"
  // Skip sentences that merely reference a command already captured via backtick/CLI.
  for (const sentence of thread.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 15 && s.length < 350)) {
    if (!_NEG_RE.test(sentence)) continue;
    if (!_ACTION_RE.test(sentence)) continue;
    const lc = sentence.toLowerCase();
    if ([...seen].some(k => k.length > 10 && lc.includes(k))) continue;
    const actionMatch = sentence.match(_ACTION_RE);
    const verb = actionMatch ? actionMatch[0] : 'operation';
    _add(`${verb} (blocked): ${sentence.slice(0, 120)}`, sentence, true);
  }

  // ── Path 4: explicit constraint declarations ──────────────────────────────
  // "going forward, we won't X" / "lesson learned: X" / "constraint: X"
  for (const sentence of thread.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10 && s.length < 400)) {
    if (!_CONSTRAINT_SIGNAL_RE.test(sentence)) continue;
    const lc = sentence.toLowerCase();
    if ([...seen].some(k => k.length > 10 && lc.includes(k))) continue;
    _add(sentence.slice(0, 200), sentence, false);
  }

  // ── Path 5: temporal constraint phrases ──────────────────────────────────
  // "don't deploy until Monday", "freeze all changes this weekend",
  // "hold off until end of day", "embargo releases until the batch window closes"
  // Extract with best-effort expiry based on the time phrase detected.
  for (const sentence of thread.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10 && s.length < 400)) {
    if (!_TEMPORAL_RE.test(sentence)) continue;
    const lc = sentence.toLowerCase();
    if ([...seen].some(k => k.length > 10 && lc.includes(k))) continue;
    const expiresAt = _parseTemporalExpiry(sentence);
    const label = expiresAt
      ? `temporal-hold (expires ${new Date(expiresAt).toISOString().slice(0, 16)}Z): ${sentence.slice(0, 120)}`
      : `temporal-hold: ${sentence.slice(0, 120)}`;
    _add(label, sentence, true, undefined, expiresAt);
  }

  return candidates;
}

/**
 * Extract ALL override patterns from a Slack postmortem thread.
 * Returns one OverrideEvent per distinct constraint — typically 1–5 per thread.
 * Records each into the corpus automatically.
 *
 * Extracts five signal types:
 *   1. Backtick-quoted command pairs (proposed + manualAction) — highest confidence
 *   2. Bare CLI lines (kubectl, docker, terraform, etc.)
 *   3. Negative decision sentences ("don't restart during settlement window")
 *   4. Constraint declarations ("going forward", "lesson learned", "policy:")
 *   5. Temporal constraint phrases ("freeze this weekend", "hold off until Monday") with auto-expiry
 */
export function compileOverridesFromSlackThread(
  slackThread: string,
  service = 'unknown',
): OverrideEvent[] {
  if (!slackThread) return [];

  const candidates = _extractCandidates(slackThread);
  if (candidates.length === 0) return [];

  const threadTag    = _inferTag(slackThread);
  const threadReason = _inferReason(slackThread);

  const events: OverrideEvent[] = [];

  for (const cand of candidates) {
    const localTag    = _inferTag(cand.note) !== 'operational_constraint' ? _inferTag(cand.note) : threadTag;
    const localReason = _inferReason(cand.note) !== 'on-call-discretion'  ? _inferReason(cand.note) : threadReason;

    try {
      const event = recordOverride({
        incidentTag:     localTag,
        proposedCommand: cand.command,
        overrideReason:  localReason,
        note:            cand.note,
        rationale:       cand.isNegative
          ? 'Auto-extracted: negative decision pattern from postmortem thread'
          : 'Auto-extracted: constraint declaration from postmortem thread',
        service,
        environment: 'production',
        manualAction: cand.manualAction,
        actor:       'slack-nlp-parser',
        // Temporal constraints carry an auto-computed expiry
        expiresAt: cand.expiresAt,
      });
      events.push(event);
    } catch { /* non-fatal — duplicate or validation error */ }

    if (events.length >= 10) break;
  }

  return events;
}

// ── Corpus staleness ─────────────────────────────────────────────────────────

/**
 * Returns override entries that have not been operator-reviewed within
 * daysThreshold days (default 60). An entry is considered reviewed if its
 * reviewedAt field is set and is within the threshold — otherwise it relies
 * on the original recordedAt, which may be very old.
 *
 * Used by GET /override-corpus/stale and the Slack daily digest to surface
 * entries that have silently accumulated and may no longer reflect team policy.
 */
export function getStaleOverrides(daysThreshold = 60): OverrideEvent[] {
  loadForRead();
  const cutoff = Date.now() - daysThreshold * 24 * 60 * 60 * 1_000;
  return _events.filter((e) => {
    const lastReviewed = e.reviewedAt ?? e.recordedAt;
    return lastReviewed < cutoff;
  });
}

/**
 * Mark an override entry as reviewed by an operator at the current time.
 * Returns false if the id is not found.
 */
export function markOverrideReviewed(id: string): boolean {
  return lockAndExecute(`${OVERRIDE_CORPUS_FILE}.lock`, () => {
    load(true);
    const ev = _events.find((e) => e.id === id);
    if (!ev) return false;
    ev.reviewedAt = Date.now();
    _corpusDirty = true;
    persist();
    logger.info({ id }, 'override-corpus: entry marked reviewed');
    return true;
  });
}

/**
 * Backward-compatible single-result variant.
 * New callers should prefer compileOverridesFromSlackThread (plural).
 */
export function compileOverrideFromSlackThread(
  slackThread: string,
  service = 'unknown',
): OverrideEvent | null {
  return compileOverridesFromSlackThread(slackThread, service)[0] ?? null;
}
