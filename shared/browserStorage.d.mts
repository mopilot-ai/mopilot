export type BrowserStorageMode = 'shared' | 'session';
export const SHARED_PARTITION: 'persist:browser';
export function storageMode(value: unknown): BrowserStorageMode;
export function browserPartition(storage: unknown, chatId: string | null | undefined): string;
export function isChatPartition(value: unknown): boolean;
