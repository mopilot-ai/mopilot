// What a chat's composer holds as attachments, kept while its screen is rebuilt for a new connection: the files, what the Mac confirmed of them, and an upload that was under way comes back as failed, ready to retry.
import type { Item } from './useAttachments';

const kept = new Map<string, Item[]>();

/** What a dropped connection leaves of an upload that was still going. */
export const INTERRUPTED = 'The connection dropped while this was uploading.';

export const recall = (key: string): Item[] =>
  (kept.get(key) ?? []).map((item) => (item.state === 'sending' ? { ...item, state: 'failed', sent: 0, error: INTERRUPTED } : item));

export const remember = (key: string, items: Item[]) => {
  if (items.length) kept.set(key, items);
  else kept.delete(key);
};
