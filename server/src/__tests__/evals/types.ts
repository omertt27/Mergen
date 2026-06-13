import type { InfraEvent } from '../../sensor/infra-normalizer.js';
import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from '../../sensor/buffer.js';

export interface InfraFixture {
  name: string;
  events: InfraEvent[];
  expected: {
    tag: string;
    confidenceMin: number;
    shouldFire: boolean;
  };
}

export interface BrowserFixture {
  name: string;
  errors: ConsoleEvent[];
  networks: NetworkEvent[];
  contexts: ContextSnapshot[];
  expected: {
    topTag: string;
    confidenceScoreMin: number;
  };
}

/** One entry in the production replay corpus. */
export interface CorpusEntry {
  events: InfraEvent[];
  expectedTag: string;
  verdict: 'correct' | 'wrong' | 'partial';
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  accuracyPct: number;
  failures: Array<{ name: string; expected: string; actual: string | null }>;
}