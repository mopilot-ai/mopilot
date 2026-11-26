// The remaining arms of the By machine main-process code (#5576): a row without an epoch or a title, an ownership record without an epoch, a machine without a name, a release of a chat the list no longer holds, the adoption the lists hand out, a refusal when nothing can read the epoch again, and the release with a followed chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { keySafe } from './support/hostKeySafe.ts';
import { acpHostFake } from './support/host/remoteChatsWiringKit.ts';
import { world, msg, UUID, code } from './support/host/remoteSendKit.ts';

const require = createRequire(import.meta.url);
const { createAdoptMachineChat } = require('../electron/host/adoptMachineChat.cjs');
const { machineChatAdoption } = require('../electron/app/machineChatAdoption.cjs');
const { registerHostLists } = require('../electron/app/ipc/hostLists.cjs');
const { remoteChatsFor } = require('../electron/host/wiring.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-branches-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('a machine that has no name is called by its id; a row with no epoch is taken in without one; releasing a chat the list no longer holds works from its id', async () => {
  const takenIn: unknown[][] = [];
  const released: string[] = [];
  const open = createAdoptMachineChat({
    row: () => ({ status: 'online' }),
    index: () => [{ machineId: 'ssh:box', rows: [{ chatId: 'claude:a', folder: '/f' }] }],
    owner: () => 'local',
    has: () => false,
    takenIn: () => true,
    machineChats: () => ({ takeIn: async (...a: unknown[]) => void takenIn.push(a), release: (id: string) => void released.push(id) }),
    announce: () => undefined,
  });
  assert.deepEqual(await open.open('ssh:box', 'claude:a'), { chatId: 'acp:host-claude:a' });
  assert.deepEqual(takenIn, [['acp:host-claude:a', { hostId: 'ssh:box', folder: '/f' }]], 'no epoch said, none sent');
  await assert.rejects(() => open.open('ssh:box', 'claude:missing'), { message: /ssh:box does not list that chat any more/ });
  // owner 'ssh:box' and nothing listed: the chat is let go by its own id
  const bound = createAdoptMachineChat({
    row: () => ({ status: 'online' }),
    index: () => [],
    owner: () => 'ssh:box',
    has: () => false,
    takenIn: () => true,
    machineChats: () => ({ takeIn: async () => undefined, release: (id: string) => void released.push(id) }),
    announce: () => undefined,
  });
  assert.deepEqual(await bound.release('ssh:box', 'acp:host-claude:gone'), { released: true });
  assert.deepEqual(released, ['acp:host-claude:gone']);
});

test('the epoch is read again only from an owner that says one: no ownership service, no owner, or an owner with no epoch (taken as 0)', () => {
  const rows = [{ machineId: 'box', rows: [{ chatId: 'claude:a', epoch: 1 }] }];
  const make = (deps: any) => {
    const set: [string, number][] = [];
    const adoption = machineChatAdoption({
      folders: () => ({ bind: () => undefined }),
      chats: () => ({
        get: () => undefined,
        release: () => undefined,
        setEpoch: (id: string, epoch: number) => void set.push([id, epoch]),
        markTakenIn: () => undefined,
        takenIn: () => true,
        takenInChats: () => [],
      }),
      deps,
      service: () => ({ chatIndex: () => rows }),
    });
    return { adoption, set };
  };
  assert.equal(make(undefined).adoption.refreshEpoch('acp:host-claude:a'), false, 'no live services');
  assert.equal(make({ live: {} }).adoption.refreshEpoch('acp:host-claude:a'), false, 'no ownership service');
  assert.equal(make({ live: { hostOwnership: { get: () => undefined } } }).adoption.refreshEpoch('acp:host-claude:a'), false, 'no owner');
  const noEpoch = make({ live: { hostOwnership: { get: () => ({ hostId: 'box' }) } } });
  assert.equal(noEpoch.adoption.refreshEpoch('acp:host-claude:a'), true, 'an owner with no epoch is at 0: 1 is newer');
  assert.deepEqual(noEpoch.set, [['acp:host-claude:a', 1]]);
  // the list is read through the chats' own change hook, with nothing to do for a chat that is not waiting
  noEpoch.adoption.indexChanged();
  make(undefined).adoption.indexChanged();
});

test('the adoption the lists hand out reads this Mac index for the epoch, and its release is the one the channel uses', async () => {
  const calls = new Map<string, (...a: unknown[]) => unknown>();
  const set: [string, number][] = [];
  const lists = registerHostLists({
    ipcMain: { handle: () => undefined },
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => void calls.set(channel, fn),
    allowed: () => true,
    service: () => ({
      list: () => ({ machines: [] }),
      chatIndex: () => [{ machineId: 'box', rows: [{ chatId: 'claude:a', epoch: 5, folder: '/f' }] }],
      row: () => ({ name: 'box', status: 'online' }),
    }),
    deps: { live: { chats: { get: () => undefined }, hostOwnership: { get: () => ({ hostId: 'box', epoch: 3 }) }, machineChats: {} } },
    chats: {
      pendingDeletions: () => [],
      takenIn: () => true,
      takenInChats: () => [],
      release: () => undefined,
      setEpoch: (id: string, epoch: number) => void set.push([id, epoch]),
      markTakenIn: () => undefined,
    },
    folders: () => ({ bind: () => undefined }),
  });
  assert.equal(lists.adoption.refreshEpoch('acp:host-claude:a'), true, 'the list holds epoch 5, the binding 3');
  assert.deepEqual(set, [['acp:host-claude:a', 5]]);
  // released through the channel: marked, bound to that machine, no record
  const out = await calls.get('host:releaseChat')!('box', 'claude:a');
  assert.deepEqual(out, { released: true }, 'marked, bound there, no record: let go (the live service here has no release to call)');
});

test('a refusal for the epoch where nothing can read it again stays a refusal: no adoption, or one without the call', async (t) => {
  for (const taken of [undefined, {}, { takenIn: () => true }]) {
    const w = world(t);
    w.remote('c1');
    w.host.failWith = code('That chat moved on.', 'stale_epoch');
    w.config.taken = taken as any;
    await w.service.send('c1', msg('hello', UUID(1)), 1);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(w.sent, []);
  }
});

test('releasing a chat the service follows stops following it and unbinds it', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'host-ownership.json');
  new OwnershipStore(file).set('acp:host-claude:r', { hostId: 'box', ownerHostId: 'box', epoch: 3, folder: '/w', takenIn: Date.now() });
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => null }),
    acpHost: () => acpHostFake(),
    report: () => undefined,
  });
  assert.ok(chats.get(), 'the chats are followed');
  chats.release('acp:host-claude:r');
  assert.equal(new OwnershipStore(file).get('acp:host-claude:r').hostId, 'local');
});

test('the adoption passes on the deletions still waiting for their machine', () => {
  const waiting = [{ hostId: 'box', chatId: 'acp:host-claude:gone' }];
  const adoption = machineChatAdoption({
    folders: () => ({ bind: () => undefined }),
    chats: () => ({ pendingDeletions: () => waiting }),
    deps: undefined,
    service: () => ({ chatIndex: () => [] }),
  });
  assert.equal(adoption.pendingDeletions(), waiting);
});
