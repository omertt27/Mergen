/**
 * error-fingerprint.ts — Normalize error messages to stable fingerprints for
 * deduplication, frequency counting, and anomaly baseline comparison.
 *
 * The core insight: "Cannot read property 'id' of undefined" and
 * "Cannot read property 'token' of undefined" are the same error pattern.
 * "POST /api/users/123 → 404" and "POST /api/users/456 → 404" are the same
 * network pattern.
 *
 * Without normalization, every error in the buffer looks unique. With it,
 * Mergen can say "this exact pattern has fired 847 times in the last hour."
 */

import type { ConsoleEvent, NetworkEvent } from '../sensor/buffer.js';

// ── Fingerprint functions ─────────────────────────────────────────────────────

/** Normalise a console error message to a stable deduplication key. */
export function fingerprintConsoleError(e: ConsoleEvent): string {
  const raw = e.args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  return normaliseMessage(raw);
}

/** Normalise a network event to a stable key (method + path pattern + status). */
export function fingerprintNetworkEvent(n: NetworkEvent): string {
  let path = '';
  try {
    path = new URL(n.url).pathname;
  } catch {
    path = n.url;
  }
  // Collapse UUID/numeric segments to placeholders: /users/123 → /users/:id
  const normPath = path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
    .replace(/\b\d{4,}\b/g, ':id')
    .replace(/\b\d+\b/g, ':n');
  return `${n.method} ${normPath} → ${n.status}`;
}

export function normaliseMessage(raw: string): string {
  return raw
    .toLowerCase()
    // Strip URLs
    .replace(/https?:\/\/[^\s'"]+/g, '<url>')
    // Strip UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    // Strip hex values
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    // Strip long numeric strings (IDs, timestamps)
    .replace(/\b\d{4,}\b/g, '<n>')
    // Collapse remaining numbers to N (keep short ones for line numbers etc.)
    .replace(/\b\d+\b/g, 'N')
    // Strip quoted strings (they're usually values, not structure)
    .replace(/["'][^"']{2,}["']/g, '<str>')
    // Strip file paths
    .replace(/(?:\/[\w.-]+){3,}/g, '<path>')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ── Frequency table ───────────────────────────────────────────────────────────

export interface ErrorFrequency {
  fingerprint: string;
  /** A human-readable representative message (not normalised). */
  sample: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  /** Whether this error has been seen before this session (cross-session via SQLite). */
  isNew: boolean;
}

/**
 * Build a frequency table from the current ring buffer's console errors.
 * Returns entries sorted by count descending.
 */
export function computeErrorFrequency(
  events: ConsoleEvent[],
  knownFingerprints?: Set<string>,
): ErrorFrequency[] {
  const table = new Map<string, ErrorFrequency>();
  const errors = events.filter((e) => e.level === 'error');

  for (const e of errors) {
    const fp = fingerprintConsoleError(e);
    const existing = table.get(fp);
    if (existing) {
      existing.count++;
      existing.lastSeen = Math.max(existing.lastSeen, e.timestamp);
      existing.firstSeen = Math.min(existing.firstSeen, e.timestamp);
    } else {
      const sample = e.args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
        .slice(0, 200);
      table.set(fp, {
        fingerprint: fp,
        sample,
        count: 1,
        firstSeen: e.timestamp,
        lastSeen: e.timestamp,
        isNew: knownFingerprints ? !knownFingerprints.has(fp) : true,
      });
    }
  }

  return [...table.values()].sort((a, b) => b.count - a.count);
}

/**
 * Compute network error frequency (same URL pattern + status).
 */
export function computeNetworkFrequency(
  events: NetworkEvent[],
): Array<{ fingerprint: string; count: number; firstSeen: number; lastSeen: number; sample: string }> {
  const table = new Map<string, { count: number; firstSeen: number; lastSeen: number; sample: string }>();
  const failures = events.filter((n) => n.status >= 400 || n.status === 0 || n.error);

  for (const n of failures) {
    const fp = fingerprintNetworkEvent(n);
    const existing = table.get(fp);
    if (existing) {
      existing.count++;
      existing.lastSeen = Math.max(existing.lastSeen, n.timestamp);
    } else {
      table.set(fp, { count: 1, firstSeen: n.timestamp, lastSeen: n.timestamp, sample: `${n.method} ${n.url} → ${n.status}` });
    }
  }

  return [...table.entries()]
    .map(([fingerprint, v]) => ({ fingerprint, ...v }))
    .sort((a, b) => b.count - a.count);
}
