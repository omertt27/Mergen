export type FixAction = string | { type: string; target: string; method: string; [key: string]: unknown } | null;

export interface CausalEvent {
  kind:     string;
  ts:       number;
  isoTs:    string;
  summary:  string;
  detail?:  string;
  source?:  string;
}

export interface NetworkEvent {
  url:           string;
  status?:       number;
  error?:        string;
  traceId?:      string;
  msBeforeError: number | null;
  [key: string]: unknown;
}

export interface ErrorBlock {
  timestamp:      number;
  message:        string;
  primaryFrame?:  { file?: string; [key: string]: unknown } | null;
  resolvedStack?: string;
}

export interface StateAtError {
  component?:   string;
  localStorage?: Record<string, string>;
  [key: string]: unknown;
}

export interface Hypothesis {
  pid?:                  string;
  tag:                   string;
  summary:               string;
  confidence:            string;
  confidenceScore:       number;
  causalPath:            string[];
  evidence:              string[];
  fixHint:               string | null;
  fixAction?:            FixAction;
  remediationConfidence?: number;
  [key: string]:         unknown;
}

export interface CausalChain {
  chain:                CausalEvent[];
  hypotheses:           Hypothesis[];
  suppressedHypotheses: Hypothesis[];
  contextPack:          string;
  errors:               ErrorBlock[];
  capturedAt:           number;
  correlatedNetwork:    NetworkEvent[];
  correlatedBackend:    unknown[];
  errorFingerprint?:    string;
  stateAtError?:        StateAtError | null;
}

export declare function buildCausalChain(...args: unknown[]): Promise<CausalChain>;
export declare function fixActionToCommand(action: FixAction): string | null;