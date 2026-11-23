// The Host process's continue pieces (docs: design/host/index.html, package 3.1): the owner file, the target that keeps handoffs, and the continue Host over this Host's ACP runtime, epochs and ledger.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createContinueHost } from './continue.mjs';
import { createAgentCheck } from '../../shared/host/continueFamilies.mjs';
import { createContinueTarget } from './continueTarget.mjs';
import { createOwnerStore } from './owners.mjs';
import { hostChatId } from '../../shared/host/chatIds.mjs';
import { rekeyContinueState } from './continueRekey.mjs';

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {ReturnType<typeof import('./acp.mjs').createAcpRuntime>} o.runtime
 * @param {ReturnType<typeof import('./hostFs.mjs').createHostFs>} o.hostFs
 * @param {{ chats: ReturnType<typeof import('./sessions.mjs').createHostSessions>['chatRuntime'], harnesses: Parameters<typeof createAgentCheck>[0]['rows'] }} [o.families] a Host that takes a continue for every family: its chats (what it serves, what holds it, how it lets go and how a continued chat is bound, ./continueRuntime.mjs) and its agents as its status reports them; without it only the ACP host's chats move
 * @param {ReturnType<typeof import('./epochs.mjs').createEpochStore>} o.epochs
 * @param {ReturnType<typeof import('./ledger.mjs').createLedger>} o.ledger
 * @param {(problem: string) => void} o.report
 * @param {number} [o.sweepMs] how often preparations that never became the owner are reclaimed (their time limit is the continue Host's)
 * @param {number} [o.ttlMs]
 */
export function createContinueWiring({ dataDir, runtime, hostFs, families, epochs, ledger, report, sweepMs = 60_000, ttlMs }) {
  const target = createContinueTarget({
    dir: path.join(dataDir, 'continue'),
    hostFs,
    harnesses: () => runtime.host.ids,
    ...(families ? { agent: createAgentCheck({ rows: families.harnesses, acpIds: () => runtime.host.ids }) } : {}),
  });
  const owners = createOwnerStore(path.join(dataDir, 'owners.json'), { report });
  // what an earlier Host kept under the app's spelling of a chat's id is the chat's under the Host's
  rekeyContinueState({ owners, epochs, target, report });
  const continueBase = createContinueHost({
    epochs,
    ledger,
    owners,
    target,
    // this Host runs a chat while its ACP host holds the chat's session, or (any family) its record names it
    serves: (chatId) => (families ? families.chats.continueServes(chatId) : runtime.host.chats.has(chatId)),
    busy: (chatId) =>
      families ? families.chats.continueBusy(chatId) : !!runtime.host.chats.get(chatId)?.prompting || runtime.host.starting.has(chatId),
    quiesce: () => undefined,
    // closing the session stops a running turn and the agent with it; any family's turn is stopped and its waiting messages dropped
    retire: async (chatId) => (families ? families.chats.continueRetire(chatId) : runtime.host.close(chatId)),
    report,
    newId: () => randomBytes(12).toString('hex'),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  // the app asks a continue with the id it draws the chat by (`acp:host-codex:<uuid>`); this Host keeps the chat, its handoff and its owner under its own id (`<uuid>`), which every later request names: one spelling inside (#5160)
  /** @param {any} p */
  const own = (p) => ({ ...p, chatId: hostChatId(p.chatId) });
  /** @type {typeof continueBase & { takesFamilies?: boolean }} */
  const continueHost = {
    ...continueBase,
    prepare: (/** @type {any} */ p) => continueBase.prepare(own(p)),
    commit: (/** @type {any} */ p) => continueBase.commit(own(p)),
    release: (/** @type {any} */ p) => continueBase.release(own(p)),
    touch: (/** @type {string} */ chatId, /** @type {number} */ epoch) => continueBase.touch(hostChatId(chatId), epoch),
    gate: (/** @type {string} */ chatId, /** @type {number} */ epoch) => continueBase.gate(hostChatId(chatId), epoch),
    // each answer names the chat as the client asked about it
    async acceptHello(/** @type {{ chatId: string, epoch: number, rev: number, targetHostId: string }[]} */ moved) {
      const asked = new Map(moved.map((m) => [hostChatId(m.chatId), m.chatId]));
      /** @template {{ chatId: string }} T @param {T[]} list @returns {T[]} */
      const named = (list) => list.map((m) => ({ ...m, chatId: /** @type {string} */ (asked.get(m.chatId)) }));
      const out = await continueBase.acceptHello(moved.map(own));
      return { poisoned: named(out.poisoned), conflicts: named(out.conflicts), agreed: named(out.agreed) };
    },
  };
  // a preparation whose commit never came (the app quit, the target was unreachable) is reclaimed here, whoever it was meant for
  const sweeping = setInterval(() => {
    continueBase.sweep().catch((/** @type {Error} */ e) => report(`Expired preparations were not swept: ${e.message}`));
  }, sweepMs);
  sweeping.unref();
  // an older app asks nothing of this: only a Host that takes every family says so at hello (feature `continueFamilies`)
  return { continueHost: families ? { ...continueHost, takesFamilies: true } : continueHost, target, close: () => clearInterval(sweeping) };
}
