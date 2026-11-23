// Automatic archiving of inactive chats in the app: its setting, each harness's sessions with their last activity, what
// holds a chat, and the archive itself as every window and the harness see it (electron/session/autoArchive.cjs).
const { AutoArchive } = require('../session/autoArchive.cjs');
const { autoArchiveDays } = require('../../shared/autoArchive.mjs');
const { busy } = require('../session/controllerEvents.cjs');
const { familyOf } = require('../session/contract/route.cjs');

/** Codex lists 100 threads a page; a history longer than this many pages is left for the next sweep. */
const CODEX_PAGES = 100;
const CLAUDE_PAGE = 500;

/** The harnesses with an archive of their own, kept in step (Codex's thread/archive); the others have only MoPilot's. */
const ARCHIVE_IN_HARNESS = (live) => ({ codex: (id) => live.codex.threadArchive(id) });

/**
 * @param {{ live: any, readState: () => any, broadcastAll: (channel: string, payload: any) => void, claude: any }} o
 */
function createAutoArchive({ live, readState, broadcastAll, claude }) {
  return new AutoArchive({
    chats: live.chats,
    get state() {
      return live.controller.state;
    },
    busy,
    days: () => autoArchiveDays(readState()?.prefs),
    sources: {
      // thread/list leaves out the threads Codex already archived
      codex: async () => {
        const out = [];
        let cursor = null;
        for (let page = 0; page < CODEX_PAGES; page++) {
          const r = await live.codex.threadList({ limit: 100, cursor, sortKey: 'updated_at', archived: false });
          // a page that isn't a list fails the listing, so its chats are not taken for inactive
          for (const t of r.data) out.push({ key: t.id, at: t.updatedAt * 1000 });
          cursor = r.nextCursor;
          if (!cursor) break;
        }
        return out;
      },
      claude: async () => {
        const out = [];
        let list;
        let offset = 0;
        do {
          list = await claude.listSessions(CLAUDE_PAGE, offset);
          for (const s of list) out.push({ key: `claude:${s.sessionId}`, at: s.lastModified });
          offset += CLAUDE_PAGE;
        } while (list.length === CLAUDE_PAGE);
        return out;
      },
      acp: async () => (await live.acpHost.list()).map((c) => ({ key: c.id, at: c.updatedAt })),
    },
    scheduled: async () =>
      (live.scheduler ? await live.scheduler.list() : []).map((t) => t.target_thread_id).filter((id) => typeof id === 'string'),
    children: (chatId) => live.orchestrator?.journal.childrenOf(chatId) ?? [],
    // a harness that keeps an archive of its own has the chat's own session archived there too, as a manual archive does
    archiveNative: (chatId) => ARCHIVE_IN_HARNESS(live)[familyOf(live.chats.get(chatId).kind)]?.(chatId) ?? null,
    broadcast: (id, chat) => broadcastAll('chats:changed', { id, chat }),
  });
}

module.exports = { createAutoArchive };
