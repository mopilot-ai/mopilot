// Validated text and reasoning indices across harnesses, plus Claude SDK stream-event translation.
export const TEXT_METHODS: ReadonlySet<string>;
export const MAX_REASONING_PARTS: number;
export function isInvalidStreamNotification(method: string, params: unknown): boolean;
export function claudeTextDelta(delta: unknown): { method: string; params: { delta: string; summaryIndex?: number } } | null;
