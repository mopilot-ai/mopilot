// Types for own-property access to JSON-shaped records with opaque keys.
export function recordValue<T>(record: Record<string, T>, key: string): T | undefined;
export function setRecordValue<T>(record: Record<string, T>, key: string, value: T): void;
