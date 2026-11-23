// Types for shared/userError.mjs: an error's readable text and the short sentence a person sees.
export function describeError(error: unknown): string;
export function errorText(error: unknown): string;
export const UNKNOWN_ERROR: string;
export function userError(error: unknown, o?: { fallback?: string; who?: string }): string;
