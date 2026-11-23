export const MAX_URL: number;
export const VENDOR_SITES: Record<string, string[]>;
export function openable(link: unknown): string | null;
export function onVendorSite(harness: string, href: string): boolean;
