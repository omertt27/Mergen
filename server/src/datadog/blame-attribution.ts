/**
 * blame-attribution.ts — Move 1: Confidence-Scored Causal Blame Attribution.
 *
 * Computes a 0.0–1.0 confidence score for "deploy X caused incident Y" by
 * combining three independent signals:
 *
 *   Timing     (0.40 weight) — how tight is the window between deploy and incident?
 *   SHA match  (0.30 weight) — does the browser buildSha match the deploy SHA?
 *   File overlap (0.30 weight) — does the implicated file appear in the deploy's diff?
 *
 * Every score comes with a "why I think this" breakdown — engineers see the
 * inputs, not just the number. A score < 0.60 is flagged LOW_CONFIDENCE and
 * Mergen asks rather than acts.
 *
 * Accuracy feedback loop:
 *   When a resolved incident's fix PR SHA matches the attributed SHA, that's
 *   a validation event. Over time this surfaces attribution drift and lets
 *   weights be tuned per org.
 */

import { execSync } from 'child_process';
import path from 'path';
import type { DeploymentEvent } from '../sensor/buffer.js';
import logger from '../sensor/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BlameSignal {
  score: number;       // 0.0–1.0 for this signal alone
  weight: number;      // contribution to total confidence
  contribution: number; // score * weight
  detail: string;      // human-readable: what data was used, what was found
  available: boolean;  // false when the data needed is missing
}

export interface BlameCandidate {
  sha: string;
  deployedAt: number;
  environment: string;
  prUrl: string | null;
}

export interface BlameAttribution {
  confidence: number;           // 0.0–1.0
  confidenceLabel: 'HIGH' | 'MEDIUM' | 'LOW';
  topCandidate: BlameCandidate | null;
  signals: {
    timing: BlameSignal;
    shaMatch: BlameSignal;
    fileOverlap: BlameSignal;
  };
  explanation: string;          // one-paragraph narrative
  lowConfidence: boolean;       // confidence < LOW_CONFIDENCE_THRESHOLD
  changedFiles: string[];       // files changed in the attributed deploy (if available)
}

const HIGH_CONFIDENCE = 0.80;
const LOW_CONFIDENCE  = 0.60;

// When all three signals fire, corroboration earns a small bonus.
const ALL_SIGNALS_BONUS = 0.05;

// Timing alone is noisy (high-traffic services always have errors within minutes
// of any deploy). Cap single-timing attributions so they never reach HIGH.
const TIMING_ONLY_CAP = 0.55;

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Given incident metadata and a list of deploy candidates, compute which deploy
 * most likely caused the incident, and how confident we are.
 */
export function computeBlameAttribution(opts: {
  implicatedFile: string | null;
  deployedSha: string | null;      // SHA from browser buildSha or Datadog span
  firedAt: number;                 // incident timestamp (unix ms)
  candidates: DeploymentEvent[];   // deployment events from the ring buffer
  prUrl?: string | null;           // GitHub PR URL (for display)
}): BlameAttribution | null {
  const { implicatedFile, deployedSha, firedAt, candidates, prUrl } = opts;

  // Filter to deploys that happened before the incident (causal constraint)
  const priorDeploys = candidates
    .filter((d) => d.timestamp <= firedAt && d.status === 'success')
    .sort((a, b) => b.timestamp - a.timestamp); // most recent first

  if (priorDeploys.length === 0) {
    return null; // no deploy data — can't attribute
  }

  // Evaluate each candidate and pick the best
  const scored = priorDeploys.slice(0, 5).map((deploy) => ({
    deploy,
    attribution: _scoreCandidate({ deploy, implicatedFile, deployedSha, firedAt }),
  }));

  // Sort by confidence descending
  scored.sort((a, b) => b.attribution.confidence - a.attribution.confidence);
  const best = scored[0];
  if (!best) return null;

  return {
    ...best.attribution,
    topCandidate: {
      sha: best.deploy.sha,
      deployedAt: best.deploy.timestamp,
      environment: best.deploy.environment,
      prUrl: prUrl ?? best.deploy.url ?? null,
    },
  };
}

// ── Signal computation ────────────────────────────────────────────────────────

function _scoreCandidate(opts: {
  deploy: DeploymentEvent;
  implicatedFile: string | null;
  deployedSha: string | null;
  firedAt: number;
}): Omit<BlameAttribution, 'topCandidate'> {
  const { deploy, implicatedFile, deployedSha, firedAt } = opts;

  const timing      = _timingSignal(deploy.timestamp, firedAt);
  const shaMatch    = _shaMatchSignal(deployedSha, deploy.sha);
  const changedFiles = _getChangedFiles(deploy.sha);
  const fileOverlap  = _fileOverlapSignal(implicatedFile, changedFiles);

  const timingFired   = timing.available   && timing.score   > 0;
  const shaFired      = shaMatch.available  && shaMatch.score  > 0;
  const overlapFired  = fileOverlap.available && fileOverlap.score > 0;
  const signalsFired  = [timingFired, shaFired, overlapFired].filter(Boolean).length;

  let confidence = timing.contribution + shaMatch.contribution + fileOverlap.contribution;

  // All three signals corroborate → corroboration bonus
  if (signalsFired === 3) confidence = Math.min(1.0, confidence + ALL_SIGNALS_BONUS);

  // Timing is the only signal available → noisy, cap it
  // (high-traffic services always have errors within minutes of any deploy)
  if (timingFired && !shaFired && !overlapFired) confidence = Math.min(confidence, TIMING_ONLY_CAP);

  const confidenceLabel: BlameAttribution['confidenceLabel'] =
    confidence >= HIGH_CONFIDENCE ? 'HIGH' :
    confidence >= LOW_CONFIDENCE  ? 'MEDIUM' : 'LOW';

  const explanation = _buildExplanation({ deploy, timing, shaMatch, fileOverlap, confidence, signalsFired, firedAt });

  return {
    confidence: Math.min(1.0, confidence),
    confidenceLabel,
    signals: { timing, shaMatch, fileOverlap },
    explanation,
    lowConfidence: confidence < LOW_CONFIDENCE,
    changedFiles,
  };
}

// ── Signal: Timing ────────────────────────────────────────────────────────────

function _timingSignal(deployedAt: number, firedAt: number): BlameSignal {
  const WEIGHT = 0.40;
  const deltaMs = firedAt - deployedAt;
  const deltaSec = deltaMs / 1000;
  const deltaMin = deltaMs / 60_000;

  let score: number;
  let detail: string;

  if (deltaMin < 2) {
    score = 1.0;
    detail = `deploy merged ${Math.round(deltaSec)}s before first error — extremely tight window`;
  } else if (deltaMin < 5) {
    score = 0.80;
    detail = `deploy merged ${Math.round(deltaMin)}m before first error — very tight window`;
  } else if (deltaMin < 15) {
    score = 0.55;
    detail = `deploy merged ${Math.round(deltaMin)}m before first error — plausible window`;
  } else if (deltaMin < 30) {
    score = 0.30;
    detail = `deploy merged ${Math.round(deltaMin)}m before first error — possible but loose`;
  } else {
    score = 0.05;
    detail = `deploy merged ${Math.round(deltaMin)}m before first error — weak temporal link`;
  }

  return { score, weight: WEIGHT, contribution: score * WEIGHT, detail, available: true };
}

// ── Signal: SHA match ─────────────────────────────────────────────────────────

function _shaMatchSignal(incidentSha: string | null, deploySha: string): BlameSignal {
  const WEIGHT = 0.30;

  if (!incidentSha) {
    return {
      score: 0, weight: WEIGHT, contribution: 0,
      detail: 'no buildSha in incident — browser events lack git SHA or Datadog span missing git.commit.sha',
      available: false,
    };
  }

  // Allow short-SHA prefix matching (7-char short SHA vs full SHA)
  const matches = deploySha === incidentSha ||
    deploySha.startsWith(incidentSha) ||
    incidentSha.startsWith(deploySha);

  if (matches) {
    return {
      score: 1.0, weight: WEIGHT, contribution: WEIGHT,
      detail: `browser buildSha \`${incidentSha.slice(0, 8)}\` matches deploy SHA — confirmed same artifact`,
      available: true,
    };
  }

  return {
    score: 0, weight: WEIGHT, contribution: 0,
    detail: `browser buildSha \`${incidentSha.slice(0, 8)}\` does not match deploy SHA \`${deploySha.slice(0, 8)}\` — different artifact`,
    available: true,
  };
}

// ── Signal: File overlap ──────────────────────────────────────────────────────

function _fileOverlapSignal(implicatedFile: string | null, changedFiles: string[]): BlameSignal {
  const WEIGHT = 0.30;

  if (!implicatedFile) {
    return {
      score: 0, weight: WEIGHT, contribution: 0,
      detail: 'no implicated file from stack trace — sourcemap resolution unavailable',
      available: false,
    };
  }

  if (changedFiles.length === 0) {
    return {
      score: 0, weight: WEIGHT, contribution: 0,
      detail: 'git diff unavailable — cannot check file overlap (no git repo or SHA not found)',
      available: false,
    };
  }

  const basename = path.basename(implicatedFile);
  const implicatedDir = path.dirname(implicatedFile).split('/').filter(Boolean).pop() ?? '';

  // Exact path match
  for (const f of changedFiles) {
    if (f === implicatedFile || f.endsWith('/' + implicatedFile) || implicatedFile.endsWith('/' + f)) {
      return {
        score: 1.0, weight: WEIGHT, contribution: WEIGHT,
        detail: `\`${f}\` in deploy diff — exact match with implicated file \`${implicatedFile}\``,
        available: true,
      };
    }
  }

  // Same filename, different path (Docker path vs local path mismatch)
  for (const f of changedFiles) {
    if (path.basename(f) === basename) {
      return {
        score: 0.75, weight: WEIGHT, contribution: 0.75 * WEIGHT,
        detail: `\`${f}\` in deploy diff — same filename as implicated \`${basename}\` (path differs, possibly Docker mount)`,
        available: true,
      };
    }
  }

  // Same directory
  for (const f of changedFiles) {
    if (implicatedDir && path.dirname(f).split('/').filter(Boolean).pop() === implicatedDir) {
      return {
        score: 0.35, weight: WEIGHT, contribution: 0.35 * WEIGHT,
        detail: `deploy modified files in \`${implicatedDir}/\` — same directory as implicated file, weak overlap`,
        available: true,
      };
    }
  }

  return {
    score: 0, weight: WEIGHT, contribution: 0,
    detail: `implicated file \`${basename}\` not in deploy diff — different area of codebase changed`,
    available: true,
  };
}

// ── Git helper ────────────────────────────────────────────────────────────────

function _getChangedFiles(sha: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${sha}^..${sha}`, {
      timeout: 5_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    // git not available, SHA not in local repo, or squash merge (no parent)
    // Try single-commit diff as fallback
    try {
      const output = execSync(`git show --name-only --format="" ${sha}`, {
        timeout: 5_000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim().split('\n').filter(Boolean);
    } catch {
      logger.debug({ sha }, 'git diff unavailable for blame attribution');
      return [];
    }
  }
}

// ── Explanation builder ───────────────────────────────────────────────────────

function _buildExplanation(opts: {
  deploy: DeploymentEvent;
  timing: BlameSignal;
  shaMatch: BlameSignal;
  fileOverlap: BlameSignal;
  confidence: number;
  signalsFired: number;
  firedAt: number;
}): string {
  const { deploy, timing, shaMatch, fileOverlap, confidence, signalsFired } = opts;
  const sha8 = deploy.sha.slice(0, 8);
  const pct  = Math.round(confidence * 100);

  const available = [timing, shaMatch, fileOverlap].filter((s) => s.available);
  const strong    = available.filter((s) => s.score >= 0.75);

  let core = `Deploy \`${sha8}\` (${deploy.environment}) — ${pct}% confidence, ${signalsFired}/3 signals fired.`;

  if (signalsFired === 3) {
    core += ' All three signals corroborate: ' + available.map((s) => s.detail).join('; ') + '.';
  } else if (signalsFired === 1 && timing.score > 0 && !shaMatch.score && !fileOverlap.score) {
    core += ' Only timing fired — high-traffic services produce errors near every deploy; treat as weak hypothesis. ' + timing.detail + '.';
  } else if (strong.length > 0) {
    core += ' Strong signals: ' + strong.map((s) => s.detail).join('; ') + '.';
    const weak = available.filter((s) => s.score < 0.75 && s.score > 0);
    if (weak.length) core += ' Weaker signals: ' + weak.map((s) => s.detail).join('; ') + '.';
  } else {
    core += ' Signals: ' + available.map((s) => s.detail).join('; ') + '.';
  }

  const unavailable = [timing, shaMatch, fileOverlap].filter((s) => !s.available);
  if (unavailable.length > 0) {
    core += ` Missing data for: ${unavailable.map((s, i) => ['timing', 'shaMatch', 'fileOverlap'][i]).join(', ')}.`;
  }

  if (confidence < LOW_CONFIDENCE) {
    core += ' Confidence below threshold — recommend manual investigation before acting.';
  }

  return core;
}

// ── Accuracy tracking ─────────────────────────────────────────────────────────

/**
 * Called when an incident is resolved. Returns true if the fix PR SHA matches
 * the attributed deploy SHA — this is a positive accuracy validation.
 */
export function validateAttribution(attributedSha: string | null, fixSha: string | null): boolean | null {
  if (!attributedSha || !fixSha) return null;
  return attributedSha.startsWith(fixSha) || fixSha.startsWith(attributedSha);
}
