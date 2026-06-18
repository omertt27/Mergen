import type { Hypothesis, CausalChain } from './causal.js';

export interface HypothesisHistoryEntry {
  topHypothesis:  Hypothesis | null;
  chain:          CausalChain;
  builtAt:        number;
  builtAtIso:     string;
  triggerMessage: string;
  reason:         string;
  [key: string]:  unknown;
}

export declare function flushPendingRebuild(): Promise<void>;

export declare const hypothesisHistory: {
  list(limit?: number): HypothesisHistoryEntry[];
  latest(): HypothesisHistoryEntry | null;
  clear(): void;
  notifyError(pid?: string, err?: unknown): void;
  add(entry: HypothesisHistoryEntry): void;
  size(): number;
  _rebuildNowForTesting(...args: unknown[]): void;
};
