/**
 * Open-source stub for the closed-source calibration feedback-loop module.
 * The real implementation (gitignored) maintains a verdict corpus and
 * performs Platt scaling on confidence scores.  Tests replace this with vi.doMock().
 */

export const CALIBRATION_CONFIG: Record<string, unknown> = {};

export function getRecords(): unknown[] { return []; }
export function recordVerdict(..._args: unknown[]): { found: boolean; persisted: boolean } {
  return { found: false, persisted: false };
}
export function getStats(): unknown[] { return []; }
export function getGlobalStats(): null { return null; }
export function getStatsForTag(_tag: string): null { return null; }
export function exportCsv(): string { return ''; }
export function getPendingFeedback(): unknown[] { return []; }
export function applyCalibration(hypotheses: unknown[]): { active: unknown[]; suppressed: unknown[] } {
  return { active: hypotheses, suppressed: [] };
}
export function recordPrediction(hypotheses: unknown[]): unknown[] { return hypotheses; }
export function seedCalibration(..._args: unknown[]): void {}
export function _resetForTesting(): void {}