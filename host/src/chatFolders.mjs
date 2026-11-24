// Every folder a chat message would run in (R2b of #5576), so the Host can hold each to the folders it allows (./chatEffects.mjs, at `chat.start` and at every `chat.send`): the one the message names, else the one the chat's own record says (asked of the runtime each time, never kept by the Host in a table of its own that a restart or a long list of chats would empty), and a side chat's parent's, whose folder it runs in.

/**
 * @param {{ folderOf?: (chatId: string) => Promise<string | null | undefined> }} runtime
 * @param {{ chatId: string, cwd?: unknown, sideChat?: { sourceId: string } | null }} p a chat request
 * @returns {Promise<string[]>}
 */
export async function chatFoldersOf(runtime, p) {
  /** @type {string[]} */
  const out = [];
  if (typeof p.cwd === 'string') out.push(p.cwd);
  else {
    const own = await runtime.folderOf?.(p.chatId);
    if (own) out.push(own);
  }
  const parent = p.sideChat ? await runtime.folderOf?.(p.sideChat.sourceId) : null;
  if (parent) out.push(parent);
  return out;
}
