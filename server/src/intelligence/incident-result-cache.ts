/**
 * incident-result-cache.ts — Short-term cache of autopilot analysis results.
 *
 * Keyed by incident fingerprint (the same value used as `pid` in the autopilot).
 * When autopilot completes an analysis cycle, it writes the top hypothesis tag
 * and whether the override corpus blocked execution. On the next trigger for the
 * same fingerprint within the TTL:
 *
 *   - corpus-blocked result → skip buildCausalChain entirely (no LLM call)
 *   - executed result       → skip re-analysis (fix was just applied)
 *
 * Why this matters for unit economics:
 *   A noisy PagerDuty service that re-fires every 5 minutes for the same root
 *   cause pays for ONE LLM call per hour instead of one per trigger. Corpus
 *   conflicts are the most common skip reason, so this hits the most expensive
 *   cases first.
 *
 * TTL is intentionally short (1 hour) — state may genuinely change after a
 * deploy or manual intervention. The cache is invalidated on any manual override
 * recorded for the same fingerprint.
 *
 * Storage: in-memory only. Resets on server restart (safe — re-analysis on
 * restart is fine; the goal is to avoid redundant calls within a session).
 */

export interface CachedIncidentResult {
  fingerprint: string;
  service: string;
  incidentTag: string;
  /** True if the override corpus blocked autonomous execution on this run. */
  corpusBlocked: boolean;
  blockReason: string | null;
  /** Command that was executed, if any. Null when blocked or below threshold. */
  executedCommand: string | null;
  cachedAt: number;
}

const TTL_MS = 60 * 60 * 1_000; // 1 hour
const MAX_ENTRIES = 500;

const _cache = new Map<string, CachedIncidentResult>();

/** Store the result of an autopilot analysis run. */
export function cacheIncidentResult(
  result: Omit<CachedIncidentResult, 'cachedAt'>,
): void {
  _cache.set(result.fingerprint, { ...result, cachedAt: Date.now() });
  if (_cache.size > MAX_ENTRIES) {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, v] of _cache) {
      if (v.cachedAt < cutoff) _cache.delete(k);
    }
  }
}

/**
 * Returns a cached result if it exists and is within TTL, otherwise null.
 * Side effect: evicts the entry if it has expired.
 */
export function getCachedIncidentResult(fingerprint: string): CachedIncidentResult | null {
  const entry = _cache.get(fingerprint);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) {
    _cache.delete(fingerprint);
    return null;
  }
  return entry;
}

/**
 * Invalidate a cached result. Call this when an engineer records a manual
 * override so the next trigger runs fresh analysis instead of fast-pathing.
 */
export function invalidateIncidentResult(fingerprint: string): void {
  _cache.delete(fingerprint);
}

/** Current cache size — exposed for observability / health endpoints. */
export function incidentCacheSize(): number {
  return _cache.size;
}
