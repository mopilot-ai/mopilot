// Every window hears a change to a chat's config, notes or login, whoever made it. Main writes them too (a turn's kept model
// and effort, a harness switch, a login move, a refusal note), and the window that sent a change hears the chat main merged
// it into, so no window keeps showing a copy older than what the chat runs on (#2520).

/** What a window must not miss about a chat. */
const keyOf = (meta) => JSON.stringify([meta?.config ?? null, meta?.notes ?? null, meta?.account ?? null, meta?.rewoundAt ?? null]);

/**
 * @param {{ broadcast: (id: string, chat: unknown) => void, get: (id: string) => unknown, failed: (what: string, error: unknown) => void,
 *   defer?: (fn: () => void) => void }} o `broadcast` sends one chat to every window; `failed` is where a send that fails
 *   goes; `defer` runs the sends once the current changes are done (a microtask)
 */
function createChatMetaBroadcast({ broadcast, get, failed, defer = queueMicrotask }) {
  /** chat id -> keyOf its meta as windows last heard it */
  const heard = new Map();
  /** chats to send once this turn of changes is done: several changes to one chat go as one */
  const pending = new Set();
  // taken before sending: a send that fails (a window going away) costs only its own chat, never the later ones
  const flush = () => {
    const ids = [...pending];
    pending.clear();
    for (const id of ids)
      try {
        broadcast(id, get(id));
      } catch (error) {
        failed("tell the windows about a chat's changed settings", error);
      }
  };
  return {
    /** The chat as the windows load it at startup. */
    seed(id, meta) {
      heard.set(id, keyOf(meta));
    },
    /** A chat changed (ChatsStore onChange): `v` is its view, null once it is gone. */
    changed(id, v) {
      const key = keyOf(v?.meta);
      if (heard.get(id) === key) return;
      heard.set(id, key);
      if (!v) return;
      if (!pending.size) defer(flush);
      pending.add(id);
    },
  };
}

module.exports = { createChatMetaBroadcast };
