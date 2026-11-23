// Which chats run on a remote machine, for the app's panels (host:remoteChats): one read of the ownership side file answers a whole list.
const path = require('node:path');
const { OwnershipStore } = require('./ownership.cjs');

/** Every chat that runs on a remote machine, read from the ownership side file each time (one read for all, so a long chat list does not ask once per row).
 * @param {object} o
 * @param {string} o.dir the user data dir that holds host-ownership.json
 * @param {() => boolean} o.allowed Host's closed-alpha gate
 * @returns {() => { chatId: string, hostId: string }[]} none while Host is not available
 */
function remoteChatOwners({ dir, allowed }) {
  /** @type {InstanceType<typeof OwnershipStore> | null} */
  let ownership = null;
  return () => {
    if (!allowed()) return [];
    ownership ??= new OwnershipStore(path.join(dir, 'host-ownership.json'));
    ownership.refresh();
    return ownership.owned();
  };
}

module.exports = { remoteChatOwners };
