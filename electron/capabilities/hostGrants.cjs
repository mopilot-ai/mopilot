// The computer-use approvals for one Host, kept apart from this Mac's (G8 #3903): its own "Always allow" list and its own chats' grants, in files of their own. What a person allowed on a machine is not what they allowed on this Mac, and a chat's grants do not move with the chat to another machine.
const crypto = require('node:crypto');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');
const { readCheckedStore } = require('../platform/checkedStore.cjs');
const { writeAtomic, removeFiles } = require('../platform/fsutil.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { GrantStore } = require('./grants.cjs');

/**
 * The per-chat meta a GrantStore keeps (computerGrants), for chats of one Host, in a file of its own.
 * @param {string} file
 */
function hostChatMeta(file) {
  /** @type {Record<string, any> | null} */
  let map = null;
  const load = () => {
    if (map) return map;
    const { data, error } = readCheckedStore(file, "a machine's chat permissions", isJsonRecord);
    if (error) noteIgnored("read a machine's chat permissions", error);
    map = isJsonRecord(data) ? { ...data } : {};
    return map;
  };
  return {
    get: (/** @type {string} */ chatId) => (isJsonRecord(load()[chatId]) ? { meta: load()[chatId] } : null),
    ids: () => Object.keys(load()),
    patchMeta(/** @type {string} */ chatId, /** @type {Record<string, unknown>} */ patch) {
      const all = load();
      const before = isJsonRecord(all[chatId]) ? all[chatId] : {};
      // false when nothing would change (a list that stays empty counts as unchanged), as the chat store answers
      const same = Object.entries(patch).every(
        ([k, v]) => JSON.stringify(before[k] ?? (Array.isArray(v) ? [] : undefined)) === JSON.stringify(v),
      );
      if (same) return false;
      all[chatId] = { ...before, ...patch };
      writeAtomic(file, JSON.stringify(all));
      return true;
    },
  };
}

/** Where one Host's approvals are kept: the files are named by the machine, so two machines never share an approval. @param {string} dir @param {string} hostId */
const baseOf = (dir, hostId) =>
  path.join(dir, 'capabilities', `computer-host-${crypto.createHash('sha1').update(hostId).digest('hex').slice(0, 12)}`);
/** The machines that have approvals on disk, so one removed while this app was closed is found: hash -> host id. */
const indexFile = (/** @type {string} */ dir) => path.join(dir, 'capabilities', 'computer-hosts.json');
/** @param {string} dir @returns {Record<string, string>} */
function readIndex(dir) {
  const { data, error } = readCheckedStore(indexFile(dir), 'the machines with computer-use approvals', isJsonRecord);
  if (error) noteIgnored('read the machines with computer-use approvals', error);
  return isJsonRecord(data) ? /** @type {Record<string, string>} */ ({ ...data }) : {};
}

/**
 * A GrantStore for one Host, with the chats it knows about.
 * @param {{ dir: string, hostId: string, onChange?: (chatId: string | null) => void }} o dir: the user data folder
 */
function hostGrantStore({ dir, hostId, onChange }) {
  const base = baseOf(dir, hostId);
  const index = readIndex(dir);
  if (index[path.basename(base)] !== hostId) writeAtomic(indexFile(dir), JSON.stringify({ ...index, [path.basename(base)]: hostId }));
  const chats = hostChatMeta(`${base}.chats.json`);
  const store = new GrantStore({ file: `${base}.json`, chats, remote: null, onChange });
  return Object.assign(store, { chatIds: () => chats.ids() });
}

/** The machines this app holds approvals for. @param {string} dir */
const hostsWithGrants = (dir) => Object.values(readIndex(dir));

/**
 * A machine that is no longer in the app: its approvals go with it (a machine added again starts with none).
 * @param {string} dir @param {string} hostId
 */
function removeHostGrants(dir, hostId) {
  const base = baseOf(dir, hostId);
  removeFiles(`${base}.json`, `${base}.chats.json`);
  const { [path.basename(base)]: _gone, ...rest } = readIndex(dir);
  writeAtomic(indexFile(dir), JSON.stringify(rest));
}

module.exports = { hostGrantStore, hostChatMeta, hostsWithGrants, removeHostGrants };
