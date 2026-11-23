// The Mac's sandbox VMs (host/src/sandboxVms.mjs): one clone per chat, at most two running at once, suspend when idle, delete when the chat ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createSandboxVms, guestName, MAX_EXISTING, MAX_RUNNING, SandboxError } from '../host/src/sandboxVms.mjs';

/** A `tart` over a map of guests: name -> running; the golden image exists unless told not to. */
function world(over: { golden?: boolean; cloneFails?: boolean; runFails?: boolean; busy?: Set<string> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const file = path.join(dir, 'guests.json');
  const vms = new Map<string, boolean>(over.golden === false ? [] : [['golden', false]]);
  const log: string[] = [];
  const tart = {
    exists: async (n: string) => vms.has(n),
    clone: async (from: string, n: string) => {
      log.push(`clone ${from} ${n}`);
      if (over.cloneFails) throw new Error('no disk');
      vms.set(n, false);
    },
    run: async (n: string) => {
      log.push(`run ${n}`);
      if (over.runFails) throw new Error('did not boot');
      vms.set(n, true);
    },
    suspend: async (n: string) => (log.push(`suspend ${n}`), void vms.set(n, false)),
    remove: async (n: string) => (log.push(`remove ${n}`), void vms.delete(n)),
    running: async () => [...vms].filter(([, on]) => on).map(([n]) => n),
  };
  let t = 0;
  const make = () => createSandboxVms({ tart, golden: 'golden', file, busy: (c: string) => over.busy?.has(c) ?? false, now: () => ++t });
  return { vms, log, make, file, tart };
}

test('a chat’s guest is cloned from the golden image the first time and started; asking again changes nothing', async () => {
  const w = world();
  const sbx = w.make();
  const a = await sbx.acquire('chat-a');
  assert.equal(a.name, guestName('chat-a'));
  assert.match(a.name, /^mopilot-sbx-[0-9a-f]{12}$/);
  assert.deepEqual(w.log, [`clone golden ${a.name}`, `run ${a.name}`]);
  await sbx.acquire('chat-a');
  assert.equal(w.log.length, 2, 'already running');
  assert.deepEqual(await sbx.list(), [{ name: a.name, chatId: 'chat-a', state: 'running' }]);
});

test('two asks at once for one chat make one clone', async () => {
  const w = world();
  const sbx = w.make();
  const [a, b] = await Promise.all([sbx.acquire('chat-a'), sbx.acquire('chat-a')]);
  assert.equal(a.name, b.name);
  assert.equal(w.log.filter((l) => l.startsWith('clone')).length, 1);
});

test('a chat that idles suspends its guest and keeps its disk; the next ask resumes it without cloning', async () => {
  const w = world();
  const sbx = w.make();
  const { name } = await sbx.acquire('chat-a');
  assert.equal(await sbx.release('chat-a'), true);
  assert.equal(await sbx.release('chat-a'), false, 'already suspended');
  assert.equal(await sbx.release('nobody'), false);
  assert.equal(w.vms.get(name), false);
  w.log.length = 0;
  await sbx.acquire('chat-a');
  assert.deepEqual(w.log, [`run ${name}`]);
});

test(`a third chat suspends the least recently used guest that is not busy; with every guest busy it is refused`, async () => {
  const busy = new Set<string>();
  const w = world({ busy });
  const sbx = w.make();
  assert.equal(MAX_RUNNING, 2);
  const a = await sbx.acquire('a');
  const b = await sbx.acquire('b');
  await sbx.acquire('a'); // a is now the more recently used
  await sbx.acquire('c');
  assert.ok(w.log.includes(`suspend ${b.name}`), 'b was used least recently');
  assert.equal(w.vms.get(a.name), true);
  assert.deepEqual(
    (await sbx.list()).map((g: any) => [g.chatId, g.state]),
    [
      ['a', 'running'],
      ['b', 'suspended'],
      ['c', 'running'],
    ],
  );
  busy.add('a').add('c');
  await assert.rejects(
    sbx.acquire('b'),
    (e: any) => e instanceof SandboxError && e.code === 'capacity' && /both are in use/.test(e.message),
  );
  assert.equal(w.vms.get(guestName('b')), false, 'nothing was started for it');
});

test(`no more than ${MAX_EXISTING} guests exist, running or not; ending a chat frees its place`, async () => {
  const w = world();
  const sbx = w.make();
  for (const c of ['a', 'b', 'c', 'd']) await sbx.acquire(c);
  await assert.rejects(sbx.acquire('e'), (e: any) => e.code === 'capacity' && /4 sandboxes at most/.test(e.message));
  assert.equal(await sbx.destroy('a'), true);
  assert.equal(await sbx.destroy('a'), false);
  assert.equal(w.vms.has(guestName('a')), false);
  await sbx.acquire('e');
  assert.equal((await sbx.list()).length, 4);
});

test('with no golden image the Mac says so; a clone or a start that fails is said in words and a clone that is not there is not kept', async () => {
  const none = world({ golden: false }).make();
  await assert.rejects(none.acquire('a'), (e: any) => e.code === 'no_image');
  const noClone = world({ cloneFails: true });
  const s1 = noClone.make();
  await assert.rejects(s1.acquire('a'), (e: any) => e.code === 'start_failed' && /no disk/.test(e.message));
  assert.deepEqual(await s1.list(), []);
  const noBoot = world({ runFails: true });
  const s2 = noBoot.make();
  await assert.rejects(s2.acquire('a'), (e: any) => e.code === 'start_failed' && /did not boot/.test(e.message));
  assert.deepEqual(
    (await s2.list()).map((g: any) => g.state),
    ['suspended'],
    'the clone exists, so the next ask starts it',
  );
});

test('after a restart the record is checked against what tart has: a guest that is gone is forgotten, one that runs is running, an unreadable record refuses mutations and remains retryable', async () => {
  const w = world();
  const first = w.make();
  const a = await first.acquire('a');
  const b = await first.acquire('b');
  await first.release('b');
  w.vms.delete(a.name); // deleted behind the manager's back
  const second = w.make();
  assert.deepEqual(
    (await second.list()).map((g: any) => [g.chatId, g.state]),
    [['b', 'suspended']],
  );
  w.vms.set(b.name, true); // started by hand
  const third = w.make();
  assert.deepEqual(
    (await third.list()).map((g: any) => g.state),
    ['running'],
  );
  fs.writeFileSync(w.file, '{ nope');
  const corrupt = w.make();
  await assert.rejects(corrupt.list(), /ownership/);
  await assert.rejects(corrupt.acquire('new-chat'), /ownership/);
  assert.equal(fs.readFileSync(w.file, 'utf8'), '{ nope');
  fs.writeFileSync(w.file, JSON.stringify([{ name: 5 }, null, 'x']));
  await assert.rejects(corrupt.list(), /ownership/);
  fs.writeFileSync(w.file, '[]');
  assert.deepEqual(await corrupt.list(), []);
});

test('guests the manager did not start count against the Mac’s two: a third is refused while they hold the slots, and a sandbox of ours is paused to make room for the second', async () => {
  const w = world();
  w.vms.set('other-1', true);
  w.vms.set('other-2', true);
  const full = w.make();
  await assert.rejects(
    full.acquire('chat-a'),
    (e: any) => e instanceof SandboxError && e.code === 'capacity' && /already runs 2 virtual machines/.test(e.message),
  );
  assert.equal(w.log.length, 0, 'nothing was cloned or started');
  // one foreign guest and one of ours: a second chat pauses ours (it is idle) instead of starting a third
  w.vms.set('other-2', false);
  const sbx = w.make();
  const a = await sbx.acquire('chat-a');
  const b = await sbx.acquire('chat-b');
  assert.ok(w.log.includes(`suspend ${a.name}`));
  assert.equal(w.vms.get(b.name), true);
});

test('different chats share the capacity transaction: concurrent starts never boot a third guest', async () => {
  const w = world({ busy: new Set(['a', 'b', 'c']) });
  const sbx = w.make();
  const results = await Promise.allSettled(['a', 'b', 'c'].map((c) => sbx.acquire(c)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, MAX_RUNNING);
  assert.equal([...w.vms.values()].filter(Boolean).length, MAX_RUNNING);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
});

test('a failed startup inventory read remains retryable and never loses the saved ownership', async () => {
  const w = world();
  const a = await w.make().acquire('a');
  const running = w.tart.running;
  let fail = true;
  w.tart.running = async () => {
    if (fail) {
      fail = false;
      throw new Error('inventory unavailable');
    }
    return running();
  };
  const sbx = w.make();
  await assert.rejects(sbx.list(), /inventory unavailable/);
  assert.deepEqual(await sbx.list(), [{ name: a.name, chatId: 'a', state: 'running' }]);
});

test('a saved foreign guest or duplicate owner is refused before a destructive command', async () => {
  const w = world();
  w.vms.set('unrelated-user-vm', true);
  fs.writeFileSync(w.file, JSON.stringify([{ chatId: 'a', name: 'unrelated-user-vm', state: 'running' }]));
  const manager = w.make();
  await assert.rejects(manager.destroy('a'), /ownership/);
  await assert.rejects(manager.release('a'), /ownership/);
  assert.deepEqual(w.log, []);
  assert.equal(w.vms.get('unrelated-user-vm'), true);
  const row = { chatId: 'a', name: guestName('a'), state: 'suspended' };
  fs.writeFileSync(w.file, JSON.stringify([row, row]));
  await assert.rejects(manager.acquire('a'), /ownership/);
});

test('an externally resumed owned guest counts toward capacity even when its cached state is suspended', async () => {
  const w = world({ busy: new Set(['a', 'b', 'c']) });
  const manager = w.make();
  const a = await manager.acquire('a');
  await manager.release('a');
  w.vms.set(a.name, true);
  await manager.acquire('b');
  await assert.rejects(manager.acquire('c'), (e: any) => e.code === 'capacity');
  assert.equal([...w.vms.values()].filter(Boolean).length, MAX_RUNNING);
});

test('a VM that booted before its address check failed counts as running and can be cleaned up or retried', async () => {
  const w = world({ busy: new Set(['a', 'b', 'c']) });
  const run = w.tart.run;
  let fail = true;
  w.tart.run = async (name: string) => {
    await run(name);
    if (fail) {
      fail = false;
      throw new Error('address timeout');
    }
  };
  const manager = w.make();
  await assert.rejects(manager.acquire('a'), /address timeout/);
  await manager.acquire('b');
  await assert.rejects(manager.acquire('c'), (e: any) => e.code === 'capacity');
  assert.equal([...w.vms.values()].filter(Boolean).length, MAX_RUNNING);
  await manager.release('a');
  assert.equal(w.vms.get(guestName('a')), false);
  assert.deepEqual(await manager.acquire('a'), { name: guestName('a') });
  await manager.destroy('a');
  assert.equal(w.vms.has(guestName('a')), false);
});

test('the picker lists actual state after an external stop and resume', async () => {
  const w = world();
  const manager = w.make();
  const guest = await manager.acquire('a');
  w.vms.set(guest.name, false);
  assert.deepEqual(await manager.list(), [{ name: guest.name, chatId: 'a', state: 'suspended' }]);
  w.vms.set(guest.name, true);
  assert.deepEqual(await manager.list(), [{ name: guest.name, chatId: 'a', state: 'running' }]);
});

test('default idle policy suspends the oldest guest and a legacy record with no timestamp stays usable', async () => {
  const w = world();
  w.vms.set(guestName('legacy'), false);
  fs.writeFileSync(w.file, JSON.stringify([{ name: guestName('legacy'), chatId: 'legacy', state: 'suspended' }]));
  const manager = createSandboxVms({ tart: w.tart, golden: 'golden', file: w.file });
  await manager.acquire('legacy');
  await manager.acquire('b');
  await manager.acquire('c');
  assert.ok(w.log.some((entry) => entry.startsWith('suspend ')));
  assert.equal([...w.vms.values()].filter(Boolean).length, MAX_RUNNING);
});

test('a serialized non-list ownership record is refused, and a non-Error boot rejection is reported', async () => {
  const w = world();
  fs.writeFileSync(w.file, '{}');
  const manager = w.make();
  await assert.rejects(manager.list(), /ownership record is invalid/);
  fs.writeFileSync(w.file, '[]');
  w.tart.run = async () => {
    throw 'hypervisor unavailable';
  };
  await assert.rejects(manager.acquire('a'), /sandbox did not start: hypervisor unavailable/);
});
