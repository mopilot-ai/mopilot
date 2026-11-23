// MoMo's data stores as Reset MoMo sees them (#2139): every place MoMo keeps data on this Mac registers here how to delete it, and Reset (electron/app/ipc/momoReset.cjs) goes through all of them in main. A store this build doesn't have registered is reported as not reset, never as done. tests/momoStores.test.ts keeps every MoMo store module in this list; each reset leaves its store working in the same process (it makes its folder again on the next write, or the reset reopens it), which tests/momoResetRecovery.test.ts checks for every store.
const { fs: nodeFs } = require('../platform/ports/fs.cjs');
const path = require('node:path');

/**
 * Every MoMo store, in the order Reset deletes them, with what the user is told it is. Each is kept under MoMo's folder
 * (momoDir) and registered by main's MoMo services (electron/app/momo.cjs); electron/app/ipc/momoReset.cjs registers folder
 * defaults first for memory and sources.
 * @typedef {'memory' | 'sources' | 'connectors' | 'routines' | 'approvals' | 'audit' | 'history' | 'chats'} MomoStoreId
 * @typedef {{ id: MomoStoreId, label: string }} MomoStoreInfo
 * @typedef {() => Promise<void> | void} MomoStoreReset deletes everything the store keeps; throws when it couldn't
 * @typedef {{ reset: MomoStoreInfo[], notReset: (MomoStoreInfo & { reason: 'absent' | 'failed' })[] }} MomoStoresResult
 */
/** @type {readonly MomoStoreInfo[]} */
const MOMO_STORES = Object.freeze([
  { id: 'memory', label: "MoMo's memory" },
  { id: 'sources', label: 'its copies of your sources and the files it made' },
  { id: 'connectors', label: 'connected accounts' },
  { id: 'routines', label: 'routines' },
  { id: 'approvals', label: 'remembered approvals and always-allowed sites' },
  { id: 'audit', label: 'the audit log' },
  { id: 'history', label: 'its index of past chats' },
  { id: 'chats', label: "MoMo's chats" },
]);

/**
 * MoMo's one folder on this Mac: every MoMo store and every Reset registration is under it. Inside the app's data folder,
 * so a dev or test instance (its own userData) never shares the user's MoMo data, and the owner-only pass over the data
 * folder covers it.
 * @param {string} userData Electron's app.getPath('userData')
 */
const momoDir = (userData) => path.join(userData, 'momo');
/** The folder MoMo's chats run in (mainChat.cjs), under MoMo's folder `dir`: a harness switch starts a MoMo chat's new session there too. */
const momoWorkspace = (dir) => path.join(dir, 'workspace');

/** @type {Map<MomoStoreId, MomoStoreReset>} */
const resets = new Map();
/** A reset is running (electron/app/ipc/momoReset.cjs): MoMo stays paused until it ends. */
let resetting = false;
const momoResetting = () => resetting;
/** Marks a reset running while `fn` runs, whatever way it ends. @template T @param {() => Promise<T>} fn */
async function whileResetting(fn) {
  resetting = true;
  try {
    return await fn();
  } finally {
    resetting = false;
  }
}

/**
 * Registers how a MoMo store is deleted; a later registration for the same store replaces it (a service made at
 * startup over the default). Returns the unregister, which only removes this registration.
 * @param {MomoStoreId} id
 * @param {MomoStoreReset} reset
 */
function registerMomoStore(id, reset) {
  if (!MOMO_STORES.some((s) => s.id === id)) throw new Error(`Not a MoMo store: ${String(id)}`);
  if (typeof reset !== 'function') throw new Error(`MoMo store ${id} needs a reset`);
  resets.set(id, reset);
  return () => {
    if (resets.get(id) === reset) resets.delete(id);
  };
}

/**
 * Deletes every registered store, in order, each even after another failed.
 * @param {{ onError?: (id: MomoStoreId, error: unknown) => void }} [o]
 * @returns {Promise<MomoStoresResult>}
 */
async function resetMomoStores({ onError } = {}) {
  /** @type {MomoStoresResult} */
  const out = { reset: [], notReset: [] };
  for (const info of MOMO_STORES) {
    const reset = resets.get(info.id);
    if (!reset) {
      out.notReset.push({ ...info, reason: 'absent' });
      continue;
    }
    try {
      await reset();
      out.reset.push(info);
    } catch (error) {
      onError?.(info.id, error);
      out.notReset.push({ ...info, reason: 'failed' });
    }
  }
  return out;
}

/**
 * A store kept in a folder of its own (the sources hub's <momo dir>/sources): once `idle` resolves, the whole folder is
 * deleted.
 * @param {string} dir
 * @param {{ idle?: () => Promise<unknown>, fs?: Pick<typeof nodeFs, 'rmSync'> }} [o]
 * @returns {MomoStoreReset}
 */
function folderReset(dir, { idle, fs = nodeFs } = {}) {
  return async () => {
    await idle?.();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

/** What MoMo's removed Feed and Topics kept: the Feed's sealed file (and the copies set aside of a damaged one) and the topics folder. */
const FEED_FILE = /^feed\.json(\..+)?$/;

/**
 * Deletes what MoMo's removed Feed and Topics left in MoMo's folder `dir`: feed.json (with any copy set aside) and the
 * topics folder. Nothing else is touched, and nothing there is not an error. Run at startup and by Reset's routines store,
 * so data from before stays deletable.
 * @param {string} dir
 * @param {{ fs?: Pick<typeof nodeFs, 'readdirSync' | 'rmSync'> }} [o]
 */
function removeFeedAndTopicFiles(dir, { fs = nodeFs } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    // no folder: nothing was ever kept
    if (/** @type {any} */ (error)?.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (FEED_FILE.test(name)) fs.rmSync(path.join(dir, name), { force: true });
    else if (name === 'topics') fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** MoMo's memory files (electron/momo/memory.cjs FILES and FACTS_FILE, memoryLog.cjs CHANGES_FILE, the memory pass's progress, backgroundBudget.cjs's day of tokens, factAliases.cjs's aliases, openLoops.cjs's open loops, nudges.cjs's delivered and dismissed nudges) and the copies it keeps of unreadable ones. */
const MEMORY_FILE =
  /^(about-you\.md|persona\.md|facts\.jsonl|changes\.jsonl|memory-pass\.json(\.lock)?|background-tokens\.json(\.lock)?|fact-aliases\.json(\.lock)?|open-loops\.json(\.lock)?|nudges\.json(\.lock)?)(\.unreadable-\d+(-\d+)?)?$/;

/**
 * The memory folder's reset: once `idle` resolves (the store's queued writes, when there is a store), every memory file
 * and every copy of an unreadable one is deleted, readable or not; nothing else in the folder is touched.
 * @param {string} dir
 * @param {{ idle?: () => Promise<unknown>, fs?: Pick<typeof nodeFs, 'readdirSync' | 'rmSync'> }} [o]
 * @returns {MomoStoreReset}
 */
function memoryFilesReset(dir, { idle, fs = nodeFs } = {}) {
  return async () => {
    await idle?.();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      // no folder: nothing was ever kept
      if (/** @type {any} */ (error)?.code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) if (MEMORY_FILE.test(name)) fs.rmSync(path.join(dir, name), { force: true });
  };
}

module.exports = {
  MOMO_STORES,
  momoDir,
  momoWorkspace,
  registerMomoStore,
  resetMomoStores,
  memoryFilesReset,
  folderReset,
  removeFeedAndTopicFiles,
  momoResetting,
  whileResetting,
};
