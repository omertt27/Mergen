export type PlanId = string;
export type ToolTier = 'free' | 'pro' | 'all';

export interface Plan {
  bufferSize:              number;
  name:                    string;
  backendObservability:    boolean;
  [key: string]:           unknown;
}

export declare const PLANS: Record<string, Plan>;
export declare function getPlan(planId?: string): Plan;
export declare function planAllowsTier(planId: string | undefined, tier: ToolTier): boolean;