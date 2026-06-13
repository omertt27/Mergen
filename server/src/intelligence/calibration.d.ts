export type VerdictDimension = string;

export interface CalibrationStat {
  tag:                 string;
  verdicts:            number;
  accuracy:            number;
  trusted:             boolean;
  isEmpirical:         boolean;
  active:              CalibrationStat[];
  suppressed:          CalibrationStat[];
  predictions:         unknown[];
  commonFailureModes:  string[];
  shouldInterrupt:     boolean;
  diagnosisAccuracy:   number;
  remediationAccuracy: number;
  trendDelta:          number | null;
  [key: string]:       unknown;
}

export interface PredictionRecord {
  pid:              string;
  tag:              string;
  confidence:       'low' | 'medium' | 'high';
  verdict:          string | null;
  errorFingerprint: string | null;
  score?:           number;
  [key: string]:    unknown;
}

export declare const CALIBRATION_CONFIG: Record<string, unknown>;
export declare function recordVerdict(...args: unknown[]): { found: boolean; persisted: boolean };
export declare function getStats(): CalibrationStat[];
export declare function getGlobalStats(): CalibrationStat | null;
export declare function getStatsForTag(tag: string): CalibrationStat | undefined;
export declare function getRecords(): PredictionRecord[];
export declare function exportCsv(): string;
export declare function getPendingFeedback(): unknown[];
export declare function applyCalibration(hypotheses: unknown[]): unknown[];
export declare function recordPrediction(...args: unknown[]): { pid: string; tag: string; [key: string]: unknown };
export declare function seedCalibration(...args: unknown[]): void;
export declare function _resetForTesting(): void;