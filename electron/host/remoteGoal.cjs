// What the goal bar and a typed /goal do to a goal on a chat that runs on a remote Host: it reaches the Host now or fails, as Stop and a switch do, because an action kept for later would be made on a goal that may have changed. The Host runs it on the chat's agent and answers with the goal; the state lane tells every client.
const GOAL_AWAY = "Can't reach the machine, so the goal is unchanged.";

/**
 * @param {object} o
 * @param {(chatId: string) => boolean} o.isRemote whether the chat runs on a remote Host
 * @param {(hostId: string) => any} o.hostFor the connection to the machine, if there is one
 * @param {(chatId: string) => { hostId: string }} o.ownerOf the machine that owns the chat
 * @param {() => string} o.mintKey a new idempotency key
 */
function createGoal({ isRemote, hostFor, ownerOf, mintKey }) {
  /** @param {string} chatId @param {object} what the action and what it takes (`chat.goal`) @returns {Promise<unknown> | null} null: the chat runs here */
  return (chatId, what) => {
    if (!isRemote(chatId)) return null;
    const host = hostFor(ownerOf(chatId).hostId);
    if (!host || host.state() !== 'online') return Promise.reject(new Error(GOAL_AWAY));
    return Promise.resolve(host.goal(chatId, what, { key: mintKey() }));
  };
}

/** The IPC's answer for a goal action on a chat the Host runs: the Host's reply, or a refusal for a chat that runs on this Mac. @param {any} live main's `live` @param {unknown} chatId @param {unknown} what */
function goalChat(live, chatId, what) {
  const sent = live?.remoteSend?.()?.goal(String(chatId ?? ''), what);
  if (!sent) throw Object.assign(new Error('This chat runs on this Mac.'), { code: 'invalid' });
  return sent;
}

module.exports = { createGoal, goalChat, GOAL_AWAY };
