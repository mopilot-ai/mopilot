// Puts an open chat on one login of its agent, or back on the agent's own choice, for a phone: the same pin the app's account row sets, checked against the identity registry first.
const { parseKind } = require('../../shared/harnessKind.mjs');
const { loginsOf } = require('./chromePanelShape.cjs');

/** How each family holds a chat's pin; a family without an entry has no accounts to pick. `id` null is the agent's own choice again. */
const PIN = {
  // the chat's file keeps the pick (and whether it is pinned); the live session takes it from its next message
  claude: (/** @type {any} */ live, /** @type {string} */ chatId, /** @type {any} */ _ref, /** @type {string | null} */ id) => {
    live.chats.patchMeta(chatId, { account: id ? { id, pinned: true } : null });
    live.claudeTurns.setOwn(chatId, { account: id });
  },
  // the account relay knows the chat by its thread
  codex: (/** @type {any} */ live, /** @type {string} */ _chatId, /** @type {any} */ ref, /** @type {string | null} */ id) => {
    live.accounts.pinChat(ref.key, id);
  },
};

/** The login a chat is pinned to, by family: null when it has none of its own (the agent's own choice applies). */
const PINNED = {
  claude: (/** @type {any} */ live, /** @type {string} */ chatId) => {
    const own = live.chats.get(chatId)?.meta?.account;
    return own?.pinned === true && typeof own.id === 'string' ? own.id : null;
  },
  codex: (/** @type {any} */ live, /** @type {string} */ _chatId, /** @type {any} */ ref) => {
    const pin = live.accounts?.pins?.get(ref?.key);
    return pin?.sticky === true ? pin.id : null;
  },
};

/**
 * What an open chat says about its login, for the menu the phone draws: whether this agent can hold a chat on its own login now,
 * the logins to pick from (signed-out ones marked), the one the chat is pinned to and the one now serving it, as the app names it.
 * Nothing for an agent without accounts. Shown only where it is a choice: the agent has several logins, or the chat is pinned.
 * @param {any} live @param {string} chatId @param {string | null} kind the chat's harness kind @param {string | null} serving the label of the login now serving it
 */
function chatAccountOf(live, chatId, kind, serving) {
  const family = parseKind(kind)?.family;
  const pinnedOf = family && PINNED[/** @type {keyof typeof PINNED} */ (family)];
  if (!pinnedOf) return {};
  const perChat = live.identity?.driver(family)?.perChat === true;
  const pinned = pinnedOf(live, chatId, live.controller.ref(chatId));
  const logins = loginsOf(live, family);
  const shown = logins.length > 1 || pinned !== null;
  return { perChat, ...(shown && { accounts: logins, account: { id: pinned, pinned: pinned !== null, serving } }) };
}

/**
 * @param {object} d
 * @param {any} d.live main's late-bound services: identity, chats, claudeTurns, accounts, controller
 * @param {(chatId: string) => string | null} d.kindOf the harness kind a chat runs on now
 * @param {(kind: string | null) => string | null} d.labelOf how the panel names a harness kind
 * @param {(channel: string, payload: unknown) => void} d.broadcast to every window
 * @returns {(p: { chatId: string, account: string | null }) => { chatId: string, account: string | null, pinned: boolean }}
 */
function createChatAccount({ live, kindOf, labelOf, broadcast }) {
  return function setChatAccount({ chatId, account }) {
    const kind = kindOf(chatId);
    const family = parseKind(kind)?.family;
    const put = family && PIN[/** @type {keyof typeof PIN} */ (family)];
    const label = labelOf(kind) ?? 'This agent';
    if (!put) throw new Error(`${label} has no accounts.`);
    // the registry says whether this harness can hold a chat on its own login now (Codex only behind the account relay)
    if (!live.identity?.driver(family)?.perChat) throw new Error(`${label} can't put a chat on its own account now.`);
    if (account !== null && !loginsOf(live, family).some((a) => a.id === account && a.loggedIn))
      throw new Error("That account isn't available for this agent.");
    put(live, chatId, live.controller.ref(chatId), account);
    broadcast('chats:changed', { id: chatId, chat: live.chats.get(chatId) });
    return { chatId, account, pinned: account !== null };
  };
}

module.exports = { createChatAccount, chatAccountOf };
