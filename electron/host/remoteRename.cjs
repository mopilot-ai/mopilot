// The person's name for a chat on a remote Host: it reaches the Host now or fails, as Stop does, because a name kept for later would be told after the chat may have moved on. The Mac keeps the name in its own record first (electron/harness/acp/rename.cjs), so a machine that is away or too old leaves the person's choice standing here and says why it did not take it.
const { refusalWords } = require('../../shared/host/refusalWords.mjs');

/** Errors that say the Host could not be reached, not that it refused. */
const AWAY = new Set(['host_unreachable', 'request_retired']);
const RENAME_AWAY = "Can't reach the machine, so it did not get the new name. The chat keeps it here.";

/**
 * What a failed call to the Host says: the table's words for a refusal (an old Host is "too old, Update it"), the Host's own sentence for a code the table lacks, or that the machine is away.
 * @param {any} error @param {string} machine
 */
function wordsOf(error, machine) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (AWAY.has(code)) return RENAME_AWAY;
  // the Host's own sentence for a missing feature names no machine: the table's words do
  const message = code === 'feature_missing' ? undefined : error?.message;
  return refusalWords(code, { machine, message, own: error?.fromHost !== true })?.line ?? (String(error?.message ?? '') || RENAME_AWAY);
}

/**
 * @param {object} o
 * @param {(chatId: string) => boolean} o.isRemote whether the chat runs on a remote Host
 * @param {(hostId: string) => any} o.hostFor the connection to the machine, if there is one
 * @param {(chatId: string) => { hostId: string }} o.ownerOf the machine that owns the chat
 * @param {(hostId: string) => string} o.machineOf the machine's name as the person knows it
 * @param {() => string} o.mintKey a new idempotency key
 */
function createRename({ isRemote, hostFor, ownerOf, machineOf, mintKey }) {
  /** @param {string} chatId @param {string} name @returns {Promise<unknown> | null} null: the chat runs here */
  return (chatId, name) => {
    if (!isRemote(chatId)) return null;
    const { hostId } = ownerOf(chatId);
    const host = hostFor(hostId);
    if (!host || host.state() !== 'online') return Promise.reject(new Error(RENAME_AWAY));
    return Promise.resolve()
      .then(() => host.rename({ chatId, name, key: mintKey() }))
      .catch((error) => {
        // `hostId` and `worded`: the sentence is final (the machine's name as its row writes it), and the window offers the machine's Update beside it
        throw Object.assign(new Error(wordsOf(error, machineOf(hostId))), { code: error?.code, hostId, worded: true });
      });
  };
}

module.exports = { createRename, RENAME_AWAY };
