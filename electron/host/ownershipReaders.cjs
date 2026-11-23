// Reading which Host owns a chat from the ownership side file: its capabilities for the tool registry, its owner for the host chip, and where it runs now. The file is read again on each ask (another process may have moved the chat), and every reader says "this Mac" while Host is not available.
const path = require('node:path');
const { fileStamp } = require('../platform/fsutil.cjs');
const { OwnershipStore, LOCAL_HOST_ID } = require('./ownership.cjs');

/**
 * Which surfaces a chat's owner Host has, for the tool registry: null (no limit) for a chat that runs here or while Host is off, else what the
 * owner machine declared. The ownership file is read again each time, since another process may have moved the chat.
 * @param {{ dir: string, allowed: () => boolean, machines: () => { capabilities: (id: string) => Record<string, boolean> } }} o
 */
function chatCapabilities({ dir, allowed, machines }) {
  /** @type {InstanceType<typeof OwnershipStore> | null} */
  let ownership = null;
  return (/** @type {string} */ chatId) => {
    if (!allowed()) return null;
    ownership ??= new OwnershipStore(path.join(dir, 'host-ownership.json'));
    ownership.refresh();
    const { hostId } = ownership.get(chatId);
    return hostId === LOCAL_HOST_ID ? null : machines().capabilities(hostId);
  };
}

/** Which Host holds a chat, for the host chip and the Switch host dialog: read from the ownership side file each time, since a continue (this window's or another's) may have moved it.
 * @param {object} o
 * @param {string} o.dir the user data dir that holds host-ownership.json
 * @param {() => boolean} o.allowed Host's closed-alpha gate
 * @returns {(chatId: unknown) => { hostId: string, epoch: number } | null} null while Host is not available or for an id that is not a chat id
 */
function chatOwner({ dir, allowed }) {
  /** @type {InstanceType<typeof OwnershipStore> | null} */
  let ownership = null;
  return (chatId) => {
    if (!allowed() || typeof chatId !== 'string' || !chatId) return null;
    ownership ??= new OwnershipStore(path.join(dir, 'host-ownership.json'));
    ownership.refresh();
    const { ownerHostId, epoch } = ownership.get(chatId);
    return { hostId: ownerHostId, epoch };
  };
}

/** The Host a chat runs on now (not the one that holds it during a handover), read from the ownership side file each time: where its browser is.
 * @param {object} o
 * @param {string} o.dir the user data dir that holds host-ownership.json
 * @param {() => boolean} o.allowed Host's closed-alpha gate
 * @returns {{ get: (chatId: string) => { hostId: string, epoch?: number } }} this Mac's id (and no epoch) while Host is not available; otherwise the epoch the machine checks every request of the chat against
 */
function hostOwnership({ dir, allowed }) {
  const file = path.join(dir, 'host-ownership.json');
  /** @type {InstanceType<typeof OwnershipStore> | null} */
  let ownership = null;
  /** The file's time and size when it was last read: it is asked about for every event of every chat, so it is read again only when they change. @type {string | null} */
  let seen = null;
  return {
    get(chatId) {
      if (!allowed()) return { hostId: LOCAL_HOST_ID };
      ownership ??= new OwnershipStore(file);
      const now = fileStamp(file);
      if (now !== seen) {
        ownership.refresh();
        seen = now;
      }
      return (({ hostId, epoch }) => ({ hostId, epoch }))(ownership.get(chatId));
    },
  };
}

module.exports = { chatCapabilities, chatOwner, hostOwnership };
