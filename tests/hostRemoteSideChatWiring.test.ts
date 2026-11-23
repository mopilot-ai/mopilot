// A remote side chat is prepared by main only while it still has a known, unchanged parent on its machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startWorld } from './support/host/remoteChatsWiringKit.ts';
import { deferred } from './support/async-scenarios.ts';

const parent = 'acp:kimi:parent';
const parentOwner = { hostId: 'box', ownerHostId: 'box', epoch: 2, folder: '/srv/project' };

test('the side-chat IPC distinguishes local, invalid, switching and unreadable ownership', async (t) => {
  const w = startWorld(t);
  const open = w.handlers.get('host:openSideChat');
  assert.deepEqual(await open(null, 'local'), { value: null });
  assert.match((await open(null, [])).error.message, /parent chat is unavailable/);
  w.own().set(parent, { ...parentOwner, ownerHostId: 'other' });
  assert.match((await open(null, parent)).error.message, /folder or machine is unavailable/);
  w.own().set(parent, { ...parentOwner, folder: null });
  assert.match((await open(null, parent)).error.message, /folder or machine is unavailable/);
  w.own().set(parent, parentOwner);
  assert.match((await open(null, parent)).error.message, /reported the agent/);
  fs.writeFileSync(w.own().file, '{');
  assert.match((await open(null, parent)).error.message, /Could not read this chat’s machine/);
  assert.deepEqual(w.begun, []);
});

test('a different agent or machine’s settings are ignored and the parent’s last confirmed mode is saved for the first send', async (t) => {
  const w = startWorld(t);
  w.own().set(parent, parentOwner);
  const writes: unknown[] = [];
  w.live.controller.ref = () => ({ kind: 'acp:kimi' });
  w.live.controller.state.get = () => ({ queue: [], permission: 'read-only' });
  w.live.controller.state.patch = () => assert.fail('only the Host can confirm the side chat’s running mode');
  w.live.chats = {
    records: new Map(),
    get: () => ({
      meta: {
        config: {
          hostPermission: { hostId: 'other', harness: 'kimi', value: 'full-access' },
          hostSelection: { hostId: 'box', harness: 'claude', model: 'unrelated' },
        },
      },
    }),
    patchMeta: (...p: unknown[]) => (writes.push(p), true),
  };
  const { value } = await w.handlers.get('host:openSideChat')(null, parent);
  const config = { hostPermission: { hostId: 'box', harness: 'kimi', value: 'read-only' } };
  assert.deepEqual(value.config, config);
  assert.deepEqual(writes, [[value.chatId, { config }]]);
});

test('a parent on a machine with a signed-out agent still opens a draft and defers login checks to delivery', async (t) => {
  const w = startWorld(t, { row: { name: 'box', status: 'online', harnesses: [{ id: 'codex', detected: true, signedIn: false }] } });
  const source = 'acp:host-codex:parent';
  w.own().set(source, parentOwner);
  w.live.controller.ref = () => ({ kind: 'codex' });
  const { value } = await w.handlers.get('host:openSideChat')(null, source);
  assert.match(value?.chatId ?? '', /^acp:host-codex:side-chat-/);
  assert.deepEqual(w.own().get(value.chatId), { ...parentOwner, epoch: 0 });
  assert.deepEqual(w.begun, [[value.chatId, { harness: 'codex', projectId: null, sideChat: { sourceId: source, epoch: 2 } }]]);
});

test('a parent moved while its side chat subscribes leaves the unused child ready for retirement', async (t) => {
  const w = startWorld(t);
  w.own().set(parent, parentOwner);
  w.live.controller.ref = () => ({ kind: 'acp:kimi' });
  const following = deferred<void>();
  w.live.remoteChats().follow = () => following.promise;
  const open = w.handlers.get('host:openSideChat')(null, parent);
  const [child] = w.begun[0];
  assert.equal(w.own().get(child).hostId, 'box');
  w.own().set(parent, { ...parentOwner, hostId: 'other', ownerHostId: 'other', epoch: 3 });
  following.resolve();
  assert.match((await open).error.message, /parent chat changed/);
  assert.equal(w.own().get(child).hostId, 'local');
  assert.equal(w.own().get(parent).hostId, 'other');
});

test('a side chat inherits permissions and picks after its asynchronous subscription', async (t) => {
  const w = startWorld(t);
  w.own().set(parent, parentOwner);
  w.live.controller.ref = () => ({ kind: 'acp:kimi' });
  const following = deferred<void>();
  w.live.remoteChats().follow = () => following.promise;
  let permission = 'full-access';
  let model = 'old';
  // The parent's saved choice takes precedence for its next message, even before the Host confirms the mode there.
  w.live.controller.state.get = () => ({ queue: [], permission: 'full-access' });
  w.live.controller.state.patch = () => assert.fail('opening a draft must not set the confirmed mode');
  w.live.chats = {
    records: new Map(),
    get: () => ({
      meta: {
        config: {
          hostPermission: { hostId: 'box', harness: 'kimi', value: permission },
          hostSelection: { hostId: 'box', harness: 'kimi', model },
        },
      },
    }),
    patchMeta: () => true,
  };
  const pending = w.handlers.get('host:openSideChat')(null, parent);
  permission = 'read-only';
  model = 'current';
  following.resolve();
  const { value } = await pending;
  assert.equal(value.config.hostPermission.value, 'read-only');
  assert.equal(value.config.hostSelection.model, 'current');
});

test('a settings write failure retires the side chat before it can be shown', async (t) => {
  const w = startWorld(t);
  w.own().set(parent, parentOwner);
  w.live.controller.ref = () => ({ kind: 'acp:kimi' });
  w.live.chats = {
    records: new Map(),
    get: () => ({ meta: { config: { hostSelection: { hostId: 'box', harness: 'kimi', model: 'model' } } } }),
    patchMeta: () => false,
  };
  const { error } = await w.handlers.get('host:openSideChat')(null, parent);
  assert.match(error.message, /Could not save the side chat/);
  assert.equal(w.own().get(w.begun[0][0]).hostId, 'local');
});

test('settings already saved on a side chat count as inherited successfully', async (t) => {
  const w = startWorld(t);
  w.own().set(parent, parentOwner);
  w.live.controller.ref = () => ({ kind: 'acp:kimi' });
  const config = { hostSelection: { hostId: 'box', harness: 'kimi', model: 'saved' } };
  const meta = { config };
  const records = new Map();
  w.live.remoteChats().follow = async (id: string) => void records.set(id, { meta });
  w.live.chats = { records, get: () => ({ meta }), patchMeta: () => false };
  const { value } = await w.handlers.get('host:openSideChat')(null, parent);
  assert.deepEqual(value.config, config);
  assert.equal(w.own().get(value.chatId).hostId, 'box');
});

test('a renderer reload can recover its live child without starting a different chat', async (t) => {
  const w = startWorld(t);
  w.own().set(parent, parentOwner);
  w.live.controller.ref = () => ({ kind: 'acp:kimi' });
  const open = w.handlers.get('host:openSideChat');
  const here = { sender: { id: 7 } };
  const { value } = await open(here, parent);
  const child = value.chatId;
  assert.deepEqual(await open(here, parent, child), { value });
  assert.deepEqual(await open({ sender: { id: 9 } }, parent, child), { value: null });
  assert.deepEqual(await open(here, 'other-parent', child), { value: null });
  assert.deepEqual(await open(here, parent, []), { value: null });
  assert.deepEqual(await open(here, parent, 'unowned-child'), { value: null });
  w.live.chats = { get: () => undefined };
  assert.deepEqual(await open(here, parent, child), { value });
  const config = { hostSelection: { hostId: 'box', harness: 'kimi', model: 'saved' } };
  w.live.chats.get = () => ({ meta: { config } });
  assert.deepEqual(await open(here, parent, child), { value: { ...value, config } });
  w.own().set(child, { ...parentOwner, ownerHostId: 'destination' });
  assert.deepEqual(await open(here, parent, child), { value: null });
  w.own().set(child, { ...parentOwner, folder: null });
  assert.deepEqual(await open(here, parent, child), { value: null });
  w.own().remove(child);
  assert.deepEqual(await open(here, parent, child), { value: null });
  assert.equal(w.begun.length, 1);
});

test('quit waits for both online side chats to retire through the serial machine deletion outbox', { timeout: 3000 }, async (t) => {
  const called = [deferred<string>(), deferred<string>()];
  const receipts = [deferred<{ removed: true }>(), deferred<{ removed: true }>()];
  const removed: string[] = [];
  const w = startWorld(t, {
    host: {
      speaks: (feature: string) => feature === 'journalLifecycle',
      removeChat: (id: string) => {
        const index = removed.push(id) - 1;
        called[index].resolve(id);
        return receipts[index].promise;
      },
    },
  });
  w.own().set(parent, parentOwner);
  w.live.controller.ref = () => ({ kind: 'acp:kimi' });
  const open = w.handlers.get('host:openSideChat');
  const first = (await open(null, parent)).value.chatId;
  const second = (await open(null, parent)).value.chatId;
  let finished = false;
  const retiring = w.live.retireHostSideChats(2000).then(() => (finished = true));
  await called[0].promise;
  assert.equal(removed.length, 1);
  assert.equal(finished, false);
  receipts[0].resolve({ removed: true });
  await called[1].promise;
  assert.equal(finished, false);
  receipts[1].resolve({ removed: true });
  await retiring;
  assert.deepEqual(removed.sort(), [first, second].sort());
  assert.deepEqual(
    w
      .own()
      .remoteChats()
      .map(({ chatId }: { chatId: string }) => chatId),
    [parent],
  );
  assert.deepEqual(w.own().get(parent), parentOwner);
  assert.deepEqual(await w.handlers.get('host:pendingDeletions')({}), { value: [] });
});
