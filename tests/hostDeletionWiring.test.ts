// Offline deletion jobs survive main wiring restart even before chat sessions/windows are available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { remoteChatsFor } = require('../electron/host/wiring.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deletion-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('offline chat deletion stays pending across wiring restart and only the paired machine reconnect sends it', async (t) => {
  const dir = tmp(t);
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  own.set('acp:kimi:offline', { hostId: 'box', ownerHostId: 'box', epoch: 2, folder: '/work' });
  let online = false;
  let retired = 0;
  const seen: any[] = [];
  const host = {
    speaks: () => true,
    removeChat: async (...args: any[]) => {
      seen.push(args);
      return { removed: true };
    },
  };
  const options = {
    dir,
    safeStorage: () => keySafe,
    allowed: () => true,
    machines: () => ({ hostFor: () => host, row: () => ({ status: online ? 'online' : 'offline' }) }),
    acpHost: () => undefined,
    sender: () => ({
      forgetChat: () => {
        retired++;
      },
      sent: { take: () => undefined, seen: () => {} },
    }),
  };
  const first = remoteChatsFor(options);
  assert.equal((await first.forget('acp:kimi:offline'))!.pending, true);
  assert.equal(first.pendingDeletions().length, 1);
  own.refresh();
  assert.equal(own.get('acp:kimi:offline').hostId, 'local');
  const again = remoteChatsFor(options);
  online = true;
  again.followAll();
  // The flush RPC is intentionally asynchronous; no second controller is started.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(again.pendingDeletions().length, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1].epoch, 2);
  assert.ok(retired > 0);
  again.dropMachine('box');
});

test('a chat of this Mac leaves no machine deletion behind, and a reported wiring flushes on follow with its own reporter', async (t) => {
  const dir = tmp(t);
  const reported: any[] = [];
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => null, row: () => ({ status: 'offline' }) }),
    acpHost: () => undefined,
    report: (e: any) => reported.push(e),
  });
  assert.deepEqual(await chats.forget('acp:kimi:local-only'), { pending: false });
  assert.deepEqual(chats.pendingDeletions(), []);
  chats.followAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reported, []);
});

test('with Host access off, following flushes no deletion and forgetting a chat records none', async (t) => {
  const dir = tmp(t);
  let asked = 0;
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => false,
    machines: () => ({ hostFor: () => (asked++, null), row: () => (asked++, { status: 'online' }) }),
    acpHost: () => undefined,
  });
  chats.followAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await chats.forget('acp:kimi:any'), null);
  assert.deepEqual(chats.pendingDeletions(), []);
  assert.equal(asked, 0);
});

test('a local deletion that fails takes its new machine job back, keeps one made by an earlier attempt, and a job queued behind a running flush is sent at once', async (t) => {
  const dir = tmp(t);
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  own.set('acp:kimi:keep', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: '/w' });
  let fail = true;
  let online = false;
  const seen: string[] = [];
  let release: () => void = () => undefined;
  let hold = false;
  const host = {
    speaks: () => true,
    removeChat: async (chatId: string) => {
      seen.push(chatId);
      if (hold) await new Promise<void>((r) => (release = r));
      return { removed: true };
    },
  };
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => host, row: () => ({ status: online ? 'online' : 'offline' }) }),
    acpHost: () => undefined,
    sender: () => ({
      forgetChat: () => {
        if (fail) throw new Error('the queue could not be retired');
      },
      sent: { take: () => undefined, seen: () => undefined },
    }),
  });
  await assert.rejects(chats.forget('acp:kimi:keep'), /could not be retired/);
  assert.deepEqual(chats.pendingDeletions(), [], 'no job outlives a deletion that did not happen here');
  own.refresh();
  assert.equal(own.get('acp:kimi:keep').hostId, 'box');
  // an earlier attempt's job stays when a later attempt fails
  fail = false;
  assert.equal((await chats.forget('acp:kimi:keep'))!.pending, true);
  own.set('acp:kimi:keep', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: '/w' });
  fail = true;
  await assert.rejects(chats.forget('acp:kimi:keep'));
  assert.equal(chats.pendingDeletions().length, 1);
  // a flush already on its way does not make a new deletion wait for the next reconnect
  fail = false;
  online = true;
  hold = true;
  chats.followAll();
  await new Promise((resolve) => setImmediate(resolve));
  own.set('acp:kimi:late', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: '/w' });
  const late = chats.forget('acp:kimi:late');
  hold = false;
  release();
  assert.deepEqual(await late, { pending: false });
  assert.deepEqual(seen, ['acp:kimi:keep', 'acp:kimi:late']);
});

test('a machine that answers but cannot take a deletion is told apart from one that is away: its deletion waits for an update, not for it to come back', async (t) => {
  const dir = tmp(t);
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  own.set('acp:kimi:old', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: '/w' });
  own.set('acp:kimi:away', { hostId: 'gone', ownerHostId: 'gone', epoch: 1, folder: '/w' });
  const old = { speaks: () => false, negotiated: () => true, removeChat: async () => assert.fail('an old Host is never sent a deletion') };
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => true,
    machines: () => ({
      hostFor: (id: string) => (id === 'box' ? old : null),
      row: (id: string) => ({ status: id === 'box' ? 'online' : 'offline' }),
    }),
    acpHost: () => undefined,
  });
  assert.deepEqual(await chats.forget('acp:kimi:old'), { pending: true, outdated: true });
  assert.deepEqual(await chats.forget('acp:kimi:away'), { pending: true });
  assert.equal(chats.pendingDeletions().length, 2);
});
