// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VerdictDimension = string;
export declare const CALIBRATION_CONFIG: Record<string, unknown>;
export declare function recordVerdict(...args: unknown[]): void;
export declare function getStats(): unknown;
export declare function getGlobalStats(): unknown;
export declare function getStatsForTag(tag: string): unknown;
export declare function getRecords(): unknown[];
export declare function exportCsv(): string;
export declare function getPendingFeedback(): unknown[];
export declare function applyCalibration(hypotheses: unknown[]): unknown[];
export declare function recordPrediction(...args: unknown[]): string;
export declare function seedCalibration(...args: unknown[]): void;