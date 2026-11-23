// The wire declaration of `host.chats` (feature `chatList`): the chats this Host holds, newest activity first. A read, so it has no epoch and no key; each row carries the chat's current epoch for the requests that follow. Bounded by `limit`, never counted or paged, so nothing about chats a client may not see (the chat veil leaves them out of the rows) can be told by a total or a cursor.
export const CHAT_LIST_FEATURE = 'chatList';
/** The most chats one answer lists (and the default). */
export const CHAT_LIST_MAX = 200;

export default (/** @type {{ bad: (message: string) => Error }} */ kit) => ({
  features: [CHAT_LIST_FEATURE],
  methods: {
    'host.chats': {
      access: /** @type {const} */ ('paired'),
      requires: [CHAT_LIST_FEATURE],
      parse: (/** @type {any} */ p) => {
        const limit = p.limit ?? CHAT_LIST_MAX;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHAT_LIST_MAX)
          throw kit.bad(`A chat list holds 1 to ${CHAT_LIST_MAX} chats.`);
        return { limit };
      },
    },
  },
});
