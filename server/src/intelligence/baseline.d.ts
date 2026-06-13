export interface AnomalyResult {
  summary:      string;
  multiplier?:  number;
  [key: string]: unknown;
}

export interface AnomalousPattern {
  multiplier:   number;
  fingerprint:  string;
  currentCount: number;
  normalRate:   number;
  [key: string]: unknown;
}

export declare function computeAnomaly(...args: unknown[]): Promise<AnomalyResult>;
export declare function getAnomalousPatterns(...args: unknown[]): Promise<AnomalousPattern[]>;