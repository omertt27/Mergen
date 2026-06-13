export interface UsageSnapshot {
  planName:               string;
  planId:                 string;
  month:                  string;
  resetsAt:               number;
  used:                   number;
  included:               number | null;
  remaining:              number;
  lowCredits:             boolean;
  overage:                number;
  overageCentsPerCredit:  number;
  estimatedOverageCents:  number;
  billingStatus:          string;
  helpfulRate7d:          number | null;
  [key: string]:          unknown;
}

export interface CreditResult {
  allowed:        boolean;
  reason?:        string;
  notice?:        string;
  [key: string]:  unknown;
}

export declare function getUsageSnapshot(): UsageSnapshot;
export declare function getIncidentCount(): number;
export declare function recordExplainWhyFeedback(...args: unknown[]): Promise<void>;
export declare function initUsage(): Promise<void>;
export declare function flushOverageOnShutdown(): Promise<void>;
export declare function consumeCredit(...args: unknown[]): Promise<CreditResult>;
export declare function consumeIncident(...args: unknown[]): Promise<CreditResult>;
export declare function recordExplainWhy(...args: unknown[]): void;
export declare function _resetForTesting(override?: Record<string, unknown>): void;
export declare function _setSleepForTesting(fn: unknown): void;