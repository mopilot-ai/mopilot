export function scrub(text: string, opts?: { home?: string }): string;
export function scrubDeep<T>(value: T, opts?: { home?: string }, max?: number): T;
export function redactEnv(env: Record<string, string | undefined>, opts?: { home?: string }): Record<string, string | undefined>;
