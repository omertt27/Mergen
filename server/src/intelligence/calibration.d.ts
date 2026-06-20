import type { Hypothesis } from './causal.js';

export type VerdictDimension = string;

export interface FailureMode {
  note:  string;
  count: number;
}

export interface CalibrationStat {
  tag:                 string;
  verdicts:            number;
  accuracy:            number;
  trusted:             boolean;
  isEmpirical:         boolean;
  active:              CalibrationStat[];
  suppressed:          CalibrationStat[];
  predictions:         number;
  commonFailureModes:  FailureMode[];
  shouldInterrupt:     boolean;
  diagnosisAccuracy:   number;
  /** Independently measured from fix outcomes. Null when no remediation verdicts recorded yet. */
  remediationAccuracy: number | null;
  trendDelta:          number | null;
  accuracy7d:          number | null;
  [key: string]:       unknown;
}

export interface PredictionRecord {
  pid:              string;
  tag:              string;
  confidence:       string;
  verdict:          string | null;
  errorFingerprint: string | null;
  score?:           number;
  numericScore?:    number;
  [key: string]:    unknown;
}

export type CalibratedHypothesis = Hypothesis & { pid: string; calibrationAction?: string };

export declare const CALIBRATION_CONFIG: Record<string, unknown>;
export declare function recordVerdict(...args: unknown[]): { found: boolean; persisted: boolean };
export declare function getStats(): CalibrationStat[];
export declare function getGlobalStats(): CalibrationStat | null;
export declare function getStatsForTag(tag: string): CalibrationStat | undefined;
export declare function getRecords(): PredictionRecord[];
export declare function exportCsv(): string;
export declare function getPendingFeedback(): Array<{ pid: string; expiresAt: number; [key: string]: unknown }>;
export declare function applyCalibration(hypotheses: Hypothesis[]): { active: CalibratedHypothesis[]; suppressed: CalibratedHypothesis[] };
export declare function recordPrediction(hypotheses: Hypothesis[]): CalibratedHypothesis[];
export declare function seedCalibration(...args: unknown[]): void;
export declare function _resetForTesting(): void;
export declare function isCorpusSeeded(): boolean;
export declare function classifyVerdict(beforeCount: number, afterCount: number): 'correct' | 'partial' | 'wrong';
export declare function recordRemediationVerdict(pid: string, verdict: 'correct' | 'wrong' | 'partial'): { found: boolean; persisted: boolean };