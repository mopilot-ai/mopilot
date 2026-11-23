// MoMo's channels and groups (A2): the registry of names, opaque ids, groups, archived flags, each channel's own instructions (at most 2,000 characters, an L1 document scoped to the channel) and the chat that is its journal, kept through a tiny storage seam, `{ read, change }`, that the app wires to a sealed file (app/momoChannels.cjs) and tests to memory; this module reaches no disk, no Electron and no clock but the ones it is given. Ids are made here (`ch_` and 16 hex digits) and kept for good; names are unique among the channels still open and at most 12 are open; a group is only a folder (deleting one frees its channels). Archiving keeps the channel's journal and what MoMo remembered (memory is MoMo's, not the channel's); deleting forgets the channel and hands back its journal's chat id for the caller to delete.
const crypto = require('node:crypto');
const { CHANNEL_ID } = require('../../shared/momoChat.mjs');

/** The most channels open at once (archived ones do not count). */
const MAX_CHANNELS = 12;
/** The most groups. */
const MAX_GROUPS = 12;
/** The most archived channels kept, the newest. */
const MAX_ARCHIVED = 50;
const MAX_NAME = 40;
const MAX_INSTRUCTIONS = 2000;
/** Names that mean something else in the rail. */
const RESERVED = new Set(['everything', 'main', 'new channel']);
const WELCOME = ['yes', 'no', 'later'];
const GROUP_ID = /^gr_[0-9a-f]{16}$/;

/**
 * @typedef {{ id: string, name: string, group: string | null, chatId: string | null, archived: number | null, createdAt: number,
 *   instructions: string, welcome: Welcome | null }} ChannelRow
 * @typedef {'yes' | 'no' | 'later'} Welcome the user's answer to the first row of a new channel (record only: the suggestion store is A7's)
 * @typedef {{ id: string, name: string }} GroupRow
 * @typedef {{ channels: ChannelRow[], groups: GroupRow[] }} ChannelsValue
 * The whole storage seam: sealedFile.cjs's SealedJson fits it, tests use `memoryStorage`.
 * @typedef {{ read: () => ChannelsValue, change: <R>(fn: (v: ChannelsValue) => R | Promise<R>) => Promise<R> }} ChannelsStorage
 */

/** A channel error the IPC layers pass on by its code. */
class ChannelError extends Error {
  /** @param {string} message @param {'bad_args' | 'duplicate' | 'cap' | 'gone'} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** A name as kept: spaces collapsed, at most MAX_NAME characters, no control characters; null when it is none. */
function cleanName(/** @type {unknown} */ v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t && [...t].length <= MAX_NAME ? t : null;
}
const sameName = (/** @type {string} */ a, /** @type {string} */ b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * The kept registry: valid rows only, no duplicate id, a group that is gone cleared from its channels, the newest MAX_ARCHIVED archived channels.
 * @param {unknown} v @returns {ChannelsValue}
 */
function channelsShape(v) {
  const raw = /** @type {any} */ (v);
  const groups = [];
  const seenGroups = new Set();
  for (const g of Array.isArray(raw?.groups) ? raw.groups : []) {
    const name = cleanName(g?.name);
    if (typeof g?.id !== 'string' || !GROUP_ID.test(g.id) || !name || seenGroups.has(g.id)) continue;
    seenGroups.add(g.id);
    groups.push({ id: g.id, name });
  }
  const channels = [];
  const seen = new Set();
  for (const c of Array.isArray(raw?.channels) ? raw.channels : []) {
    const name = cleanName(c?.name);
    if (typeof c?.id !== 'string' || !CHANNEL_ID.test(c.id) || !name || seen.has(c.id)) continue;
    seen.add(c.id);
    channels.push({
      id: c.id,
      name,
      group: typeof c.group === 'string' && seenGroups.has(c.group) ? c.group : null,
      chatId: typeof c.chatId === 'string' && c.chatId ? c.chatId : null,
      archived: Number.isFinite(c.archived) ? c.archived : null,
      createdAt: Number.isFinite(c.createdAt) ? c.createdAt : 0,
      instructions: typeof c.instructions === 'string' ? c.instructions.slice(0, MAX_INSTRUCTIONS) : '',
      welcome: WELCOME.includes(c.welcome) ? c.welcome : null,
    });
  }
  const archived = channels
    .filter((c) => c.archived !== null)
    .sort((a, b) => /** @type {number} */ (b.archived) - /** @type {number} */ (a.archived))
    .slice(MAX_ARCHIVED);
  const dropped = new Set(archived.map((c) => c.id));
  return { channels: channels.filter((c) => !dropped.has(c.id)), groups };
}

/** A storage that keeps the value in memory (tests, the dev host's stand-in). @returns {ChannelsStorage} */
function memoryStorage() {
  let value = channelsShape(null);
  return {
    read: () => channelsShape(value),
    change: async (fn) => {
      const next = channelsShape(value);
      const out = await fn(next);
      value = channelsShape(next);
      return out;
    },
  };
}

const open = (/** @type {ChannelRow} */ c) => c.archived === null;
/** What the windows and phones see of a channel (never its instructions' text: `instructionsOf` reads them). */
const viewOf = (/** @type {ChannelRow} */ c) => ({
  id: c.id,
  name: c.name,
  group: c.group,
  createdAt: c.createdAt,
  hasInstructions: c.instructions !== '',
  welcome: c.welcome,
});

const gone = () => new ChannelError('That channel isn’t there any more.', 'gone');
const groupGone = () => new ChannelError('That group isn’t there any more.', 'gone');
const badName = () => new ChannelError(`Give it a name of 1 to ${MAX_NAME} characters.`, 'bad_args');
const taken = () => new ChannelError('You already have one with that name.', 'duplicate');

/** @param {{ storage: ChannelsStorage, now?: () => number, newId?: () => string }} o */
function createChannels({ storage, now = Date.now, newId = () => crypto.randomBytes(8).toString('hex') }) {
  /** The open channel `id` in `v`, or throws. */
  const find = (/** @type {ChannelsValue} */ v, /** @type {unknown} */ id) => {
    const c = v.channels.find((x) => x.id === id && open(x));
    if (!c) throw gone();
    return c;
  };
  const checkName = (/** @type {ChannelsValue} */ v, /** @type {unknown} */ raw, /** @type {string | null} */ except) => {
    const name = cleanName(raw);
    if (!name) throw badName();
    if (RESERVED.has(name.toLocaleLowerCase())) throw taken();
    if (v.channels.some((c) => open(c) && c.id !== except && sameName(c.name, name))) throw taken();
    return name;
  };
  const checkGroup = (/** @type {ChannelsValue} */ v, /** @type {unknown} */ id) => {
    if (id === null || id === undefined) return null;
    if (typeof id !== 'string' || !v.groups.some((g) => g.id === id)) throw groupGone();
    return id;
  };
  return {
    /** The open channels (oldest first) and the groups, as the windows see them, and how many more may be made. */
    list() {
      const v = storage.read();
      const channels = v.channels.filter(open).map(viewOf);
      return { channels, groups: v.groups, room: Math.max(0, MAX_CHANNELS - channels.length) };
    },
    /** The open channel `id`'s view, or null (unknown, archived or deleted). */
    get(/** @type {unknown} */ id) {
      const c = storage.read().channels.find((x) => x.id === id && open(x));
      return c ? viewOf(c) : null;
    },
    /** The journal chat of an open channel, or null: none yet, or not a channel. */
    chatIdOf(/** @type {unknown} */ id) {
      const c = storage.read().channels.find((x) => x.id === id && open(x));
      return c?.chatId ?? null;
    },
    /** The open channel whose journal is `chatId`, or null (main, another chat, an archived channel's). */
    byChatId(/** @type {unknown} */ chatId) {
      const c = chatId ? storage.read().channels.find((x) => x.chatId === chatId && open(x)) : undefined;
      return c ? viewOf(c) : null;
    },
    /** A channel's instructions, an L1 document scoped to it ('' when none; archived and deleted ones have none). */
    instructionsOf(/** @type {unknown} */ id) {
      const c = storage.read().channels.find((x) => x.id === id && open(x));
      return c?.instructions ?? '';
    },

    /** A new channel (name only), optionally in a group; refused for a bad or taken name and at the cap. */
    create(/** @type {unknown} */ name, /** @type {unknown} */ group = null) {
      return storage.change((v) => {
        if (v.channels.filter(open).length >= MAX_CHANNELS)
          throw new ChannelError(`That’s ${MAX_CHANNELS} channels. Archive one to add another.`, 'cap');
        const clean = checkName(v, name, null);
        const row = {
          id: `ch_${newId()}`,
          name: clean,
          group: checkGroup(v, group),
          chatId: null,
          archived: null,
          createdAt: now(),
          instructions: '',
          welcome: null,
        };
        v.channels.push(row);
        return viewOf(row);
      });
    },
    rename: (/** @type {unknown} */ id, /** @type {unknown} */ name) =>
      storage.change((v) => {
        const c = find(v, id);
        c.name = checkName(v, name, c.id);
        return viewOf(c);
      }),
    /** Archive: the channel leaves the rail and its chat is told to the caller; memory stays. */
    archive: (/** @type {unknown} */ id) =>
      storage.change((v) => {
        const c = find(v, id);
        c.archived = now();
        return { ...viewOf(c), chatId: c.chatId };
      }),
    /** Undo of an archive: the channel is on the rail again with its journal; refused when its name was taken meanwhile or the rail is full. */
    restore: (/** @type {unknown} */ id) =>
      storage.change((v) => {
        const c = v.channels.find((x) => x.id === id && !open(x));
        if (!c) throw gone();
        if (v.channels.filter(open).length >= MAX_CHANNELS)
          throw new ChannelError(`That’s ${MAX_CHANNELS} channels. Archive one to add another.`, 'cap');
        c.name = checkName(v, c.name, c.id);
        c.archived = null;
        return viewOf(c);
      }),
    /** Forget the channel (open or archived); the caller deletes its journal. Memory is not touched. */
    remove: (/** @type {unknown} */ id) =>
      storage.change((v) => {
        const i = v.channels.findIndex((x) => x.id === id);
        if (i < 0) throw gone();
        const [c] = v.channels.splice(i, 1);
        return { id: c.id, chatId: c.chatId };
      }),
    /** Move a channel into a group, or out of any (`null`). */
    move: (/** @type {unknown} */ id, /** @type {unknown} */ group) =>
      storage.change((v) => {
        const c = find(v, id);
        c.group = checkGroup(v, group);
        return viewOf(c);
      }),
    /**
     * Move a channel one place up or down among the open channels beside it (its group's, or the loose ones): the order of
     * `channels` is the order everywhere, so the swap with its neighbour in that list is the whole change. At an end it stays.
     */
    reorder: (/** @type {unknown} */ id, /** @type {unknown} */ dir) =>
      storage.change((v) => {
        const c = find(v, id);
        if (dir !== 'up' && dir !== 'down') throw new ChannelError('Move it up or down.', 'bad_args');
        const beside = v.channels.filter((x) => open(x) && x.group === c.group);
        const at = beside.indexOf(c);
        const other = beside[dir === 'up' ? at - 1 : at + 1];
        if (other) {
          const i = v.channels.indexOf(c);
          const j = v.channels.indexOf(other);
          [v.channels[i], v.channels[j]] = [v.channels[j], v.channels[i]];
        }
        return viewOf(c);
      }),
    /** Set the channel's instructions (trimmed, at most 2,000 characters; empty clears them). */
    setInstructions: (/** @type {unknown} */ id, /** @type {unknown} */ text) =>
      storage.change((v) => {
        if (typeof text !== 'string') throw new ChannelError('Write the instructions as text.', 'bad_args');
        const t = text.trim();
        if ([...t].length > MAX_INSTRUCTIONS)
          throw new ChannelError(`Keep the instructions to ${MAX_INSTRUCTIONS.toLocaleString('en-US')} characters.`, 'bad_args');
        const c = find(v, id);
        c.instructions = t;
        return viewOf(c);
      }),
    /** Record the user's answer to the channel's first row (Yes, No or Not now). */
    answerWelcome: (/** @type {unknown} */ id, /** @type {unknown} */ answer) =>
      storage.change((v) => {
        if (typeof answer !== 'string' || !WELCOME.includes(answer)) throw new ChannelError('Pick Yes, No or Not now.', 'bad_args');
        const c = find(v, id);
        c.welcome = /** @type {Welcome} */ (answer);
        return viewOf(c);
      }),
    /** Name the chat that is the channel's journal (main's own bookkeeping, never a window's or phone's call). */
    linkChat: (/** @type {unknown} */ id, /** @type {string} */ chatId) =>
      storage.change((v) => {
        find(v, id).chatId = chatId;
        return true;
      }),

    createGroup: (/** @type {unknown} */ name) =>
      storage.change((v) => {
        const clean = cleanName(name);
        if (!clean) throw badName();
        if (v.groups.length >= MAX_GROUPS) throw new ChannelError(`That’s ${MAX_GROUPS} groups.`, 'cap');
        if (v.groups.some((g) => sameName(g.name, clean))) throw taken();
        const row = { id: `gr_${newId()}`, name: clean };
        v.groups.push(row);
        return row;
      }),
    renameGroup: (/** @type {unknown} */ id, /** @type {unknown} */ name) =>
      storage.change((v) => {
        const g = v.groups.find((x) => x.id === id);
        if (!g) throw groupGone();
        const clean = cleanName(name);
        if (!clean) throw badName();
        if (v.groups.some((x) => x.id !== g.id && sameName(x.name, clean))) throw taken();
        g.name = clean;
        return { ...g };
      }),
    /**
     * Undo of a group's delete: the group is back under its own id and name, and the open channels named in `channelIds` that
     * are still out of any group go back in. Refused when the id or the name is in use again.
     */
    restoreGroup: (/** @type {any} */ group, /** @type {unknown} */ channelIds) =>
      storage.change((v) => {
        if (typeof group?.id !== 'string' || !/^gr_[0-9a-f]{1,32}$/.test(group.id)) throw new ChannelError('Say which group.', 'bad_args');
        const clean = cleanName(group.name);
        if (!clean) throw badName();
        if (v.groups.length >= MAX_GROUPS) throw new ChannelError(`That’s ${MAX_GROUPS} groups.`, 'cap');
        if (v.groups.some((g) => g.id === group.id || sameName(g.name, clean))) throw taken();
        const row = { id: group.id, name: clean };
        v.groups.push(row);
        const back = new Set(Array.isArray(channelIds) ? channelIds : []);
        for (const c of v.channels) if (open(c) && c.group === null && back.has(c.id)) c.group = row.id;
        return { ...row };
      }),
    /** Delete a group: its channels stay, out of any group. */
    removeGroup: (/** @type {unknown} */ id) =>
      storage.change((v) => {
        const i = v.groups.findIndex((x) => x.id === id);
        if (i < 0) throw groupGone();
        v.groups.splice(i, 1);
        for (const c of v.channels) if (c.group === id) c.group = null;
        return true;
      }),
  };
}

module.exports = {
  createChannels,
  channelsShape,
  memoryStorage,
  ChannelError,
  cleanName,
  MAX_CHANNELS,
  MAX_GROUPS,
  MAX_ARCHIVED,
  MAX_NAME,
  MAX_INSTRUCTIONS,
};
