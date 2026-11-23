// Types for Chromium's network errors in words (netErrors.mjs).
export function netErrorName(code: number | null, description?: string): string;
export function netErrorMessage(name: string): string | null;
export function isResubmitError(name: string): boolean;
export function netErrorNote(name: string, what: string, lead?: string): string;
