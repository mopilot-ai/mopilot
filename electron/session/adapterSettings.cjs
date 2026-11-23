// Harness adapters read current chat-owned settings and durably record account moves through the authoritative chat store.
const { keepSelection } = require('./keepSelection.cjs');
const { momoModelOf, momoEffortOf } = require('../../shared/momoChat.mjs');

/**
 * A chat's login record once a turn started on `account`. A chat the user pinned keeps its pin and notes the account that
 * served it instead; any other chat follows the account it runs on. null: nothing changes.
 * @param {{ id?: string, pinned?: boolean, serving?: string } | null | undefined} cur
 * @param {string} account
 */
function servedOn(cur, account) {
  const next = cur?.pinned
    ? account === cur.id
      ? { id: cur.id, pinned: true }
      : { id: cur.id, pinned: true, serving: account }
    : { id: account, pinned: false };
  return cur && cur.id === next.id && !!cur.pinned === next.pinned && cur.serving === next.serving ? null : next;
}

function adapterSettings(live) {
  const savedSettings = (chatId) => live.chats.records.get(chatId)?.meta?.config ?? null;
  // a MoMo chat's Codex turns run at the effort its brain pins (momo/brainModel.cjs), over the config a switch wrote
  const codexConfig = (chatId) => {
    const effort = momoEffortOf(live.chats.records.get(chatId)?.meta);
    return effort ? { ...savedSettings(chatId), effort } : savedSettings(chatId);
  };
  // the model and effort a chat's turn runs with, kept where the chat has none of its own yet
  const keep = (chatId, picked) => keepSelection(live.chats, chatId, picked);
  return {
    savedAccount: (chatId) => live.chats.records.get(chatId)?.meta?.account?.id ?? null,
    savedSettings,
    keepSelection: keep,
    // MoMo's main-owned model and effort pin wins over a window's own-settings push
    pinnedModel: (chatId) => momoModelOf(live.chats.records.get(chatId)?.meta),
    pinnedEffort: (chatId) => momoEffortOf(live.chats.records.get(chatId)?.meta),
    // Codex reads its own model, effort and tier from meta.config (D-29) and keeps them the same way
    codex: { chatConfig: codexConfig, keepSelection: keep },
    // Native ACP settings own ordinary chats; only a linked child's generic saved cap crosses this boundary.
    acpSettings: (chatId) => {
      const journal = live.orchestrator?.journal;
      // Until the journal is available, keep a possible inherited cap rather than silently removing it.
      return !journal || journal.child(chatId) ? savedSettings(chatId) : null;
    },
    moved: (chatId, { account, note }) =>
      live.chats.patchMeta(chatId, {
        account: { id: account, pinned: false },
        notes: [...(live.chats.record(chatId).meta.notes ?? []), note],
      }),
    // main keeps the login a turn ran on, as it keeps a move: a window only hears it, so its echo can't undo a newer move (#2538)
    served: (chatId, account) => {
      const next = typeof account === 'string' && account ? servedOn(live.chats.record(chatId).meta.account, account) : null;
      if (next) live.chats.patchMeta(chatId, { account: next });
    },
  };
}
module.exports = { adapterSettings, servedOn };
