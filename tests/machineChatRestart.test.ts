// A chat taken in from a machine's list (#5576) after the app starts again: the mark is on its binding, so it still keeps its Host's mode, still reads a newer epoch when the Host refuses a message, and a binding no window ever confirmed is swept once at the first read of the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { keySafe } from './support/hostKeySafe.ts';
import { world, msg, UUID, code } from './support/host/remoteSendKit.ts';

const require = createRequire(import.meta.url);
const { remoteChatsFor } = require('../electron/host/wiring.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const { machineChatAdoption } = require('../electron/app/machineChatAdoption.cjs');
const { registerHostLists } = require('../electron/app/ipc/hostLists.cjs');
const { chatIndexHooks } = require('../electron/app/hostChatHooks.cjs');

const CHAT = 'acp:host-claude:c1';
const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const wired = (dir: string) =>
  remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => undefined, row: () => ({ status: 'online' }) }),
    acpHost: () => undefined,
  });
const stored = (dir: string, id: string) => new OwnershipStore(path.join(dir, 'host-ownership.json')).get(id);
/** The adoption of one run of the app over the folder: a new one is a restart. */
function run(dir: string, listed: () => unknown[] = () => []) {
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  return machineChatAdoption({
    folders: () => ({
      bind: (id: string, at: any) => own.set(id, { hostId: at.hostId, ownerHostId: at.hostId, epoch: 0, folder: at.folder }),
    }),
    chats: () => ({ ...wired(dir), get: () => ({ follow: async () => undefined }) }),
    deps: { live: { hostOwnership: { get: (id: string) => stored(dir, id) } } },
    service: () => ({ chatIndex: listed }),
  });
}

test('adopt, send, restart, send: the mode rule and the epoch refresh hold on the second run, and no mode is set on the machine', async (t) => {
  const dir = tmp(t);
  let listed: unknown[] = [];
  await run(dir).takeIn(CHAT, { hostId: 'box', folder: '/w', epoch: 3 });
  const w = world(t, { epoch: 3 });
  w.remote(CHAT);
  w.kinds.set(CHAT, 'claude');
  // the first run: no mode of this Mac's making
  const first = run(dir);
  w.config.taken = first;
  await w.service.send(CHAT, msg('before', UUID(1)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.permits, []);
  // the app starts again, and the Host moved on to epoch 4 meanwhile: the list says so
  listed = [{ machineId: 'box', rows: [{ chatId: 'claude:c1', epoch: 4 }] }];
  const second = run(dir, () => listed);
  w.config.taken = {
    takenIn: (id: string) => second.takenIn(id),
    refreshEpoch: (id: string) => {
      const refreshed = second.refreshEpoch(id);
      if (refreshed) {
        w.host.failWith = null;
        w.remote(id, 'box', stored(dir, id).epoch);
      }
      return refreshed;
    },
  };
  w.host.failWith = code('That chat moved on.', 'stale_epoch');
  await w.service.send(CHAT, msg('after', UUID(2)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    w.sent.map((s) => s.item.text),
    ['before', 'after'],
  );
  assert.equal(w.owners.get(CHAT)?.epoch, 4, 'delivered under the epoch the Host holds');
  assert.deepEqual(w.permits, [], 'no mode set after the restart either');
  assert.equal(typeof stored(dir, CHAT).takenIn, 'number');
});

test('the first read of the list sweeps old taken-in bindings that no window gave a record and no message waits for, once; and not before this Mac has its records or while Host is closed', async (t) => {
  const dir = tmp(t);
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const old = Date.now() - 8 * 24 * 3600 * 1000;
  for (const id of ['lost', 'kept', 'waiting'])
    own.set(`acp:host-claude:${id}`, { hostId: 'box', ownerHostId: 'box', epoch: 3, folder: '/w', takenIn: old });
  own.set('acp:host-claude:fresh', { hostId: 'box', ownerHostId: 'box', epoch: 3, folder: '/w', takenIn: Date.now() });
  const lists = new Map<string, (...a: unknown[]) => unknown>();
  let open = true;
  const records = new Map([['acp:host-claude:kept', {}]]);
  const deps: any = { live: { remoteSend: { hasPending: (id: string) => id === 'acp:host-claude:waiting' } } };
  registerHostLists({
    ipcMain: { handle: (channel: string, fn: (...a: unknown[]) => unknown) => void lists.set(channel, fn) },
    handle: () => undefined,
    allowed: () => open,
    service: () => ({ list: () => ({ machines: [] }), chatIndex: () => [], row: () => ({}) }),
    deps,
    chats: wired(dir),
    folders: () => ({ bind: () => undefined }),
  });
  const read = lists.get('host:chatIndex')!;
  const hosts = () => ['lost', 'kept', 'waiting', 'fresh'].map((n) => stored(dir, `acp:host-claude:${n}`).hostId);
  assert.deepEqual(await read(), []);
  assert.deepEqual(hosts(), ['box', 'box', 'box', 'box'], 'this Mac has no records yet: nothing is judged');
  deps.live.chats = { get: (id: string) => records.get(id) };
  open = false;
  await read();
  assert.deepEqual(hosts(), ['box', 'box', 'box', 'box'], 'Host closed: nothing is judged');
  open = true;
  await read();
  assert.deepEqual(hosts(), ['local', 'box', 'box', 'box'], 'swept: only the old one with no record and no message');
  records.delete('acp:host-claude:kept');
  await read();
  assert.deepEqual(hosts(), ['local', 'box', 'box', 'box'], 'once per run');
});

test('a change of the list tells the adoption, so a message waiting for a newer epoch goes; a closed Host or an app without it tells nothing', () => {
  const told: string[] = [];
  const deps: any = { broadcastAll: () => undefined, live: { machineChats: { indexChanged: () => told.push('changed') } } };
  const service = () => ({ chatIndex: () => [], row: () => undefined });
  chatIndexHooks({ deps, allowed: () => true, service }).onChange();
  assert.deepEqual(told, ['changed']);
  chatIndexHooks({ deps, allowed: () => false, service }).onChange();
  assert.deepEqual(told, ['changed'], 'closed');
  chatIndexHooks({ deps: { broadcastAll: () => undefined }, allowed: () => true, service }).onChange();
  chatIndexHooks({ deps: { broadcastAll: () => undefined, live: { machineChats: {} } }, allowed: () => true, service }).onChange();
});
