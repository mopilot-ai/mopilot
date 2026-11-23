// A chat's built-in browser folders (capabilities/browser-uploads|browser-downloads/<chat>): the agent saves what it uploads there and the browser saves downloads there, so they hold copies of the user's files (#2144). They can't be encrypted (the agent and the page's file chooser read them by path), so they don't stay: a chat's folders go when it is deleted or archived, and a file untouched for KEEP_MS goes.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');
const { addHook } = require('../../session/hookChain.cjs');

const KINDS = ['browser-uploads', 'browser-downloads', 'browser-traces'];
const KEEP_MS = 7 * 86_400_000;
/** The first sweep, after startup's work, and then how often. */
const SWEEP_FIRST_MS = 60_000;
const SWEEP_EVERY_MS = 3_600_000;

/** A chat's folder name: its id with anything but letters, digits and . _ - made _, at most 120 characters. */
const chatFolderName = (/** @type {string} */ chatId) =>
  String(chatId)
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 120) || 'chat';

/** The chat's folder of one kind under `root` (the capabilities folder). */
const chatFolder = (/** @type {string} */ root, /** @type {string} */ kind, /** @type {string} */ chatId) =>
  path.join(root, kind, chatFolderName(chatId));

/**
 * Deletes the chat's upload and download folders (it was deleted), unless another chat's id makes the same folder
 * name (as the sweep's archivedFolders): those files may be that chat's, and the sweep ages them out.
 * @returns {boolean} whether they went
 */
function removeChatFolders(
  /** @type {string} */ root,
  /** @type {string} */ chatId,
  /** @type {{ records?: Map<string, any> } | null | undefined} */ chats = null,
) {
  const name = chatFolderName(chatId);
  for (const id of chats?.records?.keys() ?? []) if (id !== chatId && chatFolderName(id) === name) return false;
  for (const kind of KINDS) fs.rmSync(chatFolder(root, kind, chatId), { recursive: true, force: true });
  return true;
}

/**
 * When a file or folder was last put there or changed: the newest of its times, since a move or a copy that keeps
 * times (mv, cp -p, Finder) brings an old modification time along. A chmod moves ctime too: the start that first makes
 * these files owner-only (privateFiles.tightenTree) restarts their clock, so nothing ages out for KEEP_MS after it.
 */
const touched = (/** @type {import('node:fs').Stats} */ st) => Math.max(st.mtimeMs, st.ctimeMs, st.birthtimeMs);

/**
 * Removes what under `dir` was last touched before `before`: files, and folders left empty that are that old too;
 * never follows a link. `dir` itself stays (the agent may have just been told its path).
 */
async function prune(/** @type {string} */ dir, /** @type {number} */ before, fsp = fs.promises, top = true) {
  let left = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const st = await fsp.lstat(p);
    if (st.isDirectory() ? await prune(p, before, fsp, false) : touched(st) < before && (await fsp.rm(p, { force: true }), true)) continue;
    left++;
  }
  if (top || left || touched(await fsp.lstat(dir)) >= before) return false;
  await fsp.rmdir(dir);
  return true;
}

/**
 * One sweep: the folders of archived chats are deleted whole; in the others a file untouched for `keepMs` goes (the
 * chat's folder itself stays). A folder whose chat is unknown (deleted while the app was closed, or a store not read
 * yet) is only aged out, so a chat at work never loses its files. A failure on one folder is recorded and the rest go on.
 * @param {{ root: string, archived: (folderName: string) => boolean, now?: number, keepMs?: number, fsp?: typeof fs.promises }} o
 * @returns {Promise<number>} how many archived chats' folders went
 */
async function sweepChatFolders({ root, archived, now = Date.now(), keepMs = KEEP_MS, fsp = fs.promises }) {
  let gone = 0;
  for (const kind of KINDS) {
    let names = [];
    try {
      names = await fsp.readdir(path.join(root, kind));
    } catch (error) {
      noteIgnored('list the browser folders of chats', error, ['ENOENT']);
    }
    for (const name of names) {
      const dir = path.join(root, kind, name);
      try {
        if (archived(name)) {
          await fsp.rm(dir, { recursive: true, force: true });
          gone++;
        } else if ((await fsp.lstat(dir)).isDirectory()) await prune(dir, now - keepMs, fsp);
      } catch (error) {
        // gone meanwhile (ENOENT): nothing left to remove
        noteIgnored("remove a chat's old browser files", error, ['ENOENT']);
      }
    }
  }
  return gone;
}

/**
 * The folder names of archived chats (ChatsStore meta.archived), for the sweep: a name only when every chat with that
 * folder name is archived, so a live chat whose id makes the same name keeps its files.
 */
function archivedFolders(/** @type {{ records?: Map<string, any> } | null | undefined} */ chats) {
  const archived = new Set();
  const live = new Set();
  for (const [id, rec] of chats?.records ?? []) (typeof rec?.meta?.archived === 'number' ? archived : live).add(chatFolderName(id));
  for (const name of live) archived.delete(name);
  return archived;
}

/**
 * Keeps chats' browser folders from staying: a deleted chat's go at once (ChatDeletion onDeleted; a folder that can't
 * be removed never fails the deletion, the sweep ages it out), and a sweep after startup and every hour removes
 * archived chats' folders and files untouched for KEEP_MS. Archiving takes a chat's files at once (the user's choice
 * on #2144), and unarchiving does not bring them back. Timers don't keep the app running.
 * @param {{ root: string, chats: { records?: Map<string, any> } | null | undefined, deletion?: Record<string, any> | null, timers?: { setTimeout: typeof setTimeout, setInterval: typeof setInterval } }} o
 * @returns {() => Promise<number>} one sweep now
 */
function retainChatFolders({ root, chats, deletion, timers = globalThis }) {
  if (deletion)
    addHook(deletion, 'onDeleted', (/** @type {{ chatId: string }} */ receipt) => {
      try {
        removeChatFolders(root, receipt.chatId, chats);
      } catch (error) {
        noteIgnored("remove a deleted chat's browser files", error);
      }
    });
  // never rejects: each folder's failure is recorded where it happens
  const sweep = () => {
    const names = archivedFolders(chats);
    return sweepChatFolders({ root, archived: (name) => names.has(name) });
  };
  timers.setTimeout(sweep, SWEEP_FIRST_MS).unref?.();
  timers.setInterval(sweep, SWEEP_EVERY_MS).unref?.();
  return sweep;
}

module.exports = { KINDS, KEEP_MS, chatFolderName, chatFolder, removeChatFolders, sweepChatFolders, retainChatFolders };
