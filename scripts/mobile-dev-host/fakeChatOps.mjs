// What the stand-in Mac does to a chat when a phone asks (electron/app/phoneChatOps.cjs, app/phoneSideChat.cjs): rename it, archive or restore it, and fork a side chat from it.

/** @param {{ chats: Map<string, any>, add: (chat: any) => any, log: (line: string) => void, now: () => number }} o the stand-in's chats and how it makes one */
export function fakeChatOps({ chats, add, log, now }) {
  const known = (/** @type {string} */ id) => {
    if (!chats.has(id)) throw new Error("That chat isn't in MoPilot.");
    return chats.get(id);
  };
  let sideChats = 0;
  /** The side chat each chat has made: one per chat, as the Mac's. */
  const forks = new Map();
  return {
    renameChat: async (/** @type {string} */ id, /** @type {string} */ title) => {
      known(id).title = title;
      log(`app: ${id} renamed "${title}"`);
    },
    archiveChat: async (/** @type {string} */ id, /** @type {boolean} */ archived) => {
      known(id).archived = archived;
      log(`app: ${id} ${archived ? 'archived' : 'restored'}`);
    },
    // an unlisted temporary chat (in no list, but a phone may follow it and send to it, unlike MoMo's hidden one), the same one when asked again; a basic (ACP) agent has none
    sideChat: async (/** @type {string} */ id) => {
      const parent = known(id);
      if (forks.has(id)) return forks.get(id);
      if (parent.harness.startsWith('acp'))
        throw Object.assign(new Error("Side chats aren't available for this agent."), { code: 'side_chat_unavailable' });
      sideChats += 1;
      const side = add({ id: `${id}-side-${sideChats}`, title: 'Side chat', harness: parent.harness, at: now(), unlisted: true });
      forks.set(id, side.id);
      log(`app: ${id} forked a side chat ${side.id}`);
      return side.id;
    },
  };
}
