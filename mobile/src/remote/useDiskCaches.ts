// What the phone keeps on disk for the chats it shows (the sealed rows and the attached pictures), held to the account and computer in use: bound at sign-in, and pruned to what the computer's own list still has.
import { useEffect } from 'react';
import type { ChatCache } from '../presentation/chatCache';
import type { PictureCache } from '../presentation/pictureCache';
import { forgetRow, recentChatIds } from '../presentation/threadCache';
import { bindPictureDisk } from './messageImage';

const prune = (cache: { prune: (keep: (key: string) => boolean) => Promise<void> } | null, keep: (key: string) => boolean) =>
  void cache?.prune(keep).catch(() => undefined);

export function useDiskCaches(o: {
  rowCache: ChatCache | null;
  pictureCache: PictureCache | null;
  chats: { id: string }[] | null | undefined;
  /** the computer's whole, fresh list was read: the truth about which chats exist */
  whole: boolean;
  account: string | undefined;
  pair: string | null;
}) {
  const { rowCache, pictureCache, chats, whole, account, pair } = o;
  // the pictures a chat shows are kept for this account and computer: another account or computer never reads them
  useEffect(() => {
    bindPictureDisk(pictureCache && account && pair ? { cache: pictureCache, account, pair } : null);
    // another account's pictures go once this one is in
    if (account) prune(pictureCache, (key) => (JSON.parse(key) as string[])[0] === account);
    return () => bindPictureDisk(null);
  }, [pictureCache, account, pair]);
  // a saved chat the computer no longer lists was deleted there
  useEffect(() => {
    if (!rowCache || !chats || !whole) return;
    const ids = new Set(chats.map((c) => c.id));
    const mine = JSON.stringify([account, pair]).slice(1, -1);
    const kept = (key: string) => !key.startsWith(`[${mine},`) || ids.has((JSON.parse(key) as string[])[2]);
    prune(rowCache, kept);
    prune(pictureCache, kept);
    for (const id of recentChatIds(`[${mine},`)) if (!ids.has(id)) forgetRow(JSON.stringify([account, pair, id]));
  }, [rowCache, pictureCache, chats, whole, account, pair]);
}
