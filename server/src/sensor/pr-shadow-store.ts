/**
 * pr-shadow-store.ts — Ring buffer for PR shadow mode results.
 *
 * Stores what Mergen *would have posted* as a PR comment before PR comments
 * are enabled. The accumulated data answers the question:
 *   "If we had enabled comments on every PR, what fraction would have been useful?"
 *
 * That fraction — wouldHaveBeenUsefulRate — is the gate for flipping to real
 * PR comments. We require ≥40% useful AND helpfulRate7d ≥ 80% before enabling.
 *
 * Storage: ~/.mergen/pr-shadow.json (bounded ring, 500 entries)
 */

import fs from 'fs';
import { randomUUID } from 'crypto';
import { PR_SHADOW_FILE, DATA_DIR } from './paths.js';
import logger from './logger.js';

const RING_SIZE = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PRShadowResult {
  id: string;
  prId: string;               // "org/repo#123"
  repo: string;
  prNumber: number;
  prTitle: string;
  author: string;
  branch: string;
  action: string;             // "opened" | "synchronize" | "ready_for_review"
  wouldHaveShown: boolean;
  relevanceScore: number;     // 0–1
  matchedIncidents: number;
  matchedContexts: number;
  triggeredBy: string[];      // ["incident_match", "context_match"]
  wouldHaveComment: string | null;  // the markdown comment that would have been posted
  timestamp: number;
}

interface PRShadowFile {
  version: 1;
  results: PRShadowResult[];
}

// ── In-memory state ───────────────────────────────────────────────────────────

let _results: PRShadowResult[] = [];
let _loaded = false;

function ensureLoaded(): void {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = fs.readFileSync(PR_SHADOW_FILE, 'utf8');
    const parsed: PRShadowFile = JSON.parse(raw);
    if (parsed.version === 1 && Array.isArray(parsed.results)) {
      _results = parsed.results.slice(-RING_SIZE);
    }
  } catch {
    // first run or corrupt file — start empty
  }
}

function persist(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload: PRShadowFile = { version: 1, results: _results };
    fs.writeFileSync(PR_SHADOW_FILE, JSON.stringify(payload), 'utf8');
  } catch (err) {
    logger.warn({ err }, 'pr-shadow-store: persist failed');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function recordPRShadow(
  input: Omit<PRShadowResult, 'id' | 'timestamp'>,
): PRShadowResult {
  ensureLoaded();
  const entry: PRShadowResult = {
    ...input,
    id: randomUUID(),
    timestamp: Date.now(),
  };
  _results.push(entry);
  if (_results.length > RING_SIZE) _results.splice(0, _results.length - RING_SIZE);
  persist();
  logger.debug(
    { prId: entry.prId, wouldHaveShown: entry.wouldHaveShown, score: entry.relevanceScore },
    'pr-shadow: result recorded',
  );
  return entry;
}

export function getPRShadowResults(limit = 100): readonly PRShadowResult[] {
  ensureLoaded();
  return _results.slice(-limit).reverse();
}

export function getPRShadowStats(windowMs = 30 * 24 * 60 * 60 * 1000) {
  ensureLoaded();
  const cutoff = Date.now() - windowMs;
  const inWindow = _results.filter((r) => r.timestamp >= cutoff);

  const total = inWindow.length;
  const shown = inWindow.filter((r) => r.wouldHaveShown).length;
  const wouldHaveBeenUsefulRate = total === 0 ? null : Math.round((shown / total) * 1000) / 10;

  const avgRelevanceScore =
    total === 0
      ? null
      : Math.round(
          (inWindow.reduce((a, r) => a + r.relevanceScore, 0) / total) * 1000,
        ) / 1000;

  const triggerCounts: Record<string, number> = {};
  for (const r of inWindow) {
    for (const t of r.triggeredBy) {
      triggerCounts[t] = (triggerCounts[t] ?? 0) + 1;
    }
  }
  const topTriggers = Object.entries(triggerCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([trigger, count]) => ({ trigger, count }));

  return {
    totalAnalyzed: total,
    wouldHaveShown: shown,
    wouldHaveBeenUsefulRate,
    avgRelevanceScore,
    topTriggers,
  };
}

/** Only for tests. */
export function _resetPRShadowForTesting(): void {
  _results = [];
  _loaded = true;
}
