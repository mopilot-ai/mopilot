// What a chat's composer holds as attachments, kept while its screen is rebuilt for a new connection: the files, what the Mac confirmed of them and where each stream stands, so an upload that was under way carries on.
import type { Resume } from './upload';
import type { Item } from './useAttachments';

const kept = new Map<string, Item[]>();
/** Where each item's stream stands (the Mac's stream id and the next part it has not confirmed), kept live: the rebuilt screen carries on from there. */
const streams = new Map<string, Map<number, Resume>>();

/** The streams of `key`'s items, the same map for every screen that holds them. */
export function streamsOf(key: string): Map<number, Resume> {
  let map = streams.get(key);
  if (!map) streams.set(key, (map = new Map()));
  return map;
}

/** What a dropped connection leaves of an upload that was still going. */
export const INTERRUPTED = 'The connection dropped while this was uploading.';

export const recall = (key: string): Item[] =>
  (kept.get(key) ?? []).map((item) => (item.state === 'sending' ? { ...item, state: 'failed', sent: 0, error: INTERRUPTED } : item));

export const remember = (key: string, items: Item[]) => {
  if (items.length) kept.set(key, items);
  else {
    kept.delete(key);
    // emptied, not dropped: a screen that holds the map keeps the same one with the next screen
    streams.get(key)?.clear();
  }
};
