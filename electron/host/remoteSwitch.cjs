// The person's pick of another agent for a chat on a remote Host: it reaches the Host now or fails, as Stop does, because a choice kept for later would be made on a chat that may have moved on. The Host holds the choice and settles it with the chat's next message.
const SWITCH_AWAY = "Can't reach the machine, so the chat stays on its agent.";

/**
 * @param {object} o
 * @param {(chatId: string) => boolean} o.isRemote whether the chat runs on a remote Host
 * @param {(hostId: string) => any} o.hostFor the connection to the machine, if there is one
 * @param {(chatId: string) => { hostId: string }} o.ownerOf the machine that owns the chat
 * @param {() => string} o.mintKey a new idempotency key
 */
function createSwitch({ isRemote, hostFor, ownerOf, mintKey }) {
  /** @param {string} chatId @param {object} pick @returns {Promise<unknown> | null} null: the chat runs here */
  return (chatId, pick) => {
    if (!isRemote(chatId)) return null;
    const host = hostFor(ownerOf(chatId).hostId);
    if (!host || host.state() !== 'online') return Promise.reject(new Error(SWITCH_AWAY));
    return Promise.resolve(host.switchTo(chatId, pick, { key: mintKey() }));
  };
}

/** The IPC's answer for a chat the person picked another agent for: the Host's reply, or a refusal for a chat that runs on this Mac. @param {any} live main's `live` @param {unknown} chatId @param {unknown} pick */
function switchChat(live, chatId, pick) {
  const sent = live?.remoteSend?.()?.switchTo(String(chatId ?? ''), pick);
  if (!sent) throw Object.assign(new Error('This chat runs on this Mac.'), { code: 'invalid' });
  return sent;
}

module.exports = { createSwitch, switchChat, SWITCH_AWAY };
