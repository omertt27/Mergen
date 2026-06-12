/**
 * Open-source stub for the closed-source causal analysis module.
 * The real implementation (gitignored) performs LLM-assisted root-cause
 * analysis and hypothesis ranking.  Tests replace this with vi.doMock().
 */

export interface Hypothesis {
  tag:                   string;
  summary:               string;
  confidence:            'low' | 'medium' | 'high';
  confidenceScore:       number;
  causalPath:            string[];
  evidence:              string[];
  fixHint:               string;
  fixAction:             string | null;
  remediationConfidence: number;
}

export interface CausalChain {
  hypotheses: Hypothesis[];
}

export function buildCausalChain(..._args: unknown[]): Promise<CausalChain> {
  throw new Error('causal analysis is not available in this build');
}

export function fixActionToCommand(_action: string | null): string | null {
  return null;
}