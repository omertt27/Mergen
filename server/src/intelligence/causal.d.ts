export type FixAction = string | null;

export interface CausalEvent {
  kind:     string;
  ts:       number;
  isoTs:    string;
  summary:  string;
  detail?:  string;
  source?:  string;
}

export interface Hypothesis {
  pid:                   string;
  tag:                   string;
  summary:               string;
  confidence:            'low' | 'medium' | 'high';
  confidenceScore:       number;
  causalPath:            string[];
  evidence:              string[];
  fixHint:               string;
  fixAction?:            FixAction;
  remediationConfidence?: number;
}

interface ErrorBlock {
  timestamp:      number;
  primaryFrame?:  unknown;
  resolvedStack?: string;
}

export interface CausalChain {
  chain:                CausalEvent[];
  hypotheses:           Hypothesis[];
  suppressedHypotheses: Hypothesis[];
  contextPack:          string;
  errors:               ErrorBlock[];
  capturedAt:           number;
  correlatedNetwork:    unknown[];
  correlatedBackend:    unknown[];
  errorFingerprint?:    string;
  [key: string]:        unknown;
}

export declare function buildCausalChain(...args: unknown[]): Promise<CausalChain>;
export declare function fixActionToCommand(action: FixAction): string | null;