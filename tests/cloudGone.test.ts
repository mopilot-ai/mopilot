// A cloud machine that is gone (C4): `gone` comes from the provider and never from a timeout or an unreachable answer; the lost-Host path is offered only then; Delete names the chats first, can push each folder's work off the machine, and leaves the row and its chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CloudError, createFakeProvider } from '../shared/cloud/adapter.mjs';
import { makeApp } from './support/hostContinueKit.ts';
import { refusalCopy } from '../src/lib/hostSwitch.ts';

const require = createRequire(import.meta.url);
const { createCloudGone } = require('../electron/host/cloudGone.cjs');
const { createContinueMachine } = require('../electron/host/continue.cjs');

const CHAT = 'claude:c1';
const cloud = { provider: 'fake', id: 'fake-1', region: 'r1' };

async function setup(over: { cloud?: boolean } = {}) {
  const provider = createFakeProvider();
  await provider.create({ name: 'n', size: 's', region: 'r1', command: 'c' });
  const carried: string[] = [];
  const changes: number[] = [];
  let chats = [
    { chatId: 'c1', title: 'Fix login', folder: '/w/a' },
    { chatId: 'c2', title: 'Docs', folder: '/w/b' },
  ];
  const state = { carryFails: false };
  const gone = createCloudGone({
    rowOf: (id: string) => (id === 'cloud1' && over.cloud !== false ? { cloud } : undefined),
    adapterOf: () => provider,
    chatsOn: () => chats,
    carry: async (_h: string, chatId: string) => {
      if (state.carryFails) throw new Error('rejected');
      carried.push(chatId);
    },
    onChange: () => void changes.push(1),
  });
  return { provider, gone, carried, changes, state, setChats: (c: typeof chats) => (chats = c) };
}

test('only the provider says gone: an unreachable provider is unknown, a stopped machine is alive', async () => {
  const s = await setup();
  assert.equal(s.gone.stateOf('cloud1'), null);
  assert.equal(await s.gone.check('cloud1'), 'alive');
  s.provider.set('fake-1', 'stopped');
  assert.equal(await s.gone.check('cloud1'), 'alive');
  assert.equal(s.gone.stateOf('cloud1'), 'stopped');
  s.provider.failNext('status', new CloudError('failed', 'down', { retryable: true }));
  assert.equal(await s.gone.check('cloud1'), 'unknown');
  assert.equal(s.gone.isGone('cloud1'), false);
  assert.equal(await s.gone.check('plain'), 'not-cloud');
  s.provider.set('fake-1', 'gone');
  assert.equal(await s.gone.check('cloud1'), 'gone');
  assert.equal(await s.gone.check('cloud1'), 'gone');
  assert.equal(s.gone.isGone('cloud1'), true);
  assert.equal(s.changes.length, 1);
});

test('the lost-Host guard: a machine that exists or cannot be asked blocks, a gone or non-cloud one does not', async () => {
  const s = await setup();
  assert.equal((await s.gone.lostCheck('cloud1'))?.code, 'source_may_run');
  s.provider.failNext('status', new Error('x'));
  assert.equal((await s.gone.lostCheck('cloud1'))?.code, 'source_unknown');
  s.provider.set('fake-1', 'gone');
  assert.equal(await s.gone.lostCheck('cloud1'), null);
  assert.equal(await s.gone.lostCheck('plain'), null);
});

function machineFor(s: Awaited<ReturnType<typeof setup>>, confirmed: string[]) {
  const app = makeApp({ channel: () => ({ call: async () => null }), down: new Set() } as any);
  app.ownership.set(CHAT, { hostId: 'cloud1', ownerHostId: 'cloud1', epoch: 0, folder: '/w' });
  const calls: string[] = [];
  const machine = createContinueMachine({
    ownership: app.ownership,
    hostState: (id: string) => (id === 'B' ? 'online' : 'offline'),
    channel: () => ({
      call: async (method: string) => {
        calls.push(method);
        return method === 'chat.prepareContinue' ? { preparedId: 'p1', cwd: '/w2' } : {};
      },
    }),
    confirmLostHost: async () => (confirmed.push('asked'), true),
    mirrorRev: () => 3,
    newKey: () => 'k'.repeat(16),
    fetchTail: async () => [],
    mergeTail: async () => undefined,
    report: () => undefined,
    sleep: async () => undefined,
    lostCheck: (id: string) => s.gone.lostCheck(id),
  });
  return { machine, app, calls };
}
const req = { chatId: CHAT, targetHostId: 'B', harness: 'acp:gemini', cwd: '/w2', handoff: 'history' };

test('a message to a machine deleted in the provider console offers Continue on a new machine; one that still exists does not', async () => {
  const s = await setup();
  s.provider.set('fake-1', 'stopped');
  const asked: string[] = [];
  const a = machineFor(s, asked);
  await assert.rejects(a.machine.continueChat(req), (e: any) => e.code === 'source_may_run');
  assert.deepEqual(asked, []);
  assert.deepEqual(a.calls, []);
  assert.equal(a.app.ownership.get(CHAT).ownerHostId, 'cloud1');
  // the provider says it is gone: the person is asked, and the chat goes on from the client's copy
  s.provider.set('fake-1', 'gone');
  const b = machineFor(s, asked);
  const got = await b.machine.continueChat(req);
  assert.deepEqual(asked, ['asked']);
  assert.equal(got.lostHost, true);
  assert.equal(got.hostId, 'B');
  assert.match(refusalCopy('source_may_run', 'dev-cloud'), /still exists/);
  assert.match(refusalCopy('source_unknown', 'dev-cloud'), /Can't tell/);
});

test('Delete lists the chats first; a changed list refuses; carried work is pushed before the machine goes; the row stays', async () => {
  const s = await setup();
  const plan = s.gone.plan('cloud1');
  assert.deepEqual(
    plan.chats.map((c: any) => c.title),
    ['Fix login', 'Docs'],
  );
  await assert.rejects(s.gone.remove('cloud1', { token: 'not-seen' }), (e: any) => e.code === 'plan_changed');
  assert.equal(s.provider.machines.size, 1);
  s.setChats([...plan.chats, { chatId: 'c3', title: 'New', folder: null }]);
  await assert.rejects(s.gone.remove('cloud1', { token: plan.token }), (e: any) => e.code === 'plan_changed');
  s.setChats(plan.chats);
  assert.deepEqual(await s.gone.remove('cloud1', { token: plan.token, carry: ['c1', 'c2'] }), { deleted: true });
  assert.deepEqual(s.carried, ['c1', 'c2']);
  assert.equal(s.provider.machines.size, 0);
  assert.equal(s.gone.isGone('cloud1'), true);
  // a second delete of a machine already gone is done
  assert.deepEqual(await s.gone.remove('cloud1', { token: plan.token }), { deleted: true });
});

test('work that cannot be pushed stops the delete with the machine untouched; a machine that is not a cloud one is refused', async () => {
  const s = await setup();
  s.state.carryFails = true;
  const plan = s.gone.plan('cloud1');
  await assert.rejects(
    s.gone.remove('cloud1', { token: plan.token, carry: ['c1'] }),
    (e: any) => e.code === 'carry_failed' && e.details.chatId === 'c1',
  );
  assert.equal(s.provider.machines.size, 1);
  assert.equal(s.gone.isGone('cloud1'), false);
  await assert.rejects(s.gone.remove('plain', { token: 'x' }), (e: any) => e.code === 'not_cloud');
  s.state.carryFails = false;
  // an app with no way to push does not skip the work the person asked to save: the delete stops
  const bare = createCloudGone({ rowOf: () => ({ cloud }), adapterOf: () => s.provider, chatsOn: () => [] });
  await assert.rejects(
    bare.remove('x', { token: bare.plan('x').token, carry: ['c'] }),
    (e: any) => e.code === 'carry_failed' && /cannot push/.test(e.details.cause),
  );
  assert.equal(s.provider.machines.size, 1);
  assert.deepEqual(await bare.remove('x', { token: bare.plan('x').token }), { deleted: true });
});

test('a push that fails with no message still stops the delete', async () => {
  const s = await setup();
  const gone = createCloudGone({
    rowOf: () => ({ cloud }),
    adapterOf: () => s.provider,
    chatsOn: () => [],
    carry: async () => {
      throw undefined;
    },
  });
  await assert.rejects(
    gone.remove('x', { token: gone.plan('x').token, carry: ['c1'] }),
    (e: any) => e.code === 'carry_failed' && e.details.cause === '',
  );
  assert.equal(s.provider.machines.size, 1);
});

test('a machine whose provider key was removed is unknown, never gone', async () => {
  const s = await setup();
  const gone = createCloudGone({
    rowOf: () => ({ cloud }),
    adapterOf: () => {
      throw new Error('no key');
    },
    chatsOn: () => [],
  });
  assert.equal(await gone.check('x'), 'unknown');
  assert.equal((await gone.lostCheck('x'))?.code, 'source_unknown');
  assert.equal(gone.isGone('x'), false);
  assert.equal(s.provider.machines.size, 1);
});
