// Input validation for every remote client method, shared by the Chrome side panel and phones so the two cannot drift: each parser takes a request's params and returns the normalized ones or throws a SchemaError whose message the client may show.
import { reviewParsers } from './reviewSchema.mjs';
import { credentialOf } from '../host/logins.mjs';
import { momoParsers } from './momoSchema.mjs';
import { phoneEnrollParsers } from './phoneEnrollSchema.mjs';
import { phoneAgentParsers } from './phoneAgentsSchema.mjs';
import { PUSH_SETTINGS, readQuietHours } from './pushSettings.mjs';

export const MAX_TEXT = 100_000;
/** What a panel is told when it asks for speech input without the capture lease a current extension holds. */
export const UPDATE_EXTENSION = 'Update the MoPilot extension to use speech input.';
export const MAX_RECENT = 200;
/** The longest name a phone may give a chat. */
export const MAX_CHAT_TITLE = 200;
/** Control and invisible format characters, which a chat's name never carries. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;
/** The deepest page start a phone can ask for; a Mac with more chats than this still lists the newest ones. */
export const MAX_RECENT_OFFSET = 10_000;
export const MAX_FOLLOW_ITEMS = 200;
export const DEFAULT_FOLLOW_ITEMS = 50;
/** Rows a phone may ask for in one page of older history. */
export const MAX_HISTORY_PAGE = 100;
export const DEFAULT_HISTORY_PAGE = 40;
/** A step picture's longest side: a phone's row thumbnail by default, its full-width view at most. */
export const DEFAULT_THUMB_SIDE = 360;
const MIN_THUMB_SIDE = 64;
export const MAX_THUMB_SIDE = 1024;
/** A saved project's id (platform/projects.cjs). */
const PROJECT = /^[\w-]{1,100}$/;
/** The app's pages a client may open (src/lib/appShortcuts.ts commands). */
const PAGES = new Set(['scheduled']);
const HARNESS = /^(codex|claude|acp:[\w.-]{1,64})$/;
/** A chat id as main names chats: a Codex thread, claude:<id> or acp:<harness>:<id>. */
const CHAT = /^[\w.:-]{1,300}$/;
/** An attachment's id (app/chromePanelFiles.cjs), and how many a message carries. */
const ATTACHMENT = /^[0-9a-f]{16}$/;
const MAX_ATTACHMENTS = 10;
/** A file's bytes as a data: URL: 20 MB in base64, and its type. */
/** The panel's attachment limit (app/chromePanelFiles.cjs MAX_BYTES), and a recording's. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_DATA_URL = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 200;
/** A dictated clip's bytes in base64: 25 MB at most (a few minutes of speech), and the forms an engine reads. */
const MAX_AUDIO = Math.ceil((MAX_AUDIO_BYTES * 4) / 3);
const AUDIO = new Set(['audio/wav', 'audio/webm']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** A phone's chunk stream (a file or a recording sent in parts) and a chat start's idempotency id. */
const STREAM = /^[\w-]{8,64}$/;
/** One chunk's base64 text: a sealed relay frame holds 256 KB, so a part stays well inside it. */
export const MAX_CHUNK = 160_000;
/** The most parts one stream has: 25 MB in base64 at MAX_CHUNK each, rounded up. */
export const MAX_CHUNKS = Math.ceil(MAX_AUDIO / MAX_CHUNK) + 1;
/** The accounts of a harness (a login id), as the menus name them. */
const ACCOUNT = /^[\w.@:-]{1,200}$/;
/** A model's id ("gpt-6.1-sol", "claude-fable-5-1[1m]"), an effort's, or a permission or mode's. */
const OPTION = /^[\w.:/[\]-]{1,200}$/;
/** A skill a message names (the / menu's). */
const SKILL = /^[\w:.-]{1,100}$/;

/** A request the client got wrong: the message is safe to show, the code is 'invalid'. */
export class SchemaError extends Error {
  code = 'invalid';
}
const bad = (/** @type {string} */ message) => new SchemaError(message);

/** A clip a client sent, as bytes; refused when it isn't one. */
export function audioOf(/** @type {unknown} */ v) {
  if (typeof v === 'string' && v.length > MAX_AUDIO) throw bad('That recording is too long. Dictate in shorter parts.');
  if (typeof v !== 'string' || !v || !BASE64.test(v)) throw bad("That recording couldn't be read.");
  return Buffer.from(v, 'base64');
}

/**
 * The line naming the Chrome tab the panel was on, added to the message so the chat knows which page the user means;
 * null for a tab that is not a web page. Only its address: the page's title is the page's own text, and the message is
 * the user's, so a page never gets words into it (the agent reads the page through the browser tools instead).
 */
export function tabLine(/** @type {unknown} */ tab) {
  if (!tab || typeof tab !== 'object') return null;
  let url;
  try {
    url = new URL(String(/** @type {{ url?: unknown }} */ (tab).url));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `[Chrome tab: ${url.href}]`;
}

/** The chat a request names; refused when it isn't one. */
export function chatOf(/** @type {any} */ p) {
  const chatId = typeof p?.chatId === 'string' ? p.chatId : '';
  // a native session (#5576) is listed, not a chat: no chat request may name one
  if (!CHAT.test(chatId) || chatId.startsWith('native:')) throw bad("That chat isn't in MoPilot.");
  return chatId;
}

/** The id of the row a page of older history ends before (a row id is the JSON the Mac gave, at most 2 KB). */
function rowOf(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !v || v.length > 2048) throw bad('That part of the chat is not available.');
  return v;
}

/** How many earlier rows a page holds. */
function pageOf(/** @type {unknown} */ v) {
  return Number.isInteger(v) ? Math.max(1, Math.min(MAX_HISTORY_PAGE, /** @type {number} */ (v))) : DEFAULT_HISTORY_PAGE;
}

/** The chat a menu is for, else the harness of the next new chat. */
export function targetOf(/** @type {any} */ p) {
  if (p.chatId != null) return { chatId: chatOf(p) };
  const harness = String(p.harness ?? '');
  if (!HARNESS.test(harness)) throw bad('Pick a harness for the new chat.');
  return { harness };
}

/** An option a client picked. */
export function optionOf(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !OPTION.test(v)) throw bad("That option isn't one MoPilot has.");
  return v;
}
/** One a client may leave out (null). */
export const maybeOption = (/** @type {unknown} */ v) => (v == null ? null : optionOf(v));

/** The attachments a message carries: ids of files attached here. */
export function attachmentsOf(/** @type {unknown} */ v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_ATTACHMENTS || !v.every((id) => typeof id === 'string' && ATTACHMENT.test(id)))
    throw bad('Attach those files again.');
  return v;
}

export function skillsOf(/** @type {unknown} */ v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_ATTACHMENTS || !v.every((name) => typeof name === 'string' && SKILL.test(name)))
    throw bad("Those skills aren't ones MoPilot has.");
  return v;
}

/** The model and effort a message goes with, when the client picked them, its attachments and skills. */
export const pickOf = (/** @type {any} */ p) => ({
  model: maybeOption(p.model),
  effort: maybeOption(p.effort),
  attachments: attachmentsOf(p.attachments),
  skills: skillsOf(p.skills),
});

/** A saved project's id a request names, or null. */
export function projectOf(/** @type {any} */ p) {
  const projectId = p.projectId == null ? null : String(p.projectId);
  if (projectId !== null && !PROJECT.test(projectId)) throw bad("That project isn't in MoPilot.");
  return projectId;
}

/**
 * The message a request sends, with the Chrome tab's line; refused when empty or too long. Files without words are a message
 * (the app's composer sends them the same way, on every harness), so the text may be empty when the request attaches any.
 */
export function composed(/** @type {any} */ p) {
  const text = typeof p.text === 'string' ? p.text.trim() : '';
  if (!text && !attachmentsOf(p.attachments).length) throw bad('Type a message first.');
  if (text.length > MAX_TEXT) throw bad('The message is too long.');
  const line = tabLine(p.tab);
  return line ? (text ? `${text}\n\n${line}` : line) : text;
}

/** A recording a phone sent in parts: the stream it is under and its type. */
const audioStreamOf = (/** @type {any} */ p) => {
  const mime = String(p.mime ?? '');
  if (!AUDIO.has(mime)) throw bad("That recording couldn't be read.");
  return { stream: streamOf(p.stream, 'That upload is not valid.'), mime };
};
const streamOf = (/** @type {unknown} */ v, /** @type {string} */ message) => {
  if (typeof v !== 'string' || !STREAM.test(v)) throw bad(message);
  return v;
};
const accountOf = (/** @type {unknown} */ v) => {
  if (typeof v !== 'string' || !ACCOUNT.test(v)) throw bad("That account isn't one MoPilot has.");
  return v;
};

/** One part of a file or recording a phone sends: which stream, which part of how many, and its bytes in base64. */
function chunkOf(/** @type {any} */ p) {
  const stream = streamOf(p.stream, 'That upload is not valid.');
  const total = p.total;
  const index = p.index;
  if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS || !Number.isInteger(index) || index < 0 || index >= total)
    throw bad('That upload is not valid.');
  if (typeof p.data !== 'string' || !p.data || p.data.length > MAX_CHUNK || !BASE64.test(p.data)) throw bad('That upload is not valid.');
  const purpose = p.purpose === 'audio' ? 'audio' : 'file';
  const mime = String(p.mime ?? '');
  if (purpose === 'audio' && !AUDIO.has(mime)) throw bad("That recording couldn't be read.");
  const name = typeof p.name === 'string' && p.name ? p.name.slice(0, 200) : 'file';
  return { stream, index, total, data: p.data, purpose, mime, name };
}

const harnessOf = (/** @type {any} */ p, /** @type {string} */ message) => {
  const harness = String(p.harness ?? '');
  if (!HARNESS.test(harness)) throw bad(message);
  return harness;
};
const deadlineOf = (/** @type {any} */ p) => (Number.isSafeInteger(p.deadline) ? { deadline: p.deadline } : {});
const tabOf = (/** @type {any} */ p) => (p.tab ? { tab: p.tab } : {});

/** One of the user's machines (electron/host/registry.cjs ids, 'local' for this Mac). */
const MACHINE = /^[\w.:@-]{1,200}$/;
const machineOf = (/** @type {unknown} */ v) => {
  if (typeof v !== 'string' || !MACHINE.test(v)) throw bad("That machine isn't one of yours.");
  return v;
};
/** A folder on a machine: an absolute path, as its Host checks it again (shared/host/schema.mjs). */
const folderOf = (/** @type {unknown} */ v) => {
  if (typeof v !== 'string' || !v.startsWith('/') || v.length > 4096 || v.includes('\0')) throw bad('Pick a folder on that machine.');
  return v;
};
/** Where a new chat runs: a machine and its folder, or this Mac (none, or 'local'). */
function startHostOf(/** @type {any} */ p) {
  if (p.hostId == null || p.hostId === 'local') return {};
  return { hostId: machineOf(p.hostId), folder: folderOf(p.folder) };
}

/** The remote machines' methods (phones only, and only for an account with Host). @type {Record<string, (p: any) => any>} */
const HOST_PARSERS = {
  'machines.list': () => ({}),
  ...phoneEnrollParsers({ bad, machineOf }),
  'machines.folders': (p) => ({ id: machineOf(p.id), ...(p.path == null ? {} : { path: folderOf(p.path) }) }),
  ...phoneAgentParsers({ bad, machineOf }),
  // Switch host from a phone: carry 'code' takes the chat's uncommitted changes along (no new files), 'none' leaves them. Back to this
  // Mac ('local') names a saved project by its id (the Mac resolves its folder), or by its folder; a machine takes a folder
  'chat.move': (p) => {
    if (p.carry !== 'code' && p.carry !== 'none') throw bad('Say whether to take the changes along.');
    const move = { chatId: chatOf(p), hostId: machineOf(p.hostId), carry: p.carry };
    if (move.hostId === 'local' && p.projectId != null) return { ...move, projectId: /** @type {string} */ (projectOf(p)) };
    return { ...move, folder: folderOf(p.folder) };
  },
};

/** A mirror stream's id, chosen by the phone: it names one terminal across reconnects. */
const PTY_STREAM = /^[\w-]{1,64}$/;
/** What one pty.write carries at most (a paste), and the terminal's size bounds. */
export const MAX_PTY_WRITE = 64 * 1024;
const MAX_PTY_SIDE = 1000;
const sideOf = (/** @type {unknown} */ v, /** @type {number} */ d) =>
  Number.isFinite(v) ? Math.max(1, Math.min(MAX_PTY_SIDE, Math.floor(/** @type {number} */ (v)))) : d;
/** The stream a terminal request names; refused when it isn't one. */
export function ptyStreamOf(/** @type {any} */ p) {
  const stream = typeof p?.stream === 'string' ? p.stream : '';
  if (!PTY_STREAM.test(stream)) throw bad("That terminal isn't open.");
  return stream;
}

const queryOf = (/** @type {any} */ p) => (typeof p.query === 'string' ? p.query.trim().slice(0, 200) : '');

/** @type {Record<string, (p: any) => any>} each method's params, checked and normalized */
/**
 * The Mac's notification settings a phone may read and change (phone only): chat titles in push, the notification mode and the
 * per-kind switches, quiet hours and MoMo's quiet hours. A key it does not know is refused.
 * @type {Record<string, (p: any) => any>}
 */
const PUSH_SET_KEYS = ['titlesInPush', 'mode', 'kinds', 'quietHours', 'momoQuietHours'];
const PUSH_PARSERS = {
  'push.settings.get': () => ({}),
  'push.settings.set': (p) => {
    if (Object.keys(p).some((k) => !PUSH_SET_KEYS.includes(k))) throw bad('Unknown notification setting.');
    const patch = /** @type {Record<string, unknown>} */ ({});
    if (p.titlesInPush !== undefined) {
      if (typeof p.titlesInPush !== 'boolean') throw bad('Choose on or off for titles in notifications.');
      patch.titlesInPush = p.titlesInPush;
    }
    if (p.mode !== undefined) {
      if (!PUSH_SETTINGS.mode.values.includes(p.mode)) throw bad('Choose when to notify.');
      patch.mode = p.mode;
    }
    if (p.kinds !== undefined) {
      const entries = p.kinds && typeof p.kinds === 'object' ? Object.entries(p.kinds) : [];
      if (!entries.length || !entries.every(([k, v]) => PUSH_SETTINGS.kinds.values.includes(k) && typeof v === 'boolean'))
        throw bad('Choose a known kind and on or off.');
      patch.kinds = Object.fromEntries(entries);
    }
    for (const key of /** @type {const} */ (['quietHours', 'momoQuietHours'])) {
      if (p[key] === undefined) continue;
      const q = p[key] === null ? null : readQuietHours(p[key]);
      if (p[key] !== null && !q) throw bad('Choose quiet hours as two different times, or none.');
      patch[key] = q;
    }
    if (!Object.keys(patch).length) throw bad('Nothing to change.');
    return patch;
  },
};

export const PARSERS = {
  'machine.hello': () => ({}),
  'chats.recent': (p) => ({
    limit: Number.isInteger(p.limit) ? Math.max(1, Math.min(MAX_RECENT, p.limit)) : 20,
    archived: p.archived === true,
    offset: Number.isInteger(p.offset) ? Math.max(0, Math.min(MAX_RECENT_OFFSET, p.offset)) : 0,
  }),
  'chats.pin': (p) => ({ chatId: chatOf(p), pinned: p.pinned === true }),
  // the sidebar's Rename: one line of plain visible text, as set_session_title takes it (capabilities/tools/sessionControl.cjs)
  'chats.rename': (p) => {
    const title = typeof p.title === 'string' ? p.title.trim().replace(/\s+/g, ' ') : '';
    if (!title) throw bad('Give the chat a name.');
    if (title.length > MAX_CHAT_TITLE) throw bad(`Keep the name under ${MAX_CHAT_TITLE} characters.`);
    if (INVISIBLE.test(title)) throw bad('Use plain text for the name.');
    return { chatId: chatOf(p), title };
  },
  // the sidebar's Archive, and Restore from the archive
  'chats.archive': (p) => {
    if (typeof p.archived !== 'boolean') throw bad('Say whether to archive the chat or bring it back.');
    return { chatId: chatOf(p), archived: p.archived };
  },
  // the Mac's Side chat: a temporary fork of the chat (the phone puts what it selected into the fork's composer itself)
  'chat.sideChat': (p) => ({ chatId: chatOf(p) }),
  'projects.list': () => ({}),
  'scheduled.list': () => ({}),
  'harnesses.list': (p) => ({ states: p.states === true }),
  'usage.get': (p) => ({ refresh: p.refresh === true }),
  'accounts.get': () => ({}),
  'accounts.autoSwitch': (p) => {
    if (typeof p.harness !== 'string' || !p.harness) throw bad('Pick an agent.');
    if (typeof p.on !== 'boolean') throw bad('Say whether to turn auto-switch on or off.');
    return { harness: p.harness, on: p.on };
  },
  'chat.follow': (p) => ({
    chatId: chatOf(p),
    items: Number.isInteger(p.items) ? Math.max(0, Math.min(MAX_FOLLOW_ITEMS, p.items)) : DEFAULT_FOLLOW_ITEMS,
  }),
  'chat.unfollow': (p) => ({ chatId: chatOf(p) }),
  // the @ menu of a followed chat's composer: its chats and the files of its folder that match what is typed
  'mentions.list': (p) => ({ chatId: chatOf(p), query: queryOf(p) }),
  // the same menu before a chat exists: the new chat's harness and saved project (its folder) stand in for the followed chat
  'mentions.start': (p) => ({ ...targetOf({ harness: p.harness }), projectId: projectOf(p), query: queryOf(p) }),
  'chat.read': (p) => ({
    chatId: chatOf(p),
    // a phone pages back: the id of the oldest row it has, and how many earlier rows it wants
    ...(p.before === undefined ? {} : { before: rowOf(p.before), limit: pageOf(p.limit) }),
  }),
  'chat.stop': (p) => ({ chatId: chatOf(p) }),
  // takes a message back out of the chat's queue, as the app's Remove does (Edit is this, then the text back in the composer)
  'chat.queue.cancel': (p) => ({ chatId: chatOf(p), id: streamOf(p.id, 'That message is not valid.') }),
  // sends a message the Host refused again, as the app's Retry on that queued row does (the same key, so once)
  'chat.queue.retry': (p) => ({ chatId: chatOf(p), id: streamOf(p.id, 'That message is not valid.') }),
  // one login of the chat's own agent, or null for the agent's own choice again
  'chat.account': (p) => ({ chatId: chatOf(p), account: p.account == null ? null : accountOf(p.account) }),
  // `account`: a login of the agent the chat moves to; null is that agent's own choice; left out keeps what the switch had. `credential`: where a machine chat's access comes from on that agent
  'chat.switch': (p) => ({
    chatId: chatOf(p),
    harness: harnessOf(p, 'Pick a harness.'),
    ...(p.account === undefined ? {} : { account: p.account === null ? null : accountOf(p.account) }),
    // a machine chat's model access on the agent it moves to (the Host checks it against that agent before it moves)
    ...(p.credential == null ? {} : { credential: credentialOf(p.credential, bad) }),
  }),
  'chat.send': (p) => {
    const chatId = chatOf(p);
    return {
      chatId,
      text: composed(p),
      ...pickOf(p),
      ...tabOf(p),
      ...deadlineOf(p),
      ...(p.sendId == null ? {} : { sendId: streamOf(p.sendId, 'That send id is not valid.') }),
    };
  },
  'chat.start': (p) => {
    const harness = harnessOf(p, 'Pick a harness for the new chat.');
    const text = composed(p);
    const projectId = projectOf(p);
    return {
      harness,
      text,
      projectId,
      ...(p.retainOnError === true ? { retainOnError: true } : {}),
      ...pickOf(p),
      ...(p.permission == null ? {} : { permission: optionOf(p.permission) }),
      ...(p.account == null ? {} : { account: accountOf(p.account) }),
      ...(p.worktree === true ? { worktree: true } : {}),
      // where a machine chat's model access comes from (the Host enforces it); a local chat has no such choice
      ...(p.credential == null ? {} : { credential: credentialOf(p.credential, bad) }),
      ...(p.startId == null ? {} : { startId: streamOf(p.startId, 'That start id is not valid.') }),
      ...startHostOf(p),
      ...tabOf(p),
      ...deadlineOf(p),
    };
  },
  'chat.open': (p) => ({
    chatId: typeof p.chatId === 'string' && p.chatId ? p.chatId : null,
    page: PAGES.has(p.page) ? p.page : undefined,
  }),
  'chat.attach': (p) => {
    if (p.stream != null) return chunkOf(p);
    const dataUrl = typeof p.dataUrl === 'string' ? p.dataUrl : '';
    const name = typeof p.name === 'string' && p.name ? p.name.slice(0, 200) : 'file';
    if (!dataUrl.startsWith('data:')) throw bad("That file couldn't be read.");
    if (dataUrl.length > MAX_DATA_URL) throw bad('That file is larger than 20 MB.');
    return { dataUrl, name };
  },
  'chat.transcribe': (p) => {
    if (p.stream != null) return audioStreamOf(p);
    const mime = String(p.mime ?? '');
    if (!AUDIO.has(mime)) throw bad("That recording couldn't be read.");
    const audio = audioOf(p.audio);
    // the recording kept: the recorder's own clip, sent beside the WAV this Mac's engine reads
    const clip = p.clip == null ? audio : audioOf(p.clip);
    // the capture lease the clip was recorded under: dictation checks that it is this client's and still current
    return { audio, mime, clip, ...(p.capture ? { capture: p.capture, clientId: p.clientId } : {}) };
  },
  'dictation.engine': () => ({}),
  // the Chrome panel's speech lease (electron/app/chromePanelDictate.cjs): begin names who dictates and where, end lets it go
  'dictation.begin': (p) => {
    if (!p.capture) throw bad(UPDATE_EXTENSION);
    return { clientId: p.clientId, generation: p.generation, target: targetOf(p) };
  },
  'dictation.end': (p) => ({ capture: p.capture, clientId: p.clientId, generation: p.generation }),
  'options.get': (p) => targetOf(p),
  'options.set': (p) => {
    const target = targetOf(p);
    if (p.value != null) return { ...target, value: optionOf(p.value) };
    return { ...target, model: optionOf(p.model), effort: maybeOption(p.effort) };
  },
  'card.choose': (p) => ({ ...targetOf(p), model: p.model === null ? null : optionOf(p.model), effort: maybeOption(p.effort) }),
  'card.permit': (p) => ({ ...targetOf(p), value: optionOf(p.value) }),
  'commands.list': (p) => {
    const target = targetOf(p);
    return 'chatId' in target ? target : { ...target, projectId: projectOf(p) };
  },
  'card.answer': (p) => {
    const chatId = chatOf(p);
    const cardId = typeof p.cardId === 'string' || Number.isSafeInteger(p.cardId) ? p.cardId : null;
    const key = typeof p.key === 'string' ? p.key : '';
    if (cardId === null || !key) throw bad('Pick one of the choices.');
    if (p.rev !== undefined && !Number.isSafeInteger(p.rev)) throw bad('That request was already answered.');
    return {
      chatId,
      cardId,
      key,
      ...(p.rev !== undefined ? { rev: p.rev } : {}),
      ...(p.version !== undefined ? { version: String(p.version) } : {}),
      ...(p.values !== undefined ? { values: p.values } : {}),
    };
  },
  // mirrors (M5): a terminal in a followed chat's folder (never a client-chosen cwd) and low-rate frames while a tool runs
  'pty.open': (p) => ({
    chatId: chatOf(p),
    stream: ptyStreamOf(p),
    cols: sideOf(p.cols, 80),
    rows: sideOf(p.rows, 24),
    // a reconnect names the byte offset it holds, so the Mac sends only what it missed
    ...(Number.isSafeInteger(p.from) && p.from >= 0 ? { from: p.from } : {}),
  }),
  'pty.write': (p) => {
    if (typeof p.data !== 'string' || !p.data) throw bad('Type something first.');
    if (p.data.length > MAX_PTY_WRITE) throw bad('That paste is too long for the terminal.');
    return { stream: ptyStreamOf(p), data: p.data };
  },
  'pty.resize': (p) => ({ stream: ptyStreamOf(p), cols: sideOf(p.cols, 80), rows: sideOf(p.rows, 24) }),
  'pty.close': (p) => ({ stream: ptyStreamOf(p) }),
  // a screenshot or zoom step's picture, opened on a tap: the call is the item id or the step row's id (a phone row id is at most 2 KB)
  'steps.thumbnail': (p) => {
    if (typeof p.callId !== 'string' || !p.callId || p.callId.length > 2048) throw bad('That step is not available.');
    const side = Number.isInteger(p.maxSide) ? p.maxSide : DEFAULT_THUMB_SIDE;
    return { chatId: chatOf(p), callId: p.callId, maxSide: Math.max(MIN_THUMB_SIDE, Math.min(MAX_THUMB_SIDE, side)) };
  },
  // a picture the user attached to a message, opened from its thumbnail: the message is the item id or the row's id, the picture its place among the message's pictures
  'messages.image': (p) => {
    if (typeof p.itemId !== 'string' || !p.itemId || p.itemId.length > 2048) throw bad('That message is not available.');
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= 100) throw bad('That picture is not available.');
    const side = Number.isInteger(p.maxSide) ? p.maxSide : DEFAULT_THUMB_SIDE;
    return { chatId: chatOf(p), itemId: p.itemId, index: p.index, maxSide: Math.max(MIN_THUMB_SIDE, Math.min(MAX_THUMB_SIDE, side)) };
  },
  'surface.current': (p) => ({ chatId: chatOf(p) }),
  'frames.subscribe': (p) => ({ chatId: chatOf(p) }),
  'frames.unsubscribe': (p) => ({ chatId: chatOf(p) }),
  ...reviewParsers({ chatOf, bad }),
  'device.unpair': () => ({}),
  // the Chrome name, site grants and exact-origin revocation: checked by electron/app/chromeBrowserSettings.cjs
  'panel.browserSettings': (p) => p,
  ...momoParsers({ bad, queryOf, audioStreamOf, MAX_TEXT, MAX_FOLLOW_ITEMS, DEFAULT_FOLLOW_ITEMS }),
  // MoMo's routine runs and errands (electron/app/momoActivity.cjs): no params
  'momo.activity.list': () => ({}),
  ...PUSH_PARSERS,
  ...HOST_PARSERS,
};

/** Whether the method has a parser. */
export const knownMethod = (/** @type {unknown} */ m) => typeof m === 'string' && Object.hasOwn(PARSERS, m);

/** A request's params, checked: throws a SchemaError when invalid or when the method is unknown. */
export function parseParams(/** @type {string} */ method, /** @type {unknown} */ params) {
  if (!knownMethod(method)) throw bad(`Unknown request: ${method}`);
  const p = params && typeof params === 'object' ? params : {};
  return PARSERS[method](p);
}
