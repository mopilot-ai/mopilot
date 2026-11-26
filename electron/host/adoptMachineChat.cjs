// Taking in a chat only a machine's Host lists (the sidebar's "By machine" rows): this Mac records that it runs there and follows it, then the windows learn of it like a chat a scheduled run made there. The window names only the machine and the chat: the chat's id and folder come from the Mac's own index of that machine, and a machine that does not answer is refused before anything is written. A chat that was taken in and never reached a window is released again.
const { appChatId } = require('../../shared/host/chatIds.mjs');

/** @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });

/**
 * @param {object} o
 * @param {(id: string) => { name?: string, status?: string } | null | undefined} o.row the registry's row for a machine
 * @param {() => { machineId: string, rows: { chatId: string, folder?: string, epoch?: number }[] }[]} o.index what the Mac's index holds of every machine's chats
 * @param {(chatId: string) => string} o.owner where this Mac says the chat runs now: a machine's id, or 'local'
 * @param {(chatId: string) => boolean} o.has whether this Mac has a record of the chat (a chat it has is never released)
 * @param {(chatId: string) => boolean} o.takenIn whether the chat's binding says it was taken in from a machine's list (a chat started here, or starting there, is never released)
 * @param {() => { takeIn: (chatId: string, at: { hostId: string, folder: string, epoch?: number }) => Promise<void>, release?: (chatId: string) => void, setEpoch?: (chatId: string, epoch: number) => void } | null | undefined} o.machineChats main's `live.machineChats`; none while Host is not wired
 * @param {(e: { harness: 'acp', chatId: string, cwd: string, worktreeOf: null, hostId: string, projectId: null }) => void} o.announce
 * @returns {{ open: (machineId: unknown, chatId: unknown) => Promise<{ chatId: string }>, release: (machineId: unknown, chatId: unknown) => Promise<{ released: boolean }> }}
 */
function createAdoptMachineChat({ row, index, owner, has, takenIn, machineChats, announce }) {
  /** The row the machine lists for the chat, or the refusal that says why there is none. @param {unknown} machineId @param {unknown} chatId */
  function listedBy(machineId, chatId) {
    if (typeof machineId !== 'string' || !machineId || typeof chatId !== 'string' || !chatId) throw refusal('Which chat?', 'bad_request');
    const machine = row(machineId);
    if (!machine) throw refusal('That machine is not in the list.', 'unknown_machine');
    const name = machine.name ?? machineId;
    const listed = index()
      .find((e) => e.machineId === machineId)
      ?.rows.find((r) => r.chatId === chatId);
    return { machine, name, listed, machineId, chatId };
  }
  return {
    async open(machineId, chatId) {
      const chats = machineChats();
      if (!chats) throw refusal('Host is not available for this account.', 'not_allowed');
      const { machine, name, listed } = listedBy(machineId, chatId);
      if (machine.status === 'offline') throw refusal(`${name} is offline. Open it again once it is connected.`, 'machine_offline');
      if (!listed) throw refusal(`${name} does not list that chat any more.`, 'unknown_chat');
      const id = appChatId(listed.chatId);
      // a chat this Mac already has is never moved to another machine by a click on a row
      const held = owner(id);
      if (held !== 'local' && held !== machineId) throw refusal('This Mac already runs that chat on another machine.', 'owned_elsewhere');
      const folder = typeof listed.folder === 'string' ? listed.folder : '';
      if (held === 'local') {
        if (!folder) throw refusal(`${name} has not said which folder that chat is in.`, 'no_folder');
        await chats.takeIn(id, {
          hostId: String(machineId),
          folder,
          ...(Number.isSafeInteger(listed.epoch) ? { epoch: listed.epoch } : {}),
        });
      } else if (Number.isSafeInteger(listed.epoch)) {
        // already bound here: the epoch the machine holds now, not the one it held when the chat was taken in
        chats.setEpoch?.(id, /** @type {number} */ (listed.epoch));
      }
      // a chat already bound here and a row with no folder: the windows keep the folder their record has, never an empty one
      if (folder || held === 'local')
        announce({ harness: 'acp', chatId: id, cwd: folder, worktreeOf: null, hostId: String(machineId), projectId: null });
      return { chatId: id };
    },
    /** A chat taken in whose record never reached the window: unbound and no longer followed, only if this Mac has no record of it and it is bound to that machine. */
    async release(machineId, chatId) {
      const chats = machineChats();
      if (!chats) throw refusal('Host is not available for this account.', 'not_allowed');
      const { listed } = listedBy(machineId, chatId);
      const id = appChatId(listed?.chatId ?? /** @type {string} */ (chatId));
      if (has(id) || !takenIn(id) || owner(id) !== machineId) return { released: false };
      chats.release?.(id);
      return { released: true };
    },
  };
}

module.exports = { createAdoptMachineChat };
