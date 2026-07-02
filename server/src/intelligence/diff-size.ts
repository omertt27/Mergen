/**
 * diff-size.ts — Diff-explosion detector for the CI gate.
 *
 * Scores a PR's raw diff size (files changed, lines added/removed) against
 * static thresholds — no per-repo historical baseline exists yet (that's
 * planned once GET /ci/gate/history lands), so this starts conservative and
 * static rather than adaptive. Follows the same weighted-factor convention as
 * change-risk.ts's scoreChangeRisk() rather than inventing a new pattern:
 * accumulate { label, delta, detail } factors, clamp to 0-100, threshold into
 * LOW/MEDIUM/HIGH with a requiresApproval cutoff at HIGH.
 */

export type DiffSizeLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface DiffSizeFactor {
  label: string;
  delta: number;
  detail: string;
}

export interface DiffSizeReport {
  score: number;
  level: DiffSizeLevel;
  requiresApproval: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
  totalLines: number;
  factors: DiffSizeFactor[];
  recommendation: string;
}

/** Static thresholds — not yet baselined per-repo. A typical focused PR is
 *  well under both; these flag the tail, not the median. */
const LARGE_DIFF_LINES = 500;
const LARGE_FILE_COUNT = 20;

export function evaluateDiffSize(
  stats: { filesChanged: number; additions: number; deletions: number },
  context: { actorIsAi: boolean },
): DiffSizeReport {
  const factors: DiffSizeFactor[] = [];
  let score = 0;
  const totalLines = Math.max(0, stats.additions) + Math.max(0, stats.deletions);
  const filesChanged = Math.max(0, stats.filesChanged);

  // ── Total changed lines ───────────────────────────────────────────────────
  if (totalLines > LARGE_DIFF_LINES) {
    const over = totalLines - LARGE_DIFF_LINES;
    const delta = Math.min(60, 20 + Math.floor(over / 100) * 10);
    score += delta;
    factors.push({ label: 'Large diff', delta, detail: `${totalLines} changed lines (threshold: ${LARGE_DIFF_LINES})` });
  }

  // ── Files touched ──────────────────────────────────────────────────────────
  if (filesChanged > LARGE_FILE_COUNT) {
    const delta = Math.min(30, (filesChanged - LARGE_FILE_COUNT) * 2);
    score += delta;
    factors.push({ label: 'Many files touched', delta, detail: `${filesChanged} files (threshold: ${LARGE_FILE_COUNT})` });
  }

  // ── AI-authored upgrade ────────────────────────────────────────────────────
  // A human PR this size usually reflects deliberate, reviewed scope. The same
  // size from an agent is a weaker signal of deliberate scoping and a
  // stronger signal of scope creep or a misfired autonomous edit — worth
  // extra scrutiny, matching the actorType:'ai' precedent already used
  // throughout enterprise-policy-engine.ts's other conditions.
  if (context.actorIsAi && totalLines > LARGE_DIFF_LINES) {
    const delta = 20;
    score += delta;
    factors.push({ label: 'AI-authored large diff', delta, detail: 'Agent-authored changes above the size threshold get extra scrutiny' });
  }

  const clampedScore = Math.min(100, score);
  const level: DiffSizeLevel = clampedScore >= 70 ? 'HIGH' : clampedScore >= 40 ? 'MEDIUM' : 'LOW';
  const requiresApproval = clampedScore >= 70;

  const recommendation = requiresApproval
    ? 'This diff is unusually large for a single PR — split it into smaller, independently reviewable changes, or get explicit human sign-off before merging.'
    : level === 'MEDIUM'
      ? 'This diff is larger than typical — a closer review is recommended before merging.'
      : 'Diff size is within normal range.';

  return {
    score: clampedScore,
    level,
    requiresApproval,
    filesChanged,
    additions: Math.max(0, stats.additions),
    deletions: Math.max(0, stats.deletions),
    totalLines,
    factors,
    recommendation,
  };
}
