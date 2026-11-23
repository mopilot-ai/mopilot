// Deleting a chat whose machine stopped answering (its connection still looks up until the heartbeat fails) is not held up by it: the chat is deleted here at once, the deletion waits queued for the machine, and the receipt says it is pending (electron/host/boundedWait.cjs, wiring.cjs forget, app/ipc/chats.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { keySafe } from './support/hostKeySafe.ts';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { remoteChatsFor } = require('../electron/host/wiring.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const { within, DELETION_WAIT_MS } = require('../electron/host/boundedWait.cjs');
const { register } = require('../electron/app/ipc/chats.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');

const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deletion-unreachable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const never = () => new Promise<never>(() => undefined);

test('within: the work’s own answer or failure when it comes in time, "late" when it does not, and a failure after that is nobody’s', async (t) => {
  const clock = useFakeClock(t);
  assert.equal(await within(Promise.resolve(7), 50), 7);
  await assert.rejects(within(Promise.reject(new Error('refused')), 50), /refused/);
  let fail: (e: Error) => void = () => undefined;
  const slow = within(new Promise((_, reject) => (fail = reject)), 50);
  clock.advance(50);
  assert.equal(await slow, 'late');
  // the work fails once nobody waits: no unhandled rejection
  fail(new Error('too late to matter'));
  await new Promise((r) => setImmediate(r));
  assert.equal(clock.pending, 0);
  assert.equal(DELETION_WAIT_MS, 2000);
  // no time left: the work is started and not waited for
  assert.equal(await within(never(), 0), 'late');
  assert.equal(await within(never(), -5), 'late');
  // work that is no promise is its own answer
  assert.equal(await within('plain'), 'plain');
});

test('a machine that looks online and never answers the deletion: forgetting the chat returns pending after the wait, the job stays queued, and it completes when the machine answers', async (t) => {
  const clock = useFakeClock(t);
  const dir = tmp(t);
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  own.set('acp:kimi:down', { hostId: 'box', ownerHostId: 'box', epoch: 3, folder: '/w' });
  let answer: (v: unknown) => void = () => undefined;
  const asked: string[] = [];
  const host = {
    speaks: () => true,
    negotiated: () => true,
    removeChat: (chatId: string) => (asked.push(chatId), new Promise((resolve) => (answer = resolve))),
  };
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => host, row: () => ({ status: 'online' }) }),
    acpHost: () => undefined,
  });
  let done: unknown = 'not yet';
  const forgetting = chats.forget('acp:kimi:down').then((r: unknown) => (done = r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['acp:kimi:down']);
  assert.equal(done, 'not yet', 'waiting for the machine');
  clock.advance(DELETION_WAIT_MS);
  await forgetting;
  assert.deepEqual(done, { pending: true });
  assert.equal(chats.pendingDeletions().length, 1);
  // the machine comes back and answers the same request: the job is done
  answer({ removed: true });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(chats.pendingDeletions(), []);
});

test('the deletion IPC does not wait for a machine that does not answer Stop either: the receipt comes back pending', async (t) => {
  const clock = useFakeClock(t);
  const id = 'acp:kimi:down-stop';
  const store = Object.assign(Object.create(ChatsStore.prototype), {
    records: new Map([[id, { id, segments: [{ kind: 'acp:kimi', nativeId: 'down-stop' }], meta: {}, schemaVersion: 2 }]]),
    archiveEpochs: new Map([[id, 0]]),
    newer: new Set(),
    unreadable: new Set(),
    now: () => 1,
    fallback: true,
    mirror: () => {},
    onChange: () => {},
    isDeleted: () => false,
    admitCommit: () => true,
  });
  const handlers = new Map<string, any>();
  const removed: string[] = [];
  register(
    { handle: (name: string, fn: any) => handlers.set(name, fn) } as any,
    {
      live: {
        chats: store,
        acpHost: { remove: (key: string) => removed.push(key) },
        remoteSend: () => ({ stop: never }),
        remoteForget: async () => ({ pending: true }),
      },
      claude: {},
      registerChats: () => ({ patchPrefs: () => true }),
      broadcastAll: () => undefined,
      STATE_FILE: () => '',
      readState: () => {},
    } as any,
  );
  const deleting = handlers.get('chats:delete')({}, id);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(removed, [], 'still waiting for the machine to answer Stop');
  clock.advance(DELETION_WAIT_MS);
  const receipt = await deleting;
  assert.equal(receipt.remoteDeletionPending, true);
  assert.deepEqual(removed, [id]);
});

/** The deletion IPC over a real wiring for one chat on a machine whose Stop and hand-over answer as `silent` says; `order` is what happened, in order. */
function ipcWorld(t: any, name: string, silent: boolean) {
  const dir = tmp(t);
  const id = `acp:kimi:${name}`;
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set(id, { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: '/w' });
  const order: string[] = [];
  const host = {
    speaks: () => true,
    negotiated: () => true,
    removeChat: (chatId: string) => (order.push(`handover ${chatId}`), silent ? never() : Promise.resolve({ removed: true })),
  };
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => host, row: () => ({ status: 'online' }) }),
    acpHost: () => undefined,
  });
  const store = Object.assign(Object.create(ChatsStore.prototype), {
    records: new Map([[id, { id, segments: [{ kind: 'acp:kimi', nativeId: name }], meta: {}, schemaVersion: 2 }]]),
    archiveEpochs: new Map([[id, 0]]),
    newer: new Set(),
    unreadable: new Set(),
    now: () => 1,
    fallback: true,
    mirror: () => {},
    onChange: () => {},
    isDeleted: () => false,
    admitCommit: () => true,
  });
  const handlers = new Map<string, any>();
  register(
    { handle: (key: string, fn: any) => handlers.set(key, fn) } as any,
    {
      live: {
        chats: store,
        acpHost: { remove: (key: string) => order.push(`remove ${key}`) },
        remoteSend: () => ({ stop: (key: string) => (order.push(`stop ${key}`), silent ? never() : Promise.resolve({ stopped: true })) }),
        remoteForget: chats.forget,
      },
      claude: {},
      registerChats: () => ({ patchPrefs: () => true }),
      broadcastAll: () => undefined,
      STATE_FILE: () => '',
      readState: () => {},
    } as any,
  );
  return { id, order, remove: () => handlers.get('chats:delete')({}, id) };
}

test('Stop and the hand-over share one bound: neither answering, the receipt comes in one wait, not two', { timeout: 20000 }, async (t) => {
  const clock = useFakeClock(t);
  const w = ipcWorld(t, 'both', true);
  let receipt: any = null;
  const deleting = w.remove().then((r: unknown) => (receipt = r));
  await new Promise((r) => setImmediate(r));
  clock.advance(DELETION_WAIT_MS - 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(receipt, null, 'still inside the one bound');
  clock.advance(1);
  await deleting;
  assert.equal((receipt as any)?.remoteDeletionPending, true);
  // the hand-over was started, with no wait of its own left, and the Mac did not wait a second bound for it
  assert.equal(clock.now(), DELETION_WAIT_MS);
  assert.deepEqual(w.order, [`stop ${w.id}`, `handover ${w.id}`, `remove ${w.id}`]);
});

test('both answering: the turn is stopped before the deletion is handed over, and the deletion goes through at once', {
  timeout: 20000,
}, async (t) => {
  useFakeClock(t);
  const w = ipcWorld(t, 'fast', false);
  const receipt = await w.remove();
  assert.equal(receipt.remoteDeletionPending, undefined);
  assert.deepEqual(w.order, [`stop ${w.id}`, `handover ${w.id}`, `remove ${w.id}`]);
});
