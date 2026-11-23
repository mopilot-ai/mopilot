// Giving a chat access to another folder (request_directory, change_directory), on every harness: the folder is saved in
// the chat's own configuration, which every later turn and process reads, and Claude's live process also takes it at once.
// Codex and ACP chats apply it from their next turn; what the chat is told says which.
const { byFamily } = require('./contract/route.cjs');

/** The native process that can take a folder mid-turn: Claude's. The other adapters read the saved configuration per turn. */
const RUNTIME = { claude: (live) => live.claudeTurns?.api ?? null, codex: () => null, acp: () => null };
/** What a chat is told when its harness applies the folder later than now. */
const LATER = {
  claude: null,
  codex: 'This harness applies it from the next turn, so it may ask for approval for that folder until then.',
  acp: 'This harness may still ask for approval when it first uses that folder.',
};

/**
 * @param {{ live: { chats: any, controller: any, claudeTurns?: any } }} o
 * @returns {(chatId: string, directory: string) => Promise<{ status: 'granted' | 'saved' | 'unsaved' | 'gone', note: string | null }>}
 *   granted: usable now; saved: usable from the next turn (`note` says what to expect); unsaved: nothing was recorded
 */
function createDirectoryGrant({ live }) {
  return async (chatId, directory) => {
    const record = live.chats.records.get(chatId);
    if (!record) return { status: 'gone', note: null };
    const config = record.meta.config ?? {};
    const existing = Array.isArray(config.additionalDirectories) ? config.additionalDirectories : [];
    // read and saved with no await between, so two grants at once keep both folders
    if (
      !existing.includes(directory) &&
      // patchMeta-changes: the directory is not yet in the list, so the config changes
      !live.chats.patchMeta(chatId, { config: { ...config, additionalDirectories: [...existing, directory] } })
    )
      return { status: 'unsaved', note: null };
    const ref = live.controller.ref(chatId);
    const api = byFamily(RUNTIME, ref.kind)(live);
    if (!api) return { status: 'saved', note: byFamily(LATER, ref.kind) };
    // no running process: the next one starts with the saved folders
    if (!api.isLive(ref.key)) return { status: 'granted', note: null };
    try {
      await api.control(ref.key, 'addDirectories', live.chats.records.get(chatId).meta.config.additionalDirectories);
      return { status: 'granted', note: null };
    } catch {
      return { status: 'saved', note: 'The running process could not take it; it applies from the next turn.' };
    }
  };
}

module.exports = { createDirectoryGrant, LATER };
