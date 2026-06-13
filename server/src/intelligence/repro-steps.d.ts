export interface ReproResult {
  confidence: string | number;
  markdown:   string;
}

export declare function generateReproSteps(...args: unknown[]): ReproResult;