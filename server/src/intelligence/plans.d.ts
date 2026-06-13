export type PlanId = string;

export interface Plan {
  bufferSize:              number;
  name:                    string;
  backendObservability:    boolean;
  [key: string]:           unknown;
}

export declare const PLANS: Record<string, Plan>;
export declare function getPlan(planId?: string): Plan;