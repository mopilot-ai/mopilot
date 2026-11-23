// A Claude turn's start: counted in startingTurns while it runs, after an old chat's kept effort is read from its
// transcript and the CLI's own login is read, inside the session's native-settings queue; and the model and effort the chat keeps from its turn.
const { clock } = require('../../platform/ports/clock.cjs');
const { serializeNativeSettings, ownsNative } = require('./permissions.cjs');
const { cliLoginRead } = require('./cliLoginRead.cjs');
const { carryInputGuard } = require('../../session/contract/inputGuard.cjs');

/** How long a turn waits for an old chat's transcript to say its effort. */
const READ_MS = 2000;
/** chatId -> the read of its transcript's last effort under way, per adapter */
const reads = new WeakMap();

/**
 * A chat from before chats kept their effort (or made where none was saved) runs on the effort its session last ran
 * with, not on whatever the new-chat default is now. One read per chat: turns started meanwhile wait on the same one,
 * in the order they came. Null when there is nothing to read. `failed(context, error)`: where a read that fails goes.
 * @returns {Promise<void> | null}
 */
function keepTranscriptEffort(adapter, chatId, ref, failed) {
  const saved = adapter.savedSettings(chatId);
  if ((saved && 'effort' in saved) || adapter.own.get(chatId)?.effort || !adapter.api.sessionSettings) return null;
  if (!reads.has(adapter)) reads.set(adapter, new Map());
  const pending = reads.get(adapter);
  let read = pending.get(chatId);
  if (!read) {
    // a read that never settles must not hold the chat's turns: past READ_MS it runs on its settings as they are
    read = Promise.race([adapter.api.sessionSettings(ref.id), new Promise((r) => clock.setTimeout(r, READ_MS, null).unref?.())])
      .then(
        (/** @type {{ effort?: string | null } | null} */ last) => {
          if (last) adapter.keepSelection?.(chatId, { effort: last.effort ?? null });
        },
        (/** @type {unknown} */ error) => failed('read the effort a Claude Code session last ran with', error),
      )
      .finally(() => pending.delete(chatId));
    pending.set(chatId, read);
  }
  return read;
}

/**
 * Start a turn for a message on the chat's Claude session (ClaudeAdapter.startTurn); `failed` as keepTranscriptEffort's.
 * @returns {Promise<{ started: boolean, turnId?: string, itemId?: string, error?: string, discarded?: boolean }>}
 */
async function startClaudeTurn(adapter, chatId, ref, item, origin, failed) {
  const key = ref.key;
  adapter.startingTurns.set(key, (adapter.startingTurns.get(key) ?? 0) + 1);
  try {
    // only a chat with an effort to read waits, so a turn start keeps its place among the chat's others
    const reading = keepTranscriptEffort(adapter, chatId, ref, failed);
    // and a turn the CLI's own login is unread for waits for its first read, so a limit can move the chat there (#3157)
    const login = cliLoginRead(adapter);
    if (reading || login) await Promise.all([reading, login]);
    return await serializeNativeSettings(adapter, key, (current) => {
      if (!current() || !ownsNative(adapter, key))
        return { started: false, error: 'The Claude Code session changed before this turn started.' };
      return adapter.beginTurn(chatId, ref, item, origin, current);
    });
  } finally {
    const n = /** @type {number} */ (adapter.startingTurns.get(key)) - 1;
    if (n) adapter.startingTurns.set(key, n);
    else adapter.startingTurns.delete(key);
  }
}

/**
 * The chat keeps what it runs with (not a message's own, a scheduled run's), where it has none of its own yet: another
 * chat's pick moves only the new-chat default.
 */
function keepTurnSelection(adapter, chatId, opts, st) {
  const chosen = opts.model || opts.effort ? adapter.settings(chatId, {}) : st;
  adapter.keepSelection?.(chatId, { model: chosen.selectionModel, effort: chosen.effort });
}

/** A turn's text and native metadata share the same input owner; only maintenance carries a compact marker. */
function claudeTurnInput(item, clientId) {
  const opts = item.opts || {};
  const attachments = Array.isArray(item.attachments) ? item.attachments : [];
  const content = {
    text: String(item.text ?? ''),
    attachments: attachments.map(({ previewUrl: _p, ...a }) => a),
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
  };
  // Handoff text is MoPilot's; a message carrying it is not attributed as the user's own.
  const meta = carryInputGuard(item, {
    human: !!opts.human && !opts.prefix,
    uuid: clientId,
    ...(opts.compact ? { compact: opts.compact } : {}),
  });
  return { content, meta };
}

/** Turns of this adapter waiting on a transcript read (tests). */
const pendingReads = (adapter) => reads.get(adapter)?.size ?? 0;

module.exports = { startClaudeTurn, keepTurnSelection, keepTranscriptEffort, pendingReads, claudeTurnInput };
