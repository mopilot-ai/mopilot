// MoMo's own chats in a window (chat meta `momo`, kept in the store's momoChats map by lib/chatMeta.ts): no list of
// chats shows them (shared/momoChat.mjs decides the same in main).

/** chat id -> 'main' or 'previous' (electron/momo/mainChat.cjs). */
export type MomoChats = Readonly<Record<string, string>> | undefined;

/** Whether chat `id` is one of MoMo's, which no list of chats shows. */
export const isMomoChat = (momoChats: MomoChats, id: string | null | undefined): boolean =>
  !!id && !!momoChats && Object.hasOwn(momoChats, id);

/**
 * Whether `id` is one of MoMo's chats or a later native session of one (a harness lists a switched chat's segments by
 * their own ids): no list shows either.
 */
export function momoOwned(
  momoChats: MomoChats,
  segments: Readonly<Record<string, readonly { nativeId: string }[]>> | undefined,
  id: string,
) {
  if (isMomoChat(momoChats, id)) return true;
  for (const owner of Object.keys(momoChats ?? {})) if (segments?.[owner]?.some((s) => s.nativeId === id)) return true;
  return false;
}
