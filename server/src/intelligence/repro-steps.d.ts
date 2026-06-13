export interface ReproResult {
  confidence: string | number;
  markdown:   string;
  steps:      string[];
}

export declare function generateReproSteps(...args: unknown[]): ReproResult;