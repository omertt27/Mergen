export declare function getLicenseState(): Record<string, unknown>;
export declare function activateKey(key: string): Promise<Record<string, unknown>>;
export declare function deactivateKey(): Promise<void>;
export declare function getActivePlanId(): string;
export declare function initLicense(): Promise<void>;