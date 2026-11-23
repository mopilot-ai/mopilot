// The list_sidebar agent tool's wiring (electron/capabilities/tools/chatList.cjs): the saved projects, the chat records and each harness's session list, read-only.
const path = require('node:path');
const { ProjectsStore } = require('../../platform/projects.cjs');
const { nativeIdsOf } = require('../../platform/chats.cjs');
const { ownerOf } = require('../../platform/segmentOwner.cjs');
const { registerChatListTool, foldSessions, titleOf } = require('../../capabilities/tools/chatList.cjs');
const { within } = require('../../harness/autoTitle.cjs');

/** Codex lists 100 threads a page; a longer history is cut at this many pages (the newest first). */
const CODEX_PAGES = 10;
const CLAUDE_PAGE = 500;
const CLAUDE_PAGES = 4;

/**
 * Each harness's sessions as list_sidebar reads them (the same lists automatic archiving reads, app/autoArchive.cjs).
 * @param {any} live
 * @param {any} claude
 */
function chatSources(live, claude) {
  return {
    codex: async (archived) => {
      const out = [];
      for (const flag of archived ? [false, true] : [false]) {
        let cursor = null;
        for (let page = 0; page < CODEX_PAGES; page++) {
          const r = await live.codex.threadList({ limit: 100, cursor, sortKey: 'updated_at', archived: flag });
          for (const t of r.data)
            out.push({ key: t.id, title: titleOf(t.name || t.preview), cwd: t.cwd ?? null, at: t.updatedAt * 1000, archived: flag });
          cursor = r.nextCursor;
          if (!cursor) break;
        }
      }
      return out;
    },
    claude: async () => {
      const out = [];
      for (let page = 0; page < CLAUDE_PAGES; page++) {
        const list = await claude.listSessions(CLAUDE_PAGE, page * CLAUDE_PAGE);
        for (const s of list)
          out.push({
            key: `claude:${s.sessionId}`,
            // as the app's sidebar names it (src/harness/claude/threads.ts): its own name, else the first prompt
            title: titleOf(s.customTitle || s.firstPrompt || s.summary),
            cwd: s.cwd ?? null,
            at: s.lastModified,
          });
        if (list.length < CLAUDE_PAGE) break;
      }
      return out;
    },
    acp: async () =>
      (await live.acpHost.list()).map((c) => ({
        key: c.id,
        title: titleOf(c.name || c.preview),
        cwd: c.cwd ?? null,
        at: c.updatedAt,
        harness: `acp:${c.harness}`,
      })),
  };
}

/** How long a harness's list answers again unread: a model calls list_sidebar several times in one turn. */
const FRESH_MS = 15_000;

/**
 * `sources` whose answer (per `archived` flag) is reused for FRESH_MS; a failed read is not kept.
 * @template {Record<string, (archived: boolean) => Promise<any>>} S
 * @param {S} sources @param {() => number} [now]
 * @returns {S}
 */
function fresh(sources, now = Date.now) {
  /** @type {Map<string, { at: number, list: Promise<any> }>} */
  const kept = new Map();
  const wrap = (family, read) => (archived) => {
    const key = `${family}:${archived === true}`;
    const hit = kept.get(key);
    if (hit && now() - hit.at < FRESH_MS) return hit.list;
    const list = read(archived);
    kept.set(key, { at: now(), list });
    list.catch(() => kept.get(key)?.list === list && kept.delete(key));
    return list;
  };
  return /** @type {S} */ (Object.fromEntries(Object.entries(sources).map(([f, read]) => [f, wrap(f, read)])));
}

/** How long list_chats waits for one harness's list before naming its chats by id: a stalled app server never holds it. */
const TITLE_WAIT_MS = 3000;

/** @type {WeakMap<object, any>} one cached read of each harness's list per app, shared by list_sidebar and list_chats */
const shared = new WeakMap();
/** @param {any} live @param {any} claude */
function sharedSources(live, claude) {
  if (!shared.has(live)) shared.set(live, fresh(chatSources(live, claude)));
  return shared.get(live);
}

/**
 * Every chat's title as the sidebar names it, on every harness, archived ones too, for list_chats to search (a fleet
 * of chats finds each other by name). A harness whose list fails or takes longer than `wait` names none of its chats.
 * @param {any} live @param {any} claude
 * @returns {() => Promise<Map<string, string>>}
 */
function chatTitleReader(live, claude, sources = sharedSources(live, claude), wait = TITLE_WAIT_MS) {
  return async () => {
    const lists = await Promise.all(
      Object.entries(sources).map(async ([family, read]) => [
        family,
        (await within(read(true), wait).catch((error) => new Error(String(error?.message ?? error)))) ??
          new Error(`${family} list timed out`),
      ]),
    );
    const { chats } = foldSessions(nativeIdsOf(live.chats.records), Object.fromEntries(lists));
    return new Map([...chats].flatMap(([id, c]) => (c.title ? [[id, c.title]] : [])));
  };
}

/**
 * @param {import('electron').IpcMain} _ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps
 */
function register(_ipcMain, deps) {
  const { live, app } = deps;
  // list_chats names chats as this list does, on every harness (the sessions open before IPC registers, app/startup.cjs)
  if (live.peerRuntime) live.peerRuntime.titles = chatTitleReader(live, deps.claude);
  if (!live.capabilities) return;
  const file = path.join(app.getPath('userData'), 'projects.json');
  registerChatListTool(live.capabilities, {
    owner: (ctx) => ownerOf(live.chats?.records, ctx),
    // read from the file each call, so the list is the one the windows show now; nothing here writes it
    projects: () => new ProjectsStore(file).list().projects,
    home: app.getPath('home'),
    prefs: () => deps.readState?.()?.prefs ?? {},
    records: () => live.chats.records,
    natives: () => nativeIdsOf(live.chats.records),
    sources: sharedSources(live, deps.claude),
  });
}

module.exports = { register, chatSources, chatTitleReader, fresh, FRESH_MS };
