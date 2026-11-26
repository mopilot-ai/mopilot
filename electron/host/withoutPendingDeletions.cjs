// The Mac's chat index minus the chats this app has deleted and the machine has not yet been told to delete (the durable deletion outbox): the machine keeps listing them while it is away, and a row for one must not bring a deleted chat back, in this run or after the app starts again.
const { appChatId } = require('../../shared/host/chatIds.mjs');

/**
 * @template {{ machineId: string, rows: { chatId: string }[] }} E
 * @param {E[]} entries the index, a machine's entry each
 * @param {{ hostId: string, chatId: string }[]} pending the deletions still waiting for their machine (by this app's chat id; a row names the chat by the Host's)
 * @returns {E[]}
 */
function withoutPendingDeletions(entries, pending) {
  if (!pending.length) return entries;
  const gone = new Set(pending.map((p) => `${p.hostId}\n${p.chatId}`));
  return entries.map((e) => {
    const rows = e.rows.filter((r) => !gone.has(`${e.machineId}\n${appChatId(r.chatId)}`));
    return rows.length === e.rows.length ? e : { ...e, rows };
  });
}

module.exports = { withoutPendingDeletions };
