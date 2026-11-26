// The wire declaration of `host.chats` (feature `chatList`): the chats this Host holds, newest activity first. A read, so it has no epoch and no key; each row carries the chat's current epoch for the requests that follow. Bounded by `limit` and paged by an opaque cursor (feature `chatPaging`), never counted, so nothing about chats a client may not see (the chat veil leaves them out of the rows before a page is cut) can be told by a total. `host.chats.watch` (feature `chatEvents`) tells the connection of each change to a row as it happens.
import { CHAT_ORIGINS, NATIVE_EVENTS_FEATURE, NATIVE_LIST_FEATURE } from '../nativeChats.mjs';

export const CHAT_LIST_FEATURE = 'chatList';
export const CHAT_PAGING_FEATURE = 'chatPaging';
export const CHAT_EVENTS_FEATURE = 'chatEvents';
/** The most chats one answer lists (and the default). */
export const CHAT_LIST_MAX = 200;

export default (/** @type {{ bad: (message: string) => Error }} */ kit) => ({
  features: [CHAT_LIST_FEATURE, CHAT_PAGING_FEATURE, CHAT_EVENTS_FEATURE, NATIVE_LIST_FEATURE, NATIVE_EVENTS_FEATURE],
  methods: {
    'host.chats': {
      access: /** @type {const} */ ('paired'),
      requires: [CHAT_LIST_FEATURE],
      parse: (/** @type {any} */ p) => {
        const limit = p.limit ?? CHAT_LIST_MAX;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHAT_LIST_MAX)
          throw kit.bad(`A chat list holds 1 to ${CHAT_LIST_MAX} chats.`);
        const cursor = p.cursor;
        if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 300))
          throw kit.bad('That is not a place in this list.');
        const origin = p.origin;
        if (origin !== undefined && !CHAT_ORIGINS.includes(origin))
          throw kit.bad('Chats come from this machine, from its native sessions, or both.');
        // `host` is the default and is never sent on, so an older Host is not asked for it
        return { limit, ...(cursor === undefined ? {} : { cursor }), ...(origin === undefined || origin === 'host' ? {} : { origin }) };
      },
    },
    'host.chats.watch': {
      access: /** @type {const} */ ('paired'),
      requires: [CHAT_EVENTS_FEATURE],
      // `native: true` also tells this connection of native rows (feature `nativeEvents`); without it the events are the Host's own chats' as before
      parse: (/** @type {any} */ p) => {
        if (p.native !== undefined && typeof p.native !== 'boolean') throw kit.bad('That is not a choice of events.');
        return p.native === true ? { native: true } : {};
      },
    },
  },
});
