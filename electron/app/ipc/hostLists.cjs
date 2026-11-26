// The lists the windows read of the machines: the machines themselves and each one's chats (electron/host/chatIndex.cjs); both are empty while Host access is closed. And the one call a row of those chats makes: take a chat only its machine knows into this Mac's list.
const { createAdoptMachineChat } = require('../../host/adoptMachineChat.cjs');
const { machineChatAdoption } = require('../machineChatAdoption.cjs');
const { withoutPendingDeletions } = require('../../host/withoutPendingDeletions.cjs');

const NONE = Object.freeze({ machines: [], resolved: true });

/** @param {{ ipcMain: { handle: (channel: string, fn: (...a: any[]) => unknown) => void }, handle: (channel: string, fn: (...a: any[]) => unknown) => void, allowed: () => boolean, service: () => { list: () => unknown, chatIndex: () => unknown, row: (id: string) => unknown }, live?: () => any, chats?: any, folders?: any, deps?: any }} o */
function registerHostLists({ ipcMain, handle, allowed, service, chats, folders, deps }) {
  const live = () => deps?.live;
  const pending = () => chats?.pendingDeletions() ?? [];
  const has = (/** @type {string} */ id) => !!live()?.chats?.get(id);
  const adoption = machineChatAdoption({ folders, chats: () => chats, deps, service: () => ({ chatIndex: indexOf }) });
  // once, at the first read of the list: a chat taken in that no window ever gave a record is not kept bound to its machine
  let swept = false;
  /** @param {unknown} [open] the chats the reading window has open or selected (told with the read): the sweep keeps their bindings */
  function indexOf(open) {
    if (!swept && allowed() && live()?.chats?.get) {
      swept = true;
      const shown = new Set(Array.isArray(open) ? open.filter((id) => typeof id === 'string').slice(0, 64) : []);
      adoption.sweep((id) => has(id) || shown.has(id) || !!live()?.remoteSend?.hasPending?.(id));
    }
    return withoutPendingDeletions(/** @type {any[]} */ (service().chatIndex()), pending());
  }
  ipcMain.handle('host:machines', () => (allowed() ? service().list() : NONE));
  ipcMain.handle('host:chatIndex', (_e, open) => (allowed() ? indexOf(open) : []));
  const adopt = createAdoptMachineChat({
    row: (id) => /** @type {any} */ (service().row(id)),
    index: indexOf,
    has,
    takenIn: (id) => adoption.takenIn(id),
    owner: (id) => live()?.hostOwnership?.get(id)?.hostId ?? 'local',
    machineChats: () => (allowed() ? live()?.machineChats : null),
    announce: (e) => live()?.announceRunChat?.(e),
  });
  // the Host IPC's own handler: the gate, and an error in the one shape the bridge's `call` reads
  handle('host:openChat', (machineId, chatId) => adopt.open(machineId, chatId));
  handle('host:releaseChat', (machineId, chatId) => adopt.release(machineId, chatId));
  // what taking a chat in leaves in this app's records: the live services hand it to the send path
  return { adoption };
}

module.exports = { registerHostLists, registeredBy: 'host' };
