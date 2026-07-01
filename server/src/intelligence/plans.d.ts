export type PlanId = string;
export type ToolTier = 'free' | 'pro' | 'all';
export type GateSpec = ToolTier | PlanId;

export interface PlanCapabilities {
  hitlApproval:          boolean;
  overrideCorpusEnforce: boolean;
  ciGate:                boolean;
  agentIam:              boolean;
}
export type PlanCapability = keyof PlanCapabilities;

export interface Plan {
  id:                     string;
  name:                   string;
  rank:                   number;
  bufferSize:             number;
  maxServices:            number;
  backendObservability:   boolean;
  capabilities:           PlanCapabilities;
  [key: string]:          unknown;
}

export declare const PLANS: Record<string, Plan>;
export declare const PLAN_ORDER: readonly string[];
export declare function getPlan(planId?: string): Plan;
export declare function getPlanRank(planId?: string): number;
export declare function planMeetsMin(planId: string | undefined, minPlanId: string): boolean;
export declare function planHasCapability(planId: string | undefined, cap: PlanCapability): boolean;
export declare function minPlanForGate(gate: GateSpec): string;
export declare function planAllowsGate(planId: string | undefined, gate: GateSpec): boolean;
export declare function planAllowsTier(planId: string | undefined, tier: ToolTier): boolean;
