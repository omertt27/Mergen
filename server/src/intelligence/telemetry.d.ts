export declare function getTelemetryState(): Record<string, unknown>;
export declare function setTelemetryEnabled(enabled: boolean): Promise<void>;
export declare function initTelemetry(): Promise<void>;
export declare function maybeSendTelemetry(payload?: Record<string, unknown>): Promise<void>;
export declare function uploadCalibrationBatch(): Promise<void>;