/**
 * unclassified-clusters.ts — Surfaces error patterns that fire zero detectors.
 *
 * When buildCausalChain runs all detectors and nothing fires, the structural
 * pattern of that session is recorded here. Clusters with 3+ occurrences are
 * candidates for new detectors — the mechanism for breaking through the
 * rule-based ceiling.
 *
 * The fingerprint is structural (event kinds + network status sequence), not
 * content-based — it never stores error messages, URLs, or stack traces.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { DATA_DIR } from '../sensor/paths.js';
import type { CausalEvent } from './causal.js';

const CLUSTERS_FILE = path.join(DATA_DIR, 'unclassified-clusters.json');
const MAX_CLUSTERS = 200;

export interface UnclassifiedCluster {
  fingerprint: string;
  /** Structural pattern string: human-readable summary of the kind sequence */
  pattern: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  /** One representative sample (structural only — no content) */
  sample: {
    chainKinds: string[];
    networkStatuses: number[];
    hasErrors: boolean;
    hasNetworkFails: boolean;
  };
}

interface ClustersFile {
  version: 1;
  clusters: UnclassifiedCluster[];
}

let _clusters = new Map<string, UnclassifiedCluster>();
let _loaded = false;

function load(): void {
  if (_loaded) return;
  _loaded = true;
  try {
    if (!fs.existsSync(CLUSTERS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(CLUSTERS_FILE, 'utf8')) as ClustersFile;
    if (parsed?.version === 1 && Array.isArray(parsed.clusters)) {
      for (const c of parsed.clusters) {
        _clusters.set(c.fingerprint, c);
      }
    }
  } catch { /* start fresh */ }
}

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const clusters = Array.from(_clusters.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_CLUSTERS);
    fs.writeFileSync(CLUSTERS_FILE, JSON.stringify({ version: 1, clusters }), 'utf8');
  } catch { /* non-fatal */ }
}

/** Produce a stable structural fingerprint from a causal chain. */
function computeStructuralFingerprint(
  chain: CausalEvent[],
  networkStatuses: number[],
): { fingerprint: string; pattern: string } {
  const kinds = chain.map((e) => e.kind);
  const statusStr = networkStatuses.slice(0, 6).join(',');
  const kindStr = kinds.join(',');
  const input = `${kindStr}|${statusStr}`;
  const fingerprint = createHash('sha256').update(input).digest('hex').slice(0, 16);
  // Human-readable pattern for display
  const kindCounts = kinds.reduce<Record<string, number>>((acc, k) => {
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const patternParts = Object.entries(kindCounts).map(([k, n]) => n > 1 ? `${k}×${n}` : k);
  const pattern = patternParts.join(' → ') + (statusStr ? ` [${statusStr}]` : '');
  return { fingerprint, pattern };
}

/**
 * Record a causal chain that fired zero detectors.
 * Called from buildCausalChain when hypotheses.length === 0 after calibration.
 */
export function recordUnclassifiedChain(
  chain: CausalEvent[],
  networkStatuses: number[],
): void {
  load();
  const { fingerprint, pattern } = computeStructuralFingerprint(chain, networkStatuses);
  const now = Date.now();
  const existing = _clusters.get(fingerprint);

  if (existing) {
    existing.count++;
    existing.lastSeen = now;
  } else {
    _clusters.set(fingerprint, {
      fingerprint,
      pattern,
      count: 1,
      firstSeen: now,
      lastSeen: now,
      sample: {
        chainKinds: chain.map((e) => e.kind),
        networkStatuses: networkStatuses.slice(0, 6),
        hasErrors: chain.some((e) => e.kind === 'error'),
        hasNetworkFails: chain.some((e) => e.kind === 'network_fail'),
      },
    });
  }

  persist();
}

/** Return clusters with at least minCount occurrences, sorted by count desc. */
export function getClusters(minCount = 3): UnclassifiedCluster[] {
  load();
  return Array.from(_clusters.values())
    .filter((c) => c.count >= minCount)
    .sort((a, b) => b.count - a.count);
}

export function getAllClusters(): UnclassifiedCluster[] {
  load();
  return Array.from(_clusters.values()).sort((a, b) => b.count - a.count);
}

/** Test-only reset. */
export function _resetClustersForTesting(): void {
  _clusters = new Map();
  _loaded = true;
}