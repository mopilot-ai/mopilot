// The live output of the commands a chat runs, on the stream's ephemeral lane: shown while the command prints, taking no revision, replaced by the finished call's whole output and retracted when its turn ends without that.

/** @param {{ delta: (chatId: string, key: string, delta: unknown) => number, retract: (chatId: string, key: string) => number }} hub */
export function createLiveOutput(hub) {
  /** The stream keys of the output still live, by chat. @type {Map<string, Set<string>>} */
  const live = new Map();
  /** @param {string} turnId @param {string} toolCallId */
  const keyOf = (turnId, toolCallId) => `${turnId}:out:${toolCallId}`;
  return {
    forget(chatId) {
      live.delete(chatId);
    },
    /** Whether the event is live output, which then went out as a delta and needs no record. @param {string} chatId @param {any} e */
    delta(chatId, e) {
      if (e.kind !== 'update' || e.update?.sessionUpdate !== 'tool_output_delta') return false;
      const { toolCallId, content } = e.update;
      if (typeof toolCallId !== 'string' || typeof content?.text !== 'string') return true;
      const key = keyOf(e.turnId, toolCallId);
      const keys = live.get(chatId) ?? new Set();
      live.set(chatId, keys.add(key));
      hub.delta(chatId, key, { turnId: e.turnId, sessionUpdate: 'tool_output_delta', toolCallId, text: content.text });
      return true;
    },
    /** The key of the live output this event's call ends (its whole output replaces it), or undefined; a turn's end retracts what its calls left. @param {string} chatId @param {any} e */
    ended(chatId, e) {
      const keys = live.get(chatId);
      if (e.kind === 'turnEnd' && keys)
        for (const key of keys)
          if (key.startsWith(`${e.turnId}:`)) {
            hub.retract(chatId, key);
            keys.delete(key);
          }
      const id = e.kind === 'update' ? e.update?.toolCallId : undefined;
      const ended = typeof id === 'string' && keys?.delete(keyOf(e.turnId, id));
      if (keys && !keys.size) live.delete(chatId);
      return ended ? keyOf(e.turnId, id) : undefined;
    },
  };
}
