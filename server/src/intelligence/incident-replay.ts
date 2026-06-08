/**
 * incident-replay.ts — Deterministic replay of past incident analyses.
 *
 * Why this exists:
 *   Every "Mergen diagnosed this correctly" claim is anecdotal without a way
 *   to re-run the same telemetry through the current detector set. This module
 *   stores the exact telemetry snapshot that was used for each incident, then
 *   lets you replay it against the current causal engine to see if the diagnosis
 *   has drifted.
 *
 *   Use cases:
 *     - Regression testing: "Did my new detector break anything on past incidents?"
 *     - Audit: "What data did Mergen see when it made this call?"
 *     - Confidence building: "Show me 10 past incidents where Mergen was right."
 *
 * Storage: ~/.mergen/replay-snapshots/<pid>.json
 *   One file per incident. Bounded to MAX_SNAPSHOTS (500) most-recent files;
 *   oldest file (by mtime) is evicted when the cap is exceeded.
 *
 * POST /incidents/:pid/replay  — run the replay
 * GET  /incidents/replay-snapshots — list available pids
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../sensor/paths.js';
import { buildCausalChain } from './causal.js';
import logger from '../sensor/logger.js';
import type {
  ConsoleEvent,
  NetworkEvent,
  ContextSnapshot,
  TerminalOutputEvent,
  ProcessExitEvent,
  CIEvent,
  DeploymentEvent,
} from '../sensor/buffer.js';
import type { InfraEvent } from '../sensor/infra-normalizer.js';

const REPLAY_DIR    = path.join(DATA_DIR, 'replay-snapshots');
const MAX_SNAPSHOTS = 500;

export interface ReplaySnapshot {
  pid: string;
  capturedAt: number;
  firedAt: number;
  logs: ConsoleEvent[];
  network: NetworkEvent[];
  contexts: ContextSnapshot[];
  terminal: TerminalOutputEvent[];
  processExits: ProcessExitEvent[];
  ciEvents: CIEvent[];
  deployments: DeploymentEvent[];
  infraEvents: InfraEvent[];
  originalTag: string | null;
  originalConfidenceScore: number | null;
  originalFixHint: string | null;
}

export interface ReplayResult {
  pid: string;
  originalHypothesis: {
    tag: string | null;
    confidenceScore: number | null;
    fixHint: string | null;
  };
  replayedHypothesis: {
    tag: string | null;
    confidenceScore: number | null;
    fixHint: string | null;
  };
  drift: {
    topTagChanged: boolean;
    confidenceDelta: number | null;
    fixHintChanged: boolean;
    summary: string;
  };
  replayedAt: string;
}

/**
 * Persist the telemetry snapshot used to analyze an incident.
 * Called immediately after buildCausalChain resolves.
 * Evicts the oldest snapshot when MAX_SNAPSHOTS is exceeded.
 */
export function captureSnapshot(snapshot: ReplaySnapshot): void {
  try {
    fs.mkdirSync(REPLAY_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(REPLAY_DIR, `${snapshot.pid}.json`),
      JSON.stringify(snapshot),
      'utf8',
    );
    // Evict oldest when over the cap
    const files = fs.readdirSync(REPLAY_DIR).filter((f) => f.endsWith('.json'));
    if (files.length > MAX_SNAPSHOTS) {
      const withMtime = files.map((f) => {
        try {
          return { f, mtime: fs.statSync(path.join(REPLAY_DIR, f)).mtimeMs };
        } catch {
          return { f, mtime: 0 };
        }
      });
      withMtime.sort((a, b) => a.mtime - b.mtime);
      for (const { f } of withMtime.slice(0, files.length - MAX_SNAPSHOTS)) {
        try { fs.unlinkSync(path.join(REPLAY_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    logger.warn({ err, pid: snapshot.pid }, 'incident-replay: failed to capture snapshot');
  }
}

/**
 * Re-run the causal engine against a stored telemetry snapshot.
 * Returns null when no snapshot exists for the given pid.
 */
export async function replayIncident(pid: string): Promise<ReplayResult | null> {
  const file = path.join(REPLAY_DIR, `${pid}.json`);
  if (!fs.existsSync(file)) return null;

  let snapshot: ReplaySnapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as ReplaySnapshot;
  } catch (err) {
    logger.warn({ err, pid }, 'incident-replay: corrupt snapshot file');
    return null;
  }

  let replayedTag: string | null = null;
  let replayedScore: number | null = null;
  let replayedHint: string | null = null;

  try {
    const causal = await buildCausalChain(
      snapshot.logs,
      snapshot.network,
      snapshot.contexts,
      snapshot.firedAt,
      snapshot.terminal,
      snapshot.processExits,
      snapshot.ciEvents,
      snapshot.deployments,
      snapshot.infraEvents,
    );
    const top = causal.hypotheses[0] ?? null;
    replayedTag   = top?.tag ?? null;
    replayedScore = top?.confidenceScore ?? null;
    replayedHint  = top?.fixHint ?? null;
  } catch (err) {
    logger.warn({ err, pid }, 'incident-replay: replay analysis threw — returning partial result');
  }

  const topTagChanged   = replayedTag !== snapshot.originalTag;
  const fixHintChanged  = replayedHint !== snapshot.originalFixHint;
  const confidenceDelta = replayedScore !== null && snapshot.originalConfidenceScore !== null
    ? Math.round((replayedScore - snapshot.originalConfidenceScore) * 1000) / 1000
    : null;

  const parts: string[] = [];
  if (topTagChanged) {
    parts.push(`Diagnosis changed: ${snapshot.originalTag ?? 'none'} → ${replayedTag ?? 'none'}`);
  } else {
    parts.push('Same diagnosis');
  }
  if (confidenceDelta !== null && Math.abs(confidenceDelta) >= 0.01) {
    parts.push(`Confidence ${confidenceDelta >= 0 ? '+' : ''}${(confidenceDelta * 100).toFixed(1)}pp`);
  }
  if (fixHintChanged) parts.push('Fix hint changed');

  return {
    pid,
    originalHypothesis: {
      tag:            snapshot.originalTag,
      confidenceScore: snapshot.originalConfidenceScore,
      fixHint:        snapshot.originalFixHint,
    },
    replayedHypothesis: {
      tag:            replayedTag,
      confidenceScore: replayedScore,
      fixHint:        replayedHint,
    },
    drift: {
      topTagChanged,
      confidenceDelta,
      fixHintChanged,
      summary: parts.join('. ') + '.',
    },
    replayedAt: new Date().toISOString(),
  };
}

/** Returns the list of incident pids for which a replay snapshot exists. */
export function listSnapshotPids(): string[] {
  try {
    if (!fs.existsSync(REPLAY_DIR)) return [];
    return fs.readdirSync(REPLAY_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}
