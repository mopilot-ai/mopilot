// A turn in a chat whose project folder was deleted, on every harness and with no window open: a managed worktree comes
// back from its kept branch (with the project's setup script) before the harness starts there; any other missing folder
// is refused, saying so, where the harness would fail with its own unrelated error (the Claude Agent SDK reports spawn's
// ENOENT for a missing cwd as a libc mismatch).
const { fs } = require('../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const git = require('../platform/git.cjs');
const { setupScriptOf } = require('../platform/chatStart.cjs');

/**
 * What a chat whose folder `cwd` is gone shows instead of sending.
 * @param {string} cwd
 * @param {string | null} [why] what kept its worktree from coming back
 */
const missingFolderError = (cwd, why = null) =>
  `This chat's folder no longer exists: ${JSON.stringify(cwd)}.${why ? ` Its worktree couldn't be restored: ${why}.` : ''} Restore the folder, or continue in a new chat.`;

/**
 * What a chat's folder depends on: its current segment (chatProject reads that one) and the project its worktree came
 * from. Any other meta write (a held goal, unread, a pin) commits a new record but keeps the folder, so it is no change.
 * @param {{ segments?: { kind: string, nativeId: string }[], meta?: { worktreeOf?: string | null } } | undefined} rec
 */
const folderOf = (rec) => {
  if (!rec) return null;
  const seg = rec.segments?.at(-1);
  return JSON.stringify([seg?.kind ?? null, seg?.nativeId ?? null, rec.meta?.worktreeOf ?? null]);
};

/**
 * A ChatController beforeDispatch step. A folder that can't be read (null) is left to the harness, so a failed read never
 * refuses a send; restores of one folder at once share one attempt.
 * @param {{ chatProject: (chatId: string) => Promise<string | null>, state: () => any, home?: string,
 *           chats?: () => { records: Map<string, { meta?: { worktreeOf?: string | null } }>,
 *             patchMeta?: (chatId: string, patch: { worktreeOf: string }) => boolean } | null,
 *           exists?: (p: string) => boolean, restore?: typeof git.worktreeRestore,
 *           setupScript?: (repo: string) => string, runScript?: (cwd: string, script: string) => Promise<{ exitCode: number, output: string }> }} o
 *   chatProject: the folder of the chat's current segment (electron/session/chatProject.cjs); state: the app's saved
 *   state, whose prefs name the worktree root and branch prefix as Settings has them
 * @returns {(e: { chatId: string }) => Promise<void>}
 */
function chatFolderGuard({
  chatProject,
  state,
  chats = () => null,
  home = os.homedir(),
  exists = fs.existsSync,
  restore = git.worktreeRestore,
  setupScript = setupScriptOf,
  runScript = git.runScript,
}) {
  /** @type {Map<string, { repo: string | null, promise: Promise<void> }>} */
  const restoring = new Map();
  const changedFolder = () => new Error("This chat's project changed. Try sending again.");
  async function repositoryOf(chatId, cwd) {
    const store = chats();
    let target = folderOf(store?.records.get(chatId));
    const current = () => chats() === store && folderOf(store?.records.get(chatId)) === target;
    const known = store?.records.get(chatId)?.meta?.worktreeOf;
    if (!store || known) return { repo: known ?? null, current };
    // Older forks lost this link. Another saved chat in exactly this folder can supply it, on any harness.
    const sources = [];
    for (const [id, record] of [...store.records]) {
      const repo = record.meta?.worktreeOf;
      if (!repo || (await chatProject(id)) !== cwd) continue;
      sources.push({ id, folder: folderOf(record), repo });
    }
    if (!current()) throw changedFolder();
    // A later source read may have retired an earlier source: validate every proof at publication.
    const origins = new Set(sources.filter(({ id, folder }) => folderOf(store.records.get(id)) === folder).map(({ repo }) => repo));
    if (origins.size > 1) throw new Error(missingFolderError(cwd, 'Saved chats disagree about which project owns this worktree'));
    const repo = origins.values().next().value ?? null;
    if (repo) {
      if (!store.patchMeta?.(chatId, { worktreeOf: repo })) throw new Error("Couldn't save this chat's project folder. Try again.");
      target = folderOf(store.records.get(chatId));
    }
    return { repo, current };
  }
  async function bringBack(cwd, repo) {
    const p = state()?.prefs || {};
    const r = await restore(cwd, p.worktreeRoot || path.join(home, '.mopilot', 'worktrees'), repo, p.branchPrefix ?? null);
    if (!r.ok)
      throw Object.assign(new Error(missingFolderError(cwd, r.error === 'Not a MoPilot worktree' ? null : (r.error ?? null))), {
        missingWorktreeOrigin: !repo && r.error === 'The project folder is gone',
      });
    if (!r.restored) return;
    // a restored worktree names its project and folder
    const script = setupScript(/** @type {string} */ (r.repo));
    if (!script) return;
    const result = await runScript(/** @type {string} */ (r.worktree), script);
    if (result.exitCode !== 0)
      throw new Error(`Restored this chat's worktree, but its setup script failed (exit ${result.exitCode}): ${result.output.trim()}`);
  }
  async function restoreFolder(cwd, repo, current) {
    if (!current()) throw changedFolder();
    const running = restoring.get(cwd);
    if (running) {
      if (repo && running.repo && repo !== running.repo)
        throw new Error(missingFolderError(cwd, 'Another chat is restoring this worktree for a different project'));
      try {
        await running.promise;
      } catch (error) {
        // A caller with a known origin can retry after a marker-only attempt failed, never alongside it.
        if (!repo || running.repo || !error?.missingWorktreeOrigin) throw error;
        return restoreFolder(cwd, repo, current);
      }
      if (!current()) throw changedFolder();
      return;
    }
    const promise = bringBack(cwd, repo).finally(() => restoring.delete(cwd));
    restoring.set(cwd, { repo, promise });
    await promise;
    if (!current()) throw changedFolder();
  }
  return async ({ chatId }) => {
    const store = chats();
    const target = folderOf(store?.records.get(chatId));
    const cwd = await chatProject(chatId);
    if (chats() !== store || folderOf(store?.records.get(chatId)) !== target) throw changedFolder();
    if (!cwd || (exists(cwd) && !restoring.has(cwd))) return;
    const { repo, current } = await repositoryOf(chatId, cwd);
    await restoreFolder(cwd, repo, current);
  };
}

module.exports = { chatFolderGuard, missingFolderError };
