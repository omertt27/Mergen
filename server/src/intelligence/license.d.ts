export interface LicenseState {
  customerEmail?: string;
  validatedAt?:   string;
  [key: string]:  unknown;
}

export declare function getLicenseState(): LicenseState;
export declare function activateKey(key: string): Promise<Record<string, unknown>>;
export declare function deactivateKey(): Promise<void>;
export declare function getActivePlanId(): string;
export declare function initLicense(): Promise<void>;
export declare function planFromVariantId(variantId: string): string;