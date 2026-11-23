// Types for the send cache that remembers in-flight and accepted sends by request id (shared/sendOnce.mjs).
export function sendOnce<T>(o?: {
  keep?: number;
  accepted?: (result: T) => boolean;
}): ((key: string, dispatch: () => T | Promise<T>) => Promise<T>) & { sends: Map<string, Promise<T>> };
