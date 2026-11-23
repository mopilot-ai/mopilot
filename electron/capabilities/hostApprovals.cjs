// What a person approved on each Host, for Settings (G8 #3903): the apps always allowed on a machine and the apps allowed in a chat that runs on it, each under the machine's name, and a way to take them back. Kept apart from this Mac's list: an approval on one machine says nothing about another.
const { hostsWithGrants } = require('./hostGrants.cjs');

/**
 * @param {object} o
 * @param {(hostId: string) => any} o.grantsFor that Host's GrantStore
 * @param {(hostId: string) => string} o.nameOf
 * @param {() => string[]} [o.knownHosts] machines that have approvals on disk
 * @param {(hostId: string) => { desktop: { revoke: (chatId: string | null, bundleId: string) => boolean } } | null} [o.stackOf] a Host's live stack: its session forgets the app too
 * @param {(hostId: string) => void} [o.forget] drops a machine's approvals from disk and memory
 */
function createHostApprovals({ grantsFor, nameOf, knownHosts = () => [], stackOf = () => null, forget = () => undefined }) {
  return {
    /** Every machine with something approved: the machines this app holds approvals for, and under each the chats it holds them for (including one that moved to another machine since). @returns {{ id: string, name: string, global: any[], chats: { chatId: string, grants: any[] }[] }[]} */
    settings() {
      const ids = new Set(knownHosts().filter(Boolean));
      return [...ids].flatMap((id) => {
        const store = grantsFor(id);
        // every chat the machine holds approvals for, including one that moved to another machine since: it can still be taken back here
        const chats = store
          .chatIds()
          .map((/** @type {string} */ chatId) => ({ chatId, grants: store.chat(chatId) }))
          .filter((/** @type {{ grants: any[] }} */ c) => c.grants.length > 0);
        const global = store.global();
        return global.length || chats.length ? [{ id, name: nameOf(id), global, chats }] : [];
      });
    },
    /** @param {string} hostId @param {string | null} chatId null: the machine's always-allowed list @param {string} bundleId */
    revoke(hostId, chatId, bundleId) {
      const live = stackOf(hostId);
      return live ? live.desktop.revoke(chatId, bundleId) : grantsFor(hostId).revoke(chatId, bundleId);
    },
    /** Machines that are not in the app any more lose their approvals. @param {Set<string>} present */
    sweep(present) {
      for (const id of knownHosts()) if (!present.has(id)) forget(id);
    },
    /** @param {string} hostId */
    revokeAll: (hostId) => grantsFor(hostId).clearGlobal(),
    /** Settings' Remove on what was approved on a machine. @param {{ handle: (channel: string, fn: (e: unknown, ...args: any[]) => unknown) => void }} ipcMain */
    register(ipcMain) {
      ipcMain.handle(
        'computer:revokeOnMachine',
        (_e, machineId, chatId, bundleId) =>
          typeof machineId === 'string' &&
          typeof bundleId === 'string' &&
          !!this.revoke(machineId, typeof chatId === 'string' ? chatId : null, bundleId),
      );
      ipcMain.handle('computer:revokeAllOnMachine', (_e, machineId) => typeof machineId === 'string' && !!this.revokeAll(machineId));
    },
  };
}

module.exports = { createHostApprovals, hostsWithGrants };
