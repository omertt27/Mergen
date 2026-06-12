/**
 * Open-source stub for the closed-source calibration feedback-loop module.
 * The real implementation (gitignored) maintains a verdict corpus and
 * performs Platt scaling on confidence scores.  Tests replace this with vi.doMock().
 */

export function getRecords(): unknown[] { return []; }
export function recordVerdict(..._args: unknown[]): void {}
export function getStatsForTag(_tag: string): null { return null; }
