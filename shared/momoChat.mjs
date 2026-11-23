// MoMo's own chats (electron/momo/mainChat.cjs tags them in chat meta): the one predicate every list of chats skips them by.

/** The chat meta key that marks a MoMo chat: 'main' for the main chat, 'channel:<id>' for a channel's chat (A2), 'previous' for one a brain change replaced. */
export const MOMO_META_KEY = 'momo';

/** The chat meta key with the Claude Code model a MoMo chat's brain names (#2304): main writes it, every Claude turn runs on it. */
export const MOMO_MODEL_KEY = 'momoModel';

/** The model a MoMo chat's brain names for its Claude Code turns, or null (not MoMo's, or no model named). */
export function momoModelOf(meta) {
  const m = isMomoMeta(meta) ? meta[MOMO_MODEL_KEY] : null;
  return typeof m === 'string' && m ? m : null;
}

/** The chat meta key with the effort a MoMo chat's brain names for its Claude Code turns, pinned with its model. */
export const MOMO_EFFORT_KEY = 'momoEffort';

/** The effort a MoMo chat's brain names for its Claude Code turns, or null (not MoMo's, or the model's default). */
export function momoEffortOf(meta) {
  const e = isMomoMeta(meta) ? meta[MOMO_EFFORT_KEY] : null;
  return typeof e === 'string' && e ? e : null;
}

/**
 * MoMo's background chats that only answer with data: the memory pass's (electron/momo/memoryPass.cjs) and the search
 * aliases' (electron/momo/historyAliases.cjs) and the nudge check's (electron/momo/nudges.cjs). They read what the user said, so they get no tool and no memory context,
 * and they are never a past chat or a pass's source.
 */
export const MOMO_DATA_TAGS = Object.freeze(['memory', 'aliases', 'nudge', 'brief']);

/** Whether a chat's meta marks one of MoMo's data-only background chats (MOMO_DATA_TAGS). */
export function isMomoDataMeta(meta) {
  return isMomoMeta(meta) && MOMO_DATA_TAGS.includes(meta[MOMO_META_KEY]);
}

/** Whether a chat's meta marks it as one of MoMo's chats, which no list of chats shows. */
export function isMomoMeta(meta) {
  return !!meta && typeof meta === 'object' && typeof meta[MOMO_META_KEY] === 'string' && meta[MOMO_META_KEY] !== '';
}

/** A channel's id (electron/momo/channels.cjs makes them: opaque, Mac-generated, stable across restarts). */
export const CHANNEL_ID = /^ch_[0-9a-f]{16}$/;

/** The `meta.momo` tag of the chat that is channel `id`'s journal: 'channel:<id>' (main is 'main'; both are MoMo's conversations). */
export const channelTag = (/** @type {string} */ id) => `channel:${id}`;

/** The channel a chat's meta marks as its journal, or null (main, a routine's run, a coding chat). */
export function momoChannelIdOf(meta) {
  if (!isMomoMeta(meta)) return null;
  const tag = String(meta[MOMO_META_KEY]);
  const id = tag.startsWith('channel:') ? tag.slice('channel:'.length) : '';
  return CHANNEL_ID.test(id) ? id : null;
}

/** Whether a chat's meta marks MoMo's main chat or a channel's chat: the conversations the user has with MoMo (its routine tool and open loops are theirs). */
export function isMomoConversationMeta(meta) {
  return isMomoMeta(meta) && (meta[MOMO_META_KEY] === 'main' || momoChannelIdOf(meta) !== null);
}

/**
 * Whether a chat's turns may leave the Mac as usage data, read from main's chat records when asked (`holder.chats` may
 * appear after start): only a chat main knows that is not MoMo's. Fails closed: no chats store yet, an id that is no
 * chat (a deleted one, a background thread) never shares.
 * @param {{ chats?: { records: { get(id: string): { meta?: unknown } | undefined } } | null }} holder
 */
export function shareableChatsIn(holder) {
  return (id) => {
    const record = holder.chats?.records.get(id);
    return !!record && !isMomoMeta(record.meta);
  };
}
