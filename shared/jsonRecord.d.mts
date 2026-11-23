/** A JSON object record or an explicit parse failure; partial JSONL lines are ordinary failures. */
export function parseJsonRecord(text: string): { ok: true; record: Record<string, unknown> } | { ok: false; error: string };

/** A decoded string field in a potentially incomplete object prefix, or null when absent. */
export function jsonStringField(text: string, key: string): string | null;

/** Narrow an unknown value to an object record, excluding null and arrays. */
export function isJsonRecord(value: unknown): value is Record<string, unknown>;

/** Any JSON value, or an explicit failure for text that is not JSON. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string };
