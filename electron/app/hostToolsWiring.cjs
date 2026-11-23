// The directory and host tools in main (request_directory, change_directory, propose_branch, open_in_editor, reveal_path,
// request_keep_awake, get_storage_usage, clean_up_worktrees, discard_kept_worktree, sync_with_base_branch): what they read
// of the chats and the app, the keep-awake hold that ends with a chat's turn, stop, crash, deletion or archive, and the
// card (kind hostAsk) they put in front of the user. Nothing here needs a window: a chat with none open gets the same tools.
const fs = require('node:fs');
const { registerDirectoryTools } = require('../capabilities/tools/directoryTools.cjs');
const { registerHostActionTools } = require('../capabilities/tools/hostActionTools.cjs');
const { registerWorktreeTools } = require('../capabilities/tools/worktreeTools.cjs');
const { createSessionFolders } = require('../capabilities/tools/sessionFolders.cjs');
const { createDirectoryGrant } = require('../session/directoryGrant.cjs');
const { KeepAwake, IDLE_MS } = require('../platform/keepAwake.cjs');
const { createEditorLauncher, EDITOR_IDS } = require('../platform/editorLauncher.cjs');
const { createWorktreeStorage, mapLimit } = require('../platform/worktreeStorage.cjs');
const { git } = require('../platform/gitRun.cjs');
const { addHook, addGuard } = require('../session/hookChain.cjs');
const { isMomoMeta } = require('../../shared/momoChat.mjs');
const { liveChatFolders } = require('./liveChatFolders.cjs');
const worktreeArchive = require('../platform/worktreeArchive.cjs');

const FILE_MANAGER = { darwin: 'Finder', win32: 'File Explorer' };

/**
 * @param {object} o
 * @param {{ capabilities: any, chats: any, controller: any, computerUse?: any, chatDeletion?: any, claudeTurns?: any }} o.live main's late-bound services
 * @param {(ctx: any) => string | null} o.owner the chat a call came from
 * @param {(chatId: string) => Promise<string | null>} o.projectOf the chat's working directory
 * @param {() => Record<string, any>} o.prefs the user's settings
 * @param {{ dialog: any, shell: any, powerSaveBlocker?: any, app: any }} o.hostApi Electron's
 * @param {any} o.gitPlatform platform/git.cjs
 * @param {(cmd: string, args: string[]) => Promise<{ ok: boolean, stderr: string }>} o.run
 * @param {Record<string, string | undefined>} [o.winPaths]
 * @param {string} [o.platform]
 * @returns {{ keepAwake: InstanceType<typeof KeepAwake>, dispose: () => void }}
 */
function registerHostTools({ live, owner, projectOf, prefs, hostApi, gitPlatform, run, winPaths = {}, platform = process.platform }) {
  const registry = live.capabilities;
  const keepAwake = new KeepAwake({
    blocker: hostApi.powerSaveBlocker ?? null,
    // a hold's timer never keeps the app from quitting
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
  });
  const sessionFolders = createSessionFolders({
    projectOf,
    extraOf: (chatId) => {
      const dirs = live.chats.records.get(chatId)?.meta?.config?.additionalDirectories;
      return Array.isArray(dirs) ? dirs : [];
    },
  });
  /** The card: shown in the chat's own approvals, so every window shows it; none when the app can't ask. */
  const ask = async (/** @type {string} */ chatId, /** @type {AbortSignal | null} */ signal, /** @type {object} */ card) => {
    const broker = live.computerUse?.broker;
    if (!broker) return null;
    return broker.ask(chatId, 'hostAsk', { harness: live.controller.ref(chatId).kind, ...card }, { signal });
  };
  gitPlatform.setChatFolders?.(() => liveChatFolders(live, projectOf));
  worktreeArchive.setChatFolders(() => liveChatFolders(live, projectOf));
  const storage = createWorktreeStorage({
    root: () => gitPlatform.rootOf(prefs().worktreeRoot),
    list: (root) => gitPlatform.listWorktrees(root),
    remove: (wt) => gitPlatform.removeWorktree(wt),
    git,
    canonical: (p) => gitPlatform.canonical(p),
    freeBytes: async (p) => {
      const s = await fs.promises.statfs(p);
      return s.bavail * s.bsize;
    },
    // every chat's folder, read a few at a time: a worktree is in use while a chat that is not archived works in it
    chatFolders: async () => {
      // MoMo's chats never work in a managed worktree
      const ids = [...live.chats.records].filter(([, record]) => !isMomoMeta(record.meta)).map(([chatId]) => chatId);
      return mapLimit(ids, 8, async (chatId) => ({
        chatId,
        cwd: await projectOf(chatId),
        archived: typeof live.chats.records.get(chatId)?.meta?.archived === 'number',
      }));
    },
  });
  const disposers = [
    registerDirectoryTools(registry, {
      owner,
      sessionFolders,
      grant: createDirectoryGrant({ live }),
      ask,
      pickFolder: async () => {
        const r = await hostApi.dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      git,
      worktreeInfo: (p) => gitPlatform.worktreeInfo(p),
    }),
    registerHostActionTools(registry, {
      owner,
      sessionFolders,
      ask,
      editors: createEditorLauncher({ platform, exists: fs.existsSync, run, winPaths }),
      preferredEditor: () => {
        const choice = prefs().openDestination;
        return EDITOR_IDS.includes(choice) ? choice : null;
      },
      reveal: (p) => hostApi.shell.showItemInFolder(p),
      fileManager: FILE_MANAGER[/** @type {'darwin' | 'win32'} */ (platform)] ?? 'the file manager',
      keepAwake,
      idleMinutes: Math.round(IDLE_MS / 60_000),
    }),
    registerWorktreeTools(registry, { owner, storage, sessionFolders, ask, git, worktreeInfo: (p) => gitPlatform.worktreeInfo(p) }),
  ];
  // a hold ends with its turn, its idle time, or the chat: whichever harness the chat is on
  const { controller } = live;
  addGuard(controller, 'beforeDispatch', ({ chatId }) => keepAwake.turnStarted(chatId));
  addHook(controller, 'onFinished', ({ chatId }) => keepAwake.turnFinished(chatId));
  addHook(controller, 'onStopped', (chatId) => keepAwake.release(chatId));
  addHook(controller, 'onCrash', (chatId) => keepAwake.release(chatId));
  addHook(live.chats, 'onChange', (chatId, view) => {
    if (typeof view?.meta?.archived === 'number') keepAwake.release(chatId);
  });
  if (live.chatDeletion) addHook(live.chatDeletion, 'onDeleted', (receipt) => keepAwake.forget(receipt.chatId));
  hostApi.app.once('will-quit', () => keepAwake.releaseAll());
  return {
    keepAwake,
    dispose: () => {
      disposers.forEach((dispose) => dispose());
      keepAwake.releaseAll();
    },
  };
}

module.exports = { registerHostTools };
