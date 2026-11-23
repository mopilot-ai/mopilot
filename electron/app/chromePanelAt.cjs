// The chats and files an @ menu offers a phone's composer (remote method mentions.list): as the app's composer lists them, a few recent chats for a bare @ and title matches while typing, and the files of the chat's folder ranked by the typed name.
const { searchFiles } = require('../platform/search.cjs');

/** How many chats a bare @ lists, how many while typing, and how many files: the app's composer's numbers. */
const CHATS_EMPTY = 3;
const CHATS_TYPING = 8;
const FILES = 12;
/** How many recent chats are searched by title (the most a phone may list). */
const SEARCHED = 200;

/**
 * @param {object} d
 * @param {(limit: number, archived: boolean) => Promise<{ id: string, title: string | null }[]>} d.recent the sidebar's chats, newest first
 * @param {(chatId: string) => Promise<string | null>} d.cwdOf the chat's folder (null when it has none)
 * @param {(cwd: string, query: string, o: { limit: number }) => Promise<{ files: { path: string, file_name: string, match_type: string }[] }>} [d.search]
 */
function createPanelAt({ recent, cwdOf, search = searchFiles }) {
  return listed({ recent, search, folderOf: ({ chatId }) => cwdOf(chatId), skip: ({ chatId }) => chatId });
}

/**
 * The same lists for a chat about to start: the files of the saved project's folder (none without a project).
 * @param {object} d
 * @param {(limit: number, archived: boolean) => Promise<{ id: string, title: string | null }[]>} d.recent
 * @param {(projectId: string | null) => string | null} d.projectCwd the saved project's folder
 * @param {(cwd: string, query: string, o: { limit: number }) => Promise<{ files: { path: string, file_name: string, match_type: string }[] }>} [d.search]
 */
function createPanelStartAt({ recent, projectCwd, search = searchFiles }) {
  return listed({ recent, search, folderOf: async ({ projectId }) => projectCwd(projectId ?? null), skip: () => null });
}

function listed(/** @type {any} */ { recent, search, folderOf, skip }) {
  return async (/** @type {any} */ scope) => {
    const { query } = scope;
    const term = query.toLowerCase();
    const [chats, cwd] = await Promise.all([recent(SEARCHED, false), folderOf(scope)]);
    const files = cwd ? (await search(cwd, query, { limit: FILES })).files : [];
    const self = skip(scope);
    return {
      chats: chats
        .filter((c) => c.id !== self && c.title && (!term || c.title.toLowerCase().includes(term)))
        .slice(0, term ? CHATS_TYPING : CHATS_EMPTY)
        .map((c) => ({ id: c.id, title: String(c.title) })),
      files: files.map((f) => ({ path: f.path, name: f.file_name, directory: f.match_type === 'directory' })),
    };
  };
}

module.exports = { createPanelAt, createPanelStartAt };
