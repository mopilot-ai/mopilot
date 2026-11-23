// A scratch app-side lost-Host continuation through production ownership, local Host and inbox; never opens the installed app or starts a local harness.
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OwnershipStore } = require('../../electron/host/ownership.cjs');
const { createContinueInbox } = require('../../electron/host/continueInbox.cjs');
const { createLocalContinue } = require('../../electron/host/localContinue.cjs');
const { createHostContinue } = require('../../electron/host/hostContinue.cjs');

/** Build and retain the next message's handoff after the real source has been stopped. @param {{ dir: string, chatId: string, harness: string, items: any[], rev: number }} o */
export async function localContinuation({ dir, chatId, harness, items, rev }) {
  const ownership = new OwnershipStore(path.join(dir, 'ownership.json'));
  ownership.set(chatId, { hostId: 'source', ownerHostId: 'source', epoch: 1, folder: null });
  const inbox = createContinueInbox({ dir: path.join(dir, 'inbox') });
  const problems = [];
  const report = (p) => problems.push(p);
  const local = createLocalContinue({
    dir: path.join(dir, 'local'),
    target: inbox.target,
    serves: () => false,
    busy: () => false,
    retire: async () => undefined,
    report,
  });
  const service = createHostContinue({
    ownership,
    hostState: (id) => (id === 'local' ? 'online' : 'offline'),
    local: local.channel,
    session: async () => {
      throw new Error('The lost source must not be contacted.');
    },
    localTurns: async () => {
      throw new Error('The chat has not run locally.');
    },
    harnessOf: () => ({ harness, label: harness }),
    tails: {
      merge: () => {
        throw new Error('No returning source tail.');
      },
    },
    report,
    newKey: () => crypto.randomUUID(),
    mirrorRev: () => rev,
    mirror: () => ({ items, complete: items.length >= rev }),
    sleep: async () => undefined,
  });
  const moved = await service.run({ chatId, targetHostId: 'local', cwd: dir, lostHostConfirmed: true });
  const kept = inbox.pending(chatId);
  if (moved.hostId !== 'local' || moved.epoch !== 2 || !kept || problems.length)
    throw new Error(`Local continuation failed: ${JSON.stringify({ moved, kept, problems })}`);
  // Reload the durable ownership, independently of the object that performed the move.
  const owner = new OwnershipStore(path.join(dir, 'ownership.json')).get(chatId);
  if (owner.ownerHostId !== 'local' || owner.lostHost?.sourceHostId !== 'source') throw new Error('Lost-Host ownership was not persisted.');
  return { text: kept.text, done: () => inbox.done(chatId), pending: () => inbox.pending(chatId) };
}
