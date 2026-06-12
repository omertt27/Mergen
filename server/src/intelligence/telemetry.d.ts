export declare function getTelemetryState(): Record<string, unknown>;
export declare function setTelemetryEnabled(enabled: boolean): Promise<void>;
export declare function initTelemetry(): Promise<void>;
export declare function maybeSendTelemetry(): Promise<void>;