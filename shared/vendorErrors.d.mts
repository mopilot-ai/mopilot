import type { SkyProblemKind } from './skyComputerUse.mjs';

export type VendorErrorSource = 'sky' | 'browserUse' | 'claudeInChrome' | 'yourChrome';

export interface VendorErrorRow {
  kind: SkyProblemKind;
  source: VendorErrorSource;
  name: string | null;
  codes: readonly string[];
  wordings: readonly RegExp[];
}

export const VENDOR_SOURCES: Readonly<{
  cua: readonly VendorErrorSource[];
  claudeInChrome: readonly VendorErrorSource[];
  yourChrome: readonly VendorErrorSource[];
}>;
export const VENDOR_ERRORS: readonly VendorErrorRow[];
export const SKY_ERRORS_WITHOUT_STATE: readonly string[];
export function vendorErrorByCode(codes: (string | null | undefined)[], sources: readonly string[]): VendorErrorRow | null;
export function vendorErrorByWording(text: string, sources: readonly string[]): { row: VendorErrorRow; index: number } | null;
export const SKY_MODEL_RECOVERS: readonly RegExp[];
export const CHROME_LINK_DOWN: readonly SkyProblemKind[];
export function chromeLinkDown(text: unknown): boolean;
