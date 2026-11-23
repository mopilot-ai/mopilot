// Record-shaped message blocks with typed text fields, retaining original transcript item indices.
export function contentBlockEntries(content: unknown): [number, Record<string, unknown>][];
export function contentBlocks(content: unknown): Record<string, unknown>[];
export function normalizeContentBlock(block: unknown): Record<string, unknown> | null;
