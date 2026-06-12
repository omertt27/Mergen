export declare function getUsageSnapshot(): Record<string, unknown>;
export declare function getIncidentCount(): number;
export declare function recordExplainWhyFeedback(...args: unknown[]): Promise<void>;
export declare function initUsage(): Promise<void>;
export declare function flushOverageOnShutdown(): Promise<void>;