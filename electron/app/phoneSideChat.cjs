// A side chat started from a paired phone (remote method chat.sideChat, remote/methods/chatsManage.cjs): the Mac's "Side chat" (src/store/sideChat.ts), made in main so it needs no window. A temporary fork of the chat, kept out of every list and never written to disk; Claude Code branches its first message off the parent's session, Codex forks the thread without its turns (ephemeral); a basic (ACP) harness has no temporary fork. One per chat, as the Mac reuses a chat's side pane: asking again (or at once, twice) answers the same fork.
const crypto = require('node:crypto');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { effectivePermission } = require('../../shared/effectivePermission.mjs');
const { PERMISSION_ORDER } = require('../../shared/permissionMenu.mjs');
const { noteIgnored } = require('../ignored.cjs');

/** The most messages kept per side chat (the feed's ring holds far fewer turns). */
const MAX_QUESTIONS = 50;

/** The refusal the phone words: a code it branches on and the sentence it may show. @param {string} message */
const refuse = (message) => Object.assign(new Error(message), { code: 'side_chat_unavailable' });

/** The login a Codex chat is pinned to, when the user pinned it (a side chat stays on it, as the Mac's does). @param {any} live @param {string} thread */
function pinnedCodexLogin(live, thread) {
  const pin = live.accounts?.pins?.get(thread);
  return pin?.sticky === true && typeof pin.id === 'string' ? pin.id : null;
}

/**
 * How each harness family makes the fork, answering the new chat's id. Both leave the chat unlisted: no record is committed
 * and no window hears of it; the controller's state for it is made so a phone may follow it (reachable) and send to it.
 * @type {Record<string, (live: any, chatId: string, cwd: string | null) => string | Promise<string>>}
 */
const FORK = {
  claude: (live, chatId, cwd) => {
    const parent = String(live.controller.ref(chatId).key).replace(/^claude:/, '');
    const id = `claude:${crypto.randomUUID()}`;
    // their first message forks the parent's session, unpersisted (harness/claude/sessions.cjs forkFrom + ephemeral)
    live.claudeTurns.registerSession(id, { cwd, ephemeral: true, forkFrom: parent });
    // the model, effort and login the parent chat runs on
    const own = live.claudeTurns.own.get(chatId);
    if (own) live.claudeTurns.setOwn(id, own);
    return id;
  },
  codex: async (live, chatId) => {
    const parent = live.controller.ref(chatId).key;
    // held (kept loaded) like the Mac's side chat: Codex rejects deferGoalContinuation with ephemeral, so the fork carries no goal
    const { thread } = await live.codex.fork({ threadId: parent, excludeTurns: true, ephemeral: true }, true);
    const login = pinnedCodexLogin(live, parent);
    // the fork exists and is held by now: a login that can't be kept leaves it on the pool's choice, as the Mac's side chat does, rather than losing it
    if (login) {
      try {
        live.accounts.pinChat(thread.id, login);
      } catch (error) {
        noteIgnored("keep a Codex side chat on its chat's login", error);
      }
    }
    return thread.id;
  },
};

/**
 * Whether a native session is itself a temporary fork (a side chat, the Mac's or a phone's), from the harness's own record of it. A side chat
 * is not forked again, as the Mac's selection bar does not offer one inside a side chat: its session is unpersisted, so there is nothing to branch from.
 * @type {Record<string, (live: any, key: string) => boolean>}
 */
const TEMPORARY = {
  claude: (live, key) => live.claudeTurns.sessions?.get(key)?.ephemeral === true,
  codex: (live, key) => live.codex.meta?.get(key)?.ephemeral === true,
};

/**
 * A fork has no chat file to keep a permission in, so it runs on the app's default: refused when that is more than the chat it forks
 * has (read-only, or Plan mode), so a side chat never does what the chat it came from may not.
 * @param {any} live @param {() => any} prefs @param {string} chatId
 */
function checkPermission(live, prefs, chatId) {
  const rank = (/** @type {string} */ mode) => PERMISSION_ORDER.indexOf(/** @type {any} */ (mode));
  const parent = effectivePermission(live.chats.records.get(chatId)?.meta?.config, prefs().permission, live.controller.state.get(chatId));
  const fork = effectivePermission(null, prefs().permission, null);
  if (rank(fork) > rank(parent))
    throw refuse(
      `This chat is set to ${parent === 'plan' ? 'Plan mode' : parent}. Change it to ${fork} first, or start a side chat from another chat.`,
    );
}

/** @param {{ live: any, cwdOf: (chatId: string) => Promise<string | null>, prefs: () => any }} o main's late-bound services; the chat's folder; the app's prefs */
function createPhoneSideChat({ live, cwdOf, prefs }) {
  /** The side chat each chat has made, as the fork being made or made (one per chat, as the Mac's side pane). @type {Map<string, Promise<string>>} */
  const forks = new Map();
  /** The ids of the forks made: a fork's rows are kept by the phone feed, as nothing else saves them. @type {Set<string>} */
  const made = new Set();
  /** What a phone sent to each fork, oldest first and bounded: Claude's stream carries no user message and a fork has no transcript to read one from. @type {Map<string, string[]>} */
  const questions = new Map();
  /** @param {string} chatId */
  async function make(chatId) {
    const ref = live.controller.ref(chatId);
    const family = parseKind(ref.kind)?.family;
    const fork = family && FORK[family];
    if (!fork) throw refuse("Side chats aren't available for this agent.");
    if (TEMPORARY[family](live, ref.key)) throw refuse("A side chat can't start another side chat.");
    checkPermission(live, prefs, chatId);
    const id = await fork(live, chatId, await cwdOf(chatId));
    // main knows the chat from here on: a phone may follow it and send to it, though no record lists it
    live.controller.state.get(id);
    made.add(id);
    return id;
  }
  return {
    /** The side chats made from a phone (their rows are kept by the phone feed). */
    sideChatIds: () => made,
    /** A message a phone sent to a side chat, kept to show in front of its reply (any other chat: nothing). @param {string} chatId @param {string} text */
    sideChatAsked(chatId, text) {
      if (made.has(chatId)) questions.set(chatId, [...(questions.get(chatId) ?? []), String(text)].slice(-MAX_QUESTIONS));
    },
    /** What a phone sent to a side chat, oldest first. @param {string} chatId */
    sideChatQuestions: (chatId) => questions.get(chatId) ?? [],
    /**
     * A temporary fork of the chat, answering its id (the one it already made, if it has); refused (code side_chat_unavailable) for a harness without one.
     * @param {string} chatId
     * @returns {Promise<string>}
     */
    async sideChat(chatId) {
      const made = forks.get(chatId) ?? make(chatId);
      forks.set(chatId, made);
      // a refusal or a failure is not kept: asking again tries again
      return made.catch((error) => {
        if (forks.get(chatId) === made) forks.delete(chatId);
        throw error;
      });
    },
  };
}

module.exports = { createPhoneSideChat };
