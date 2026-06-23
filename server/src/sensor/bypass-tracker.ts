/**
 * bypass-tracker.ts — Detects block-then-bypass patterns to surface overly-aggressive rules.
 *
 * When a tool call is blocked by a policy rule, then the same tool is called
 * again within 60 seconds and passes (because the user edited the policy or
 * disabled the rule), that's a signal the rule may be too aggressive.
 *
 * After 5 such events on the same rule, it surfaces as a policy_refinement_candidate
 * in GET /agent-blunders — turning user friction directly into product signal.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, zeroRetentionMode } from './paths.js';
import logger from './logger.js';

const BYPASS_FILE = path.join(DATA_DIR, 'bypass-tracker.json');
const BLOCK_WINDOW_MS = 60_000;
export const REFINEMENT_THRESHOLD = 5;

interface RecentBlock {
  triggeredRules: string[];
  blockedAt: number;
}

interface BypassEntry {
  ruleId: string;
  count: number;
  toolNames: string[];
  lastBypassAt: number;
}

interface BypassStore {
  version: 1;
  entries: Record<string, BypassEntry>;
}

// In-memory only — recent blocks expire after BLOCK_WINDOW_MS
const _recentBlocks = new Map<string, RecentBlock>();

let _entries: Record<string, BypassEntry> = {};
let _loaded = false;
let _testingMode = false;

export function _resetBypassTrackerForTesting(): void {
  _entries = {};
  _loaded = true;
  _testingMode = true;
  _recentBlocks.clear();
}

function load(): void {
  if (_testingMode || _loaded) return;
  _loaded = true;
  if (!fs.existsSync(BYPASS_FILE)) { _entries = {}; return; }
  try {
    const raw = JSON.parse(fs.readFileSync(BYPASS_FILE, 'utf8')) as BypassStore;
    if (raw?.version === 1 && raw.entries && typeof raw.entries === 'object') {
      _entries = raw.entries;
    }
  } catch { _entries = {}; }
}

function persist(): void {
  if (zeroRetentionMode() || _testingMode) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${BYPASS_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: _entries } satisfies BypassStore), 'utf8');
    fs.renameSync(tmp, BYPASS_FILE);
  } catch (err) {
    logger.warn({ err }, 'bypass-tracker: persist failed');
  }
}

/** Called when a tool call is blocked. Registers it for bypass-window tracking. */
export function trackBlock(toolName: string, triggeredRules: string[]): void {
  _recentBlocks.set(toolName, { triggeredRules, blockedAt: Date.now() });
}

/**
 * Called when a tool call passes the gate. If the same tool was blocked within
 * the last 60 seconds, records a bypass event against each triggered rule.
 */
export function trackSuccessfulCall(toolName: string): void {
  load();
  const recent = _recentBlocks.get(toolName);
  if (!recent) return;

  const elapsed = Date.now() - recent.blockedAt;
  if (elapsed > BLOCK_WINDOW_MS) {
    _recentBlocks.delete(toolName);
    return;
  }

  _recentBlocks.delete(toolName);
  logger.info(
    { toolName, ruleIds: recent.triggeredRules, elapsedMs: elapsed },
    'bypass-tracker: block-then-bypass detected',
  );

  for (const ruleId of recent.triggeredRules) {
    const entry: BypassEntry = _entries[ruleId] ?? { ruleId, count: 0, toolNames: [], lastBypassAt: 0 };
    entry.count++;
    entry.lastBypassAt = Date.now();
    if (!entry.toolNames.includes(toolName)) entry.toolNames.push(toolName);
    _entries[ruleId] = entry;
  }
  persist();
}

export interface RefinementCandidate {
  ruleId: string;
  bypassCount: number;
  toolNames: string[];
  lastBypassAt: number;
  recommendation: string;
}

/** Returns rules that have been block-then-bypassed >= REFINEMENT_THRESHOLD times. */
export function getRefinementCandidates(): RefinementCandidate[] {
  load();
  return Object.values(_entries)
    .filter((e) => e.count >= REFINEMENT_THRESHOLD)
    .sort((a, b) => b.count - a.count)
    .map((e) => ({
      ruleId:        e.ruleId,
      bypassCount:   e.count,
      toolNames:     e.toolNames,
      lastBypassAt:  e.lastBypassAt,
      recommendation: `Rule "${e.ruleId}" has been blocked then immediately bypassed ${e.count} times. Consider narrowing its conditions in ~/.mergen/enterprise-policy.json to reduce false positives.`,
    }));
}

export function getBypassStats(): { totalBypasses: number; uniqueRules: number } {
  load();
  const totalBypasses = Object.values(_entries).reduce((sum, e) => sum + e.count, 0);
  return { totalBypasses, uniqueRules: Object.keys(_entries).length };
}
