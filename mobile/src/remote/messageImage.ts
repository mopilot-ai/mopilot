// A picture the user attached to a message, read from the computer when its thumbnail is drawn or opened (messages.image): the message's saved record or the live turn, shrunk to the size asked, kept for the session so a scroll back never asks again.
import type { Owned } from './client';
import { pictureKey, type PictureCache } from '../presentation/pictureCache';

/** The longest side of a thumbnail in the transcript and of the picture the full-screen viewer opens, in pixels. */
export const THUMB_SIDE = 360;
export const FULL_SIDE = 1024;
/** The largest picture kept in memory (base64 characters), well over what the computer sends at those sides. */
const MOST_DATA = 3_000_000;
/** How many pictures are kept; the oldest goes first. */
const KEPT = 48;

let owners = new WeakMap<Owned, Map<string, string>>();
/** The sealed copy on this phone, for the account and computer in use; none while signed out or before the store opens. */
let disk: { cache: PictureCache; account: string; pair: string } | null = null;
/** Only thumbnails are kept on the phone: the full-screen size is read again, and is large. */
const KEPT_ON_DISK_SIDE = 480;

/** Binds the disk copy to the account and computer in use (null: none). */
export function bindPictureDisk(binding: typeof disk) {
  disk = binding;
}
const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

/**
 * The picture as a data URI, or null when there is none to show: the computer sends `{}` for a picture it does not keep, an older
 * computer has no such method, one that is away does not answer, and a reply that is not a picture is not drawn. A failure is not
 * remembered, so the next tap asks again.
 */
export async function readMessageImage(
  request: Owned,
  chatId: string,
  itemId: string,
  index: number,
  side: number,
): Promise<string | null> {
  let kept = owners.get(request);
  if (!kept) owners.set(request, (kept = new Map()));
  const key = JSON.stringify([chatId, itemId, index, side]);
  const hit = kept.get(key);
  if (hit) {
    // used last: it goes last
    kept.delete(key);
    kept.set(key, hit);
    return hit;
  }
  // a picture seen before, on this phone: it draws at once, and the computer is not asked
  const saved = disk && side <= KEPT_ON_DISK_SIDE ? disk : null;
  const diskKey = saved ? pictureKey(saved.account, saved.pair, chatId, itemId, index, side) : '';
  const onDisk = saved ? await saved.cache.load(diskKey).catch(() => null) : null;
  if (onDisk) {
    kept.set(key, onDisk);
    if (kept.size > KEPT) kept.delete(kept.keys().next().value as string);
    return onDisk;
  }
  try {
    const reply = rec(await request('messages.image', { chatId, itemId, index, maxSide: side }));
    const data = typeof reply?.data === 'string' ? reply.data : '';
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > MOST_DATA) return null;
    const uri = `data:image/jpeg;base64,${data}`;
    kept.set(key, uri);
    if (kept.size > KEPT) kept.delete(kept.keys().next().value as string);
    if (saved) void saved.cache.save(diskKey, uri).catch(() => undefined);
    return uri;
  } catch {
    return null;
  }
}

/** Forgets every kept picture in memory (an account leaving the phone, or a test's reset). */
export function forgetMessageImages() {
  owners = new WeakMap();
}
