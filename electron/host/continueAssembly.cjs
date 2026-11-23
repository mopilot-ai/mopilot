// Main's Switch host: the continue service (hostContinue.cjs) put together from what main already has: the side map, the machines service, this Mac's sessions and its harness-switch runner (docs: design/host/index.html, package 3.1 and 3.2).
const path = require('node:path');
const crypto = require('node:crypto');
const { clock } = require('../platform/ports/clock.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { createHostContinue } = require('./hostContinue.cjs');
const { createLocalContinue } = require('./localContinue.cjs');
const { localTurnsOf } = require('./continueHandoff.cjs');
const { createTailStore } = require('./tailStore.cjs');
const { OwnershipStore, LOCAL_HOST_ID } = require('./ownership.cjs');
const { createHostFs } = require('../../host/src/hostFs.mjs');
const { createHostGit } = require('../../host/src/hostGit.mjs');
const { createCodeChannel } = require('./codeChannel.cjs');
const { createCodeTransfer } = require('./codeTransfer.cjs');
const { mirrorFor } = require('./wiring.cjs');

/**
 * Whether this Mac runs a chat: the side map puts it here, and the Mac holds it (a session, or its records). A chat that runs on a machine has a transcript here too
 * (the mirror writes it), so the records alone say nothing about who runs it.
 * @param {{ refresh: () => void, get: (chatId: string) => { hostId: string } }} ownership
 * @param {{ sessions: { has: (chatId: string) => boolean }, chats: { records: { has: (chatId: string) => boolean } } }} live
 */
const servesOf = (ownership, live) => (chatId) => {
  ownership.refresh();
  return ownership.get(chatId).hostId === LOCAL_HOST_ID && (live.sessions.has(chatId) || live.chats.records.has(chatId));
};

/**
 * @param {object} o
 * @param {string} o.dir the user data folder
 * @param {any} o.live main's sessions: the session store, the chats' records, the switch runner and the inbox
 * @param {() => { list: () => { machines: { id: string, status: string }[] }, session: Function }} o.machines the machines service
 * @param {(problem: string) => void} o.report
 * @param {(chatId: string, harness: string) => void} [o.kept] told the agent a chat continued on a machine runs on (wiring.cjs `keepAgent`)
 * @param {(hostId: string) => Promise<null | { code: string, message: string }>} [o.lostCheck] a cloud machine is lost only when its provider says it is gone (cloudGone.cjs)
 */
function createContinueAssembly({ dir, live, machines, report, lostCheck, kept }) {
  const hostState = (/** @type {string} */ id) => {
    if (id === LOCAL_HOST_ID) return 'online';
    const row = machines()
      .list()
      .machines.find((m) => m.id === id);
    // a machine that answers but lacks an agent is still reachable; the target says what is missing
    return row && row.status !== 'offline' ? 'online' : 'offline';
  };
  const ownership = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const newKey = () => crypto.randomUUID();
  const runner = () => live.switchRunner;
  const local = createLocalContinue({
    dir: path.join(dir, 'host-continue'),
    // the handoffs of chats that come back here wait in main's inbox, which the switch runner reads on a chat's next message
    target: runner().continues.target,
    serves: servesOf(ownership, live),
    // a running turn, or a message waiting for one, keeps a chat on the Mac
    busy: (chatId) => {
      const s = live.sessions.snapshot(chatId);
      return s.turn !== 'idle' || (s.queue?.length ?? 0) > 0;
    },
    retire: async () => undefined,
    report,
  });
  const channel = createCodeChannel({
    session: (id) => machines().session(id),
    // this Mac's folders are read with the Host's own git code: a chat's folder is not bound to the roots
    localGit: createHostGit({ hostFs: createHostFs({}) }),
  });
  return createHostContinue({
    lostCheck,
    kept,
    ownership,
    hostState,
    session: (id, onEvent) => machines().session(id, onEvent),
    local: local.channel,
    localTurns: localTurnsOf(runner()),
    harnessOf: (chatId) => {
      const kind = runner().ref(chatId).kind;
      const parsed = parseKind(kind);
      if (!parsed) throw Object.assign(new Error("This chat's agent cannot be continued on another host."), { code: 'unsupported' });
      return { harness: parsed.family === 'acp' ? `acp:${parsed.basic}` : parsed.family, label: runner().label(kind) };
    },
    tails: createTailStore(path.join(dir, 'host-tails.json')),
    report,
    newKey,
    // what this app holds of a chat that runs on a machine comes from the followed chat; a chat not followed has none, and the source Host is asked
    ...mirrorFor(live),
    sleep: (ms) => new Promise((resolve) => clock.setTimeout(resolve, ms)),
    code: {
      transfer: createCodeTransfer({ ...channel, newKey, report }),
      // a chat on this Mac runs where its session runs; on a machine, in the folder the side map recorded
      sourceFolder: async (chatId, hostId) =>
        hostId === LOCAL_HOST_ID ? runner().folderOf(chatId, runner().ref(chatId)) : (ownership.get(chatId).folder ?? null),
    },
  });
}

module.exports = { createContinueAssembly, servesOf };
