// What happens to the messages kept for a machine when the chat is continued elsewhere (electron/host/remoteSend.cjs rebase, electron/app/ipc/host.cjs host:continue): they go to the new owner, or to this Mac's controller when the chat came back, in order and once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, msg, UUID, code } from './support/host/remoteSendKit.ts';
const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');

test('rebase with nothing kept does nothing (no outbox read for a chat that never queued)', async (t) => {
  const w = world(t);
  w.remote('c1');
  await w.service.rebase('c1');
  assert.equal(w.sent.length, 0);
  assert.equal(w.local.sent.length, 0);
});

test('continued to another machine: the messages queued for the old owner go to the new one under the new epoch', async (t) => {
  const w = world(t, { epoch: 1 });
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('one', UUID(1)), 1);
  await w.service.send('c1', msg('two', UUID(2)), 1);
  w.remote('c1', 'other', 2);
  w.comeBack();
  await w.service.rebase('c1');
  assert.deepEqual(
    w.sent.map((s) => [s.item.text, s.key]),
    [
      ['one', UUID(1)],
      ['two', UUID(2)],
    ],
  );
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
});

test('continued back to this Mac: the kept messages go to the controller in order, once, and their bubbles go (A5)', async (t) => {
  const w = world(t, { epoch: 1 });
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', { ...msg('one', UUID(1)), opts: { model: 'm' } }, 1);
  await w.service.send('c1', msg('two', UUID(2)), 1);
  w.remote('c1', 'local', 2);
  await w.service.rebase('c1');
  assert.deepEqual(
    w.local.sent.map(([chatId, item]) => [chatId, item.text, item.opts, item.id]),
    [
      ['c1', 'one', { model: 'm' }, UUID(1)],
      ['c1', 'two', {}, UUID(2)],
    ],
  );
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
  await w.service.rebase('c1');
  assert.equal(w.local.sent.length, 2, 'a second rebase finds nothing left to send');
  assert.equal(w.sent.length, 0, 'nothing went to the machine');
});

test('a controller that refuses a message keeps it and the ones behind it; the refusal is reported (B1)', async (t) => {
  const w = world(t, { epoch: 1 });
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('one', UUID(1)), 1);
  await w.service.send('c1', msg('two', UUID(2)), 1);
  w.remote('c1', 'local', 2);
  w.local.receipt = { action: 'failed', error: 'The harness did not accept the message.' };
  await w.service.rebase('c1');
  assert.deepEqual(
    w.queues.get('c1')!.map((q) => q.id),
    [UUID(1), UUID(2)],
  );
  assert.equal(w.reports.length, 1);
  w.local.receipt = { action: 'started' };
  await w.service.rebase('c1');
  assert.deepEqual(
    w.local.sent.map(([, item]) => item.text),
    ['one', 'one', 'two'],
  );
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
});

test('a controller that throws, or no way to reach it, keeps the messages (A2)', async (t) => {
  const w = world(t, { epoch: 1 });
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('one', UUID(1)), 1);
  w.remote('c1', 'local', 2);
  w.local.throws = code('boom', 'x');
  await w.service.rebase('c1');
  assert.equal(w.reports.length, 1);
  assert.equal(w.queues.get('c1')!.length, 1);
  w.local.throws = null;
  w.local.receipt = null;
  await w.service.rebase('c1');
  assert.equal(w.queues.get('c1')!.length, 1, 'a receipt that says nothing is not a delivery');
});

test('IPC host:continue: the chat is held while it moves; a successful continue sends what was kept to the new owner, a refused one to where it stayed, and a failing end does not fail the continue', async () => {
  const calls: string[] = [];
  const live: any = {
    hostContinue: async () => ({ hostId: 'box', epoch: 2 }),
    controller: { state: {} },
  };
  const handlers = new Map<string, any>();
  let holding = false;
  const remote: any = {
    moving: () => holding,
    holdMove: (chatId: string) => ((holding = true), void calls.push(`hold ${chatId}`)),
    endMove: async (chatId: string) => ((holding = false), void calls.push(`end ${chatId}`)),
  };
  let service: any = remote;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live, app: { getPath: () => '/nowhere' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: () => ({ list: () => ({ machines: [], resolved: true }) }) as any,
      allowed: () => true,
      makeRemoteSend: (() => () => service) as any,
    },
  );
  const call = (c: string, ...a: any[]) => handlers.get(c)({}, ...a);
  const req = { chatId: 'c1', targetHostId: 'box', cwd: '/srv' };
  assert.deepEqual(await call('host:continue', req), { value: { hostId: 'box', epoch: 2 } });
  assert.deepEqual(calls.splice(0), ['hold c1', 'end c1']);
  live.hostContinue = async () => {
    throw Object.assign(new Error('No such folder.'), { code: 'directory_missing' });
  };
  assert.equal((await call('host:continue', req)).error.code, 'directory_missing');
  assert.deepEqual(calls.splice(0), ['hold c1', 'end c1'], 'a refused continue sends what was kept to the owner it still has');
  live.hostContinue = async () => ({ hostId: 'box', epoch: 3 });
  remote.endMove = async () => {
    throw new Error('disk');
  };
  assert.deepEqual(await call('host:continue', req), { value: { hostId: 'box', epoch: 3 } });
  holding = false;
  service = null;
  assert.deepEqual(await call('host:continue', req), { value: { hostId: 'box', epoch: 3 } }, 'Host off: nothing to hold');
});

test('IPC: the run paused for unanswered cards tells the notifier, and nothing when this app has no notifier', () => {
  const notices: any[] = [];
  const live: any = { controller: { state: {} }, notifier: { notify: (...a: any[]) => notices.push(a) } };
  /** @type {any} */
  let given: any;
  const make = (deps: any) =>
    register({ handle: () => undefined }, deps, {
      create: () => ({ list: () => ({ machines: [], resolved: true }) }) as any,
      allowed: () => true,
      makeRemoteSend: ((o: any) => ((given = o), () => null)) as any,
    });
  const app = { getPath: () => '/nowhere' };
  make({ live, app, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined });
  given.paused('c1');
  assert.deepEqual(notices, [['approval', 'c1', { title: 'Run paused: no one answered its approvals', body: '' }]]);
  delete live.notifier;
  assert.doesNotThrow(() => given.paused('c1'));
});

test('IPC host:continue: what the dialog asks to carry is read strictly: confirmed only when true, files as strings, unpushed commits as a positive whole number', async () => {
  const seen: any[] = [];
  const live: any = { hostContinue: async (r: any) => (seen.push(r.carry), { hostId: 'box', epoch: 2 }), controller: { state: {} } };
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live, app: { getPath: () => '/nowhere' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: () => ({ list: () => ({ machines: [], resolved: true }) }) as any,
      allowed: () => true,
      makeRemoteSend: (() => () => null) as any,
    },
  );
  const base = { chatId: 'c1', targetHostId: 'box', cwd: '/srv' };
  for (const carry of [
    { confirmed: true, untracked: ['a', 7], unpushed: 3 },
    { confirmed: 'yes', untracked: 'a', unpushed: 2.5 },
    { unpushed: -1 },
    { unpushed: '4' },
    null,
  ])
    await handlers.get('host:continue')({}, { ...base, carry });
  assert.deepEqual(seen, [
    { confirmed: true, untracked: ['a'], unpushed: 3 },
    { confirmed: false, untracked: [], unpushed: 0 },
    { confirmed: false, untracked: [], unpushed: 0 },
    { confirmed: false, untracked: [], unpushed: 0 },
    null,
  ]);
});
