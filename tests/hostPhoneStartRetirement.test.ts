// Phone-start continuations preserve removed input, pairing authority and chat ownership while folder, subscription and permission checks are pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';
const require = createRequire(import.meta.url);
const { createHostPhone } = require('../electron/app/hostPhone.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('deleting a phone message during its folder check prevents dispatch after the check passes', async (t) => {
  const w = world(t);
  w.remote('c1');
  const gate = deferred();
  w.service.enqueue('c1', msg('deleted', UUID(1)), 1, gate.promise);
  await tick();
  assert.equal(w.service.remove('c1', UUID(1)), true);
  gate.resolve();
  await tick();
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.queues.get('c1'), []);
});

test('a follow-up waiting for its permission is not offered as sent input to another turn', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.modes.set('c1', 'auto-review');
  const permission = deferred();
  w.host.permit = (async () => permission.promise) as any;
  const sending = w.service.send('c1', msg('not yet sent', UUID(1)), 1);
  await tick();
  assert.equal(w.sent.length, 0);
  const fallback = w.service.sent.take('c1');
  permission.resolve();
  await sending;
  assert.equal(fallback, undefined, 'an unrelated running turn cannot claim input whose send has not begun');
  assert.equal(w.sent.length, 1);
});

for (const invalidator of ['remove', 'move', 'dispose'] as const)
  test(`a pending permission does not dispatch after ${invalidator}`, async (t) => {
    const w = world(t);
    w.remote('c1');
    w.modes.set('c1', 'auto-review');
    const permission = deferred();
    w.host.permit = (async () => permission.promise) as any;
    const sending = w.service.send('c1', msg('retired input', UUID(1)), 1);
    await tick();
    if (invalidator === 'remove') assert.equal(w.service.remove('c1', UUID(1)), true);
    else if (invalidator === 'move') w.remote('c1', 'other', 2);
    else w.service.dispose();
    permission.resolve();
    await sending;
    assert.equal(w.sent.length, 0);
    if (invalidator === 'remove') assert.deepEqual(w.queues.get('c1'), []);
    else assert.equal(w.outboxes[0].pending('c1').length, 1, 'retiring a continuation retains its input for a valid retry');
  });

test('a phone removed while the local chat start resolves never enqueues its first message', async () => {
  const start = deferred();
  let paired = true;
  const effects: string[] = [];
  const phone = createHostPhone({
    allowed: () => true,
    watch: () => undefined,
    machines: () => ({ list: () => ({ machines: [{ id: 'box', name: 'box', status: 'online' }] }), row: () => ({ id: 'box' }) }),
    folders: () => ({ list: async () => ({ path: '/srv' }) }),
    machineChats: {
      newChatId: () => 'acp:host-claude:one',
      start: async () => {
        await start.promise;
        return { listed: Promise.resolve() };
      },
    },
    enqueue: () => (effects.push('enqueue'), { action: 'queued' }),
    setMode: () => effects.push('mode'),
    announce: () => effects.push('announce'),
    move: async () => ({}),
    plan: async () => ({}),
    ownership: { get: () => ({ hostId: 'box' }) },
    orgCovers: () => false,
    changed: () => undefined,
    projects: () => [],
  });
  const pending = phone.start({
    hostId: 'box',
    folder: '/srv',
    harness: 'claude',
    projectId: null,
    text: 'hi',
    model: null,
    effort: null,
    permission: 'auto-review',
    check: () => {
      if (!paired) throw new Error('Phone is no longer paired.');
    },
  });
  paired = false;
  start.resolve();
  await assert.rejects(pending, /no longer paired/);
  await tick();
  assert.deepEqual(effects, []);
});

test('an accepted message awaiting its user record stays ahead of newer offline input', async (t) => {
  const w = world(t);
  w.remote('c1');
  await w.service.send('c1', msg('first', UUID(1)), 1);
  w.goAway();
  await w.service.send('c1', msg('second', UUID(2)), 1);
  assert.deepEqual(
    w.queues.get('c1')!.map((item) => item.text),
    ['first', 'second'],
  );
});

for (const outcome of ['pending', 'refused'] as const)
  test(`a restart preserves a ${outcome} first-message folder check`, async (t) => {
    const w = world(t);
    w.remote('c1');
    const gate = deferred();
    const check =
      outcome === 'pending'
        ? gate.promise
        : Promise.reject(Object.assign(new Error('That folder is outside what this host shares.'), { code: 'outside_roots' }));
    w.service.enqueue('c1', msg('must remain gated', UUID(1)), 1, check);
    await tick();
    assert.equal(w.sent.length, 0);
    w.service.dispose();
    const restarted = w.make();
    t.after(() => restarted.dispose());
    await restarted.resume();
    assert.equal(w.sent.length, 0, 'a restart cannot turn unvalidated or refused input into accepted input');
    assert.equal(w.outboxes.at(-1).pending('c1').length, 1);
    gate.resolve();
    await tick();
  });

test('continuing a phone message to another machine validates that machine and folder', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 1, '/old');
  w.goAway();
  w.service.enqueue('c1', msg('continue', UUID(1)), 1, Promise.resolve());
  await tick();
  const checked: string[] = [];
  w.config.checkFolder = async (hostId, folder) => {
    checked.push(`${hostId}:${folder}`);
  };
  w.remote('c1', 'replacement', 2, '/new');
  w.host.up = true;
  w.row.status = 'online';
  await w.service.rebase('c1');
  assert.deepEqual(checked, ['replacement:/new']);
  assert.equal(w.sent.length, 1);
});

test('Send now rechecks a repaired folder after a previous refusal', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 1, '/srv');
  w.service.enqueue(
    'c1',
    msg('retry', UUID(1)),
    1,
    Promise.reject(Object.assign(new Error('Folder is missing.'), { code: 'directory_missing' })),
  );
  await tick();
  assert.equal(w.queues.get('c1')![0].waitingFor, 'hostRefused');
  let checks = 0;
  w.config.checkFolder = async () => {
    checks++;
  };
  const receipt = await w.service.sendNow('c1', UUID(1));
  assert.equal(checks, 1);
  assert.deepEqual(receipt, { status: 'sent' });
  assert.equal(w.sent.length, 1);
});
