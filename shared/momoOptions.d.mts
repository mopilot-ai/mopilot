// Types for shared/momoOptions.mjs.
export const MIN_OPTIONS: 2;
export const MAX_OPTIONS: 4;
export const MAX_LABEL: 40;
export const OPTIONS_NOTE: string;
export function readOptions(reply: unknown): { text: string; options: string[] };
export function withOptions<T extends { text?: unknown }>(item: T): T | (Omit<T, 'text'> & { text: string; options: string[] });
