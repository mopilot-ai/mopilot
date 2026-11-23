// The account a chat goes on when it switches harness in place (design/multi-account R-2, R-5): the one
// picked with the switch, kept as the chat's pin there, or else the pin the chat already had on that harness.
// Applied in main before the first turn on the new segment, so that turn never starts on another account.

/**
 * @param {object} o
 * @param o.chats ChatsStore: record(chatId).meta.account is the chat's Claude account (lib/chatMeta.ts)
 * @param o.codex () => the Codex account pool, or null: its pinChat(threadId, id) is the relay's per-thread pin
 * @param o.claude ClaudeTurns: its `own` map and setOwn() hold the login main starts the chat's turns on
 * @param [o.activateSelection] Also activate the committed segment's selection; account-only callers keep live settings.
 * @returns the SwitchRunner's `putAccount`
 */
function switchAccount({ chats, codex, claude, activateSelection = false }) {
  /** How each first-tier harness holds a chat's account; `account` null: the chat's own pin there, if any. */
  const PUT = {
    // the relay knows the chat by its Codex thread; a thread the chat had before keeps its own pin
    codex: (_chatId, nativeId, account) => {
      const pool = codex();
      if (!account || !pool) return;
      // pinChat drops a pin to an account it doesn't have; the user is told instead
      if (!pool.get(account)) throw new Error('that account was removed');
      pool.pinChat(nativeId, account);
    },
    claude: (chatId, _nativeId, account) => {
      const pin = chats.record(chatId)?.meta?.account;
      const id = account ?? (pin?.pinned && typeof pin.id === 'string' ? pin.id : null);
      if (account) chats.patchMeta(chatId, { account: { id, pinned: true } });
      const own = claude.own.get(chatId);
      const config = activateSelection ? chats.record(chatId).meta.config : own;
      claude.setOwn(chatId, { model: config?.model ?? null, effort: config?.effort ?? null, account: id ?? own?.account ?? null });
    },
  };
  const put = ({ chatId, harness, nativeId, account }) => void PUT[harness]?.(chatId, nativeId, account);
  // Each adapter owns how its choice joins the segment write.
  const PREPARE = {
    codex: (nativeId) => {
      const pool = codex();
      if (!pool) throw new Error('the account pool is unavailable');
      const previous = pool.state?.chatPins?.[nativeId] ?? null;
      pool.pinChat(nativeId, null);
      const pin = pool.pins?.get(nativeId);
      return {
        undo: () => {
          try {
            pool.pinChat(nativeId, previous);
          } catch (e) {
            // the write failed: keep the old account in memory so the chat is still served on it, and
            // let the next save persist it
            if (previous) {
              pool.state.chatPins = { ...pool.state.chatPins, [nativeId]: previous };
              if (pin) pool.pins.set(nativeId, { ...pin, sticky: true });
            }
            throw e;
          }
        },
      };
    },
    // the segment write carries the cleared pin; the live login follows once it is saved
    claude: () => ({
      meta: { account: null },
      after: (chatId) => {
        const config = chats.record(chatId).meta.config;
        claude.setOwn(chatId, { model: config?.model ?? null, effort: config?.effort ?? null, account: null });
      },
    }),
  };
  // a harness with no per-chat account has nothing to clear
  put.prepareAutomatic = (harness, nativeId) => PREPARE[harness]?.(nativeId);
  return put;
}

module.exports = { switchAccount };
