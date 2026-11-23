// Ownership and projection of the lazily read recent list as the Chrome side panel and a phone read it (chats.recent): what the sidebar shows, the app's pin and unread flags, the login it runs on where its harness has several, and the chat that started it.
'use strict';
const { noteIgnored } = require('../ignored.cjs');
const { createPhoneSources, readAll } = require('./phoneListSources.cjs');
const { listChats } = require('../capabilities/tools/chatList.cjs');
const { nativeIdsOf } = require('../platform/chats.cjs');

/** The login a chat runs on where its harness has several accounts to tell apart, else null; a failed read costs the chip, never the list. */
function accountChipOf(/** @type {any} */ live, /** @type {string} */ chatId) {
  try {
    return live.capsService?.accountChip(chatId) ?? null;
  } catch (error) {
    noteIgnored('read a chat account chip', error);
    return null;
  }
}

/** Whether the login a chat runs on is the computer's default one; a failed read costs the flag, never the list. */
function accountIsDefault(/** @type {any} */ live, /** @type {string} */ chatId) {
  try {
    return live.capsService?.accountIsDefault(chatId) === true;
  } catch (error) {
    noteIgnored('read whether a chat runs on the default login', error);
    return false;
  }
}

/**
 * @param {any} live main's live services (chats, capsService)
 * @param {{ id: string, title: string, harness: string, lastActivity: string, project: string, projectId?: string, projectHint?: string }} c a chat as listChats names it
 */
function recentRow(live, c) {
  const account = accountChipOf(live, c.id);
  const meta = live.chats.records.get(c.id)?.meta;
  return {
    id: c.id,
    title: c.title,
    harness: c.harness,
    at: Date.parse(c.lastActivity),
    project: c.project,
    // additive: what tells two projects of one name apart (an old Mac sends none)
    projectId: c.projectId,
    // additive: what tells this project from another of its name (the last parent folders, as the sidebar shows it); only a shared name has one
    ...(c.projectHint && { projectHint: c.projectHint }),
    pinned: meta?.pinned === true,
    unread: meta?.unread === true,
    // additive: the login the chat runs on, where there are several to tell apart, and whether it is the computer's default (an old Mac sends neither)
    ...(account && { account, ...(accountIsDefault(live, c.id) && { accountDefault: true }) }),
    // additive: the chat that started it, so a phone nests it under that chat as the sidebar does, and how its last turn
    // ended (an old Mac sends neither, and an old phone ignores them)
    ...linkOf(live, c.id),
  };
}

/**
 * The chat that started this one, as the sidebar nests it (the orchestration journal's link, unless the user detached
 * it), and how its last turn ended; nothing for a chat no chat started.
 */
function linkOf(/** @type {any} */ live, /** @type {string} */ chatId) {
  const link = live.orchestrator?.journal?.child(chatId);
  if (!link || link.detached || typeof link.parentId !== 'string' || !link.parentId) return null;
  return { parentId: link.parentId, ...(link.lastReport?.how && { ended: link.lastReport.how }) };
}

/**
 * Cache only on demand: constructing main's services must not start an inactive harness or consume sidebar pages.
 * A chat mutation retires native-list reads; source completion notifies consumers without invalidating itself.
 * @param {{ sources: Record<string, (archived: boolean) => Promise<any[]>>, live: any, home: string,
 * projects: () => any[], prefs: () => any, changed: () => void }} o
 */
function createRecentList({ sources, live, home, projects, prefs, changed }) {
  let generation = 0;
  const cached = createPhoneSources(sources, { generation: () => generation, changed });
  return {
    invalidate: () => {
      generation++;
    },
    async read(limit, archived, offset = 0) {
      const sessions = await readAll(cached, archived);
      const { chats } = listChats(
        {
          projects: projects(),
          home,
          prefs: prefs(),
          records: live.chats.records,
          natives: nativeIdsOf(live.chats.records),
          sessions,
          maxLimit: 201,
        },
        { limit, offset, include_archived: archived, only_archived: archived },
      );
      return chats.map((c) => recentRow(live, c));
    },
  };
}

module.exports = { recentRow, createRecentList };
