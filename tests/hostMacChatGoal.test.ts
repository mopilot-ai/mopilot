// A machine chat's goal controls on this Mac's side (electron/host/remoteChatCalls.cjs, chatIds.cjs, remoteGoal.cjs, remoteSendDelivery.cjs, harness/bindings.cjs): the request carries the chat's epoch and a key (A), the Host is asked with its own chat id and an unreachable one fails now (W), an older Host is refused before anything is sent (B), and a machine's Claude Code or Codex chat has the goal binding while a basic agent keeps its own (I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { helloParams, requireFeatures } from '../shared/host/schema.mjs';
import { world } from './support/host/remoteSendKit.ts';

const require = createRequire(import.meta.url);
const { chatCalls } = require('../electron/host/remoteChatCalls.cjs');
const { withAppChatIds } = require('../electron/host/chatIds.cjs');
const { createGoal, goalChat, GOAL_AWAY } = require('../electron/host/remoteGoal.cjs');
const { deliverRemote } = require('../electron/host/remoteSendDelivery.cjs');
const { acpBindings } = require('../electron/harness/bindings.cjs');
const { computeCaps } = require('../electron/session/caps.cjs');

const U = '3f2b6f58-4a1e-4e0b-9b7c-1d2e3f4a5b6c';
const claudeId = `claude:${U}`;

function calls(features: string[] = helloParams().features) {
  const asked: any[][] = [];
  const c = chatCalls({
    needs: (method: string, params?: any) => requireFeatures(method, { features }, params),
    request: async (method: string, params: any) => (asked.push([method, params]), { result: { goal: { status: 'paused' } } }),
    epochOf: () => 7,
    mintKey: () => 'key-goal-mint0000',
    speaks: () => true,
  });
  return { c, asked };
}

test('A: the action goes to the Host with the chat’s epoch and a key, and only the fields the action takes', async () => {
  const { c, asked } = calls();
  assert.deepEqual(await c.goal(claudeId, { action: 'pause', tokens: 5, objective: 'x' } as any), { goal: { status: 'paused' } });
  assert.deepEqual(asked[0], ['chat.goal', { chatId: claudeId, epoch: 7, key: 'key-goal-mint0000', action: 'pause' }]);
  // a caller that retries names its own key
  await c.goal(claudeId, { action: 'budget', tokens: 200_000 }, { key: 'key-retry-00001' });
  assert.deepEqual(asked[1][1], { chatId: claudeId, epoch: 7, key: 'key-retry-00001', action: 'budget', tokens: 200_000 });
  await c.goal(claudeId, { action: 'clear', human: true });
  assert.equal(asked[2][1].human, true);
  await assert.rejects(c.goal(claudeId, { action: 'set' }), (e: any) => e.code === 'invalid');
});

test('A: a message that sets the goal carries `goal: true` to the Host, in a chat’s first message and in a later one', async () => {
  const { c, asked } = calls();
  await c.send(claudeId, { text: 'ship it', goal: true });
  await c.start(claudeId, { harness: 'claude', text: 'ship it', goal: true });
  await c.send(claudeId, { text: 'hello', goal: false } as any);
  await c.start(claudeId, { harness: 'claude', text: 'hello' });
  assert.deepEqual(
    asked.map(([m, p]) => [m, p.goal]),
    [
      ['chat.send', true],
      ['chat.start', true],
      ['chat.send', undefined],
      ['chat.start', undefined],
    ],
  );
});

test('B: a Host without the feature is refused before anything is sent: the control, and a message that would only be text there', async () => {
  const old = calls(helloParams().features.filter((f: string) => f !== 'goalControls'));
  await assert.rejects(
    old.c.goal(claudeId, { action: 'pause' }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes('goalControls'),
  );
  await assert.rejects(old.c.send(claudeId, { text: 'ship it', goal: true }), (e: any) => e.code === 'feature_missing');
  await assert.rejects(old.c.start(claudeId, { harness: 'codex', text: 'ship it', goal: true }), (e: any) => e.code === 'feature_missing');
  await old.c.send(claudeId, { text: 'hello' });
  // a message with nothing in it is refused by the shared parser, before the Host is asked
  await assert.rejects(old.c.send(claudeId, undefined as any), (e: any) => e.code === 'invalid');
  assert.deepEqual(
    old.asked.map((a) => a[0]),
    ['chat.send'],
  );
});

test('W: the Host is asked with its own chat id, whatever id the app shows', async () => {
  const asked: any[] = [];
  const host = { state: () => 'online', goal: async (...a: any[]) => (asked.push(a), { goal: null }) };
  const view = withAppChatIds(host, () => true);
  await view.goal(`acp:host-claude:${U}`, { action: 'resume' }, { key: 'k' });
  assert.deepEqual(asked, [[claudeId, { action: 'resume' }, { key: 'k' }]]);
});

test('W: a goal action reaches the Host now or fails, as Stop does; a chat that runs here is not this call’s', async () => {
  const asked: any[] = [];
  let state = 'online';
  const host = { state: () => state, goal: async (...a: any[]) => (asked.push(a), { goal: null }) };
  const goal = createGoal({
    isRemote: (id: string) => id !== 'here',
    hostFor: (id: string) => (id === 'm1' ? host : null),
    ownerOf: () => ({ hostId: 'm1' }),
    mintKey: () => 'minted',
  });
  assert.equal(goal('here', { action: 'pause' }), null);
  assert.deepEqual(await goal('c', { action: 'pause' }), { goal: null });
  assert.deepEqual(asked, [['c', { action: 'pause' }, { key: 'minted' }]]);
  state = 'offline';
  await assert.rejects(goal('c', { action: 'pause' }), { message: GOAL_AWAY });
  assert.equal(asked.length, 1);
  const lost = createGoal({ isRemote: () => true, hostFor: () => null, ownerOf: () => ({ hostId: 'gone' }), mintKey: () => 'k' });
  await assert.rejects(lost('c', { action: 'pause' }), { message: GOAL_AWAY });
});

test('W: the remote service runs a goal action on the machine of a chat that runs there, now or never, and leaves a chat here alone', async (t) => {
  const w = world(t);
  const asked: any[][] = [];
  (w.host as any).goal = async (chatId: string, what: any, opts: any) => (asked.push([chatId, what, opts.key]), { goal: null });
  assert.equal(w.service.goal('local-chat', { action: 'pause' }), null);
  w.remote('c1');
  assert.deepEqual(await w.service.goal('c1', { action: 'clear', human: true }), { goal: null });
  assert.deepEqual(
    asked.map((a) => a.slice(0, 2)),
    [['c1', { action: 'clear', human: true }]],
  );
  assert.ok(asked[0][2].length >= 8, 'under a key of its own');
  w.goAway();
  await assert.rejects(Promise.resolve(w.service.goal('c1', { action: 'pause' })), { message: GOAL_AWAY });
  assert.equal(asked.length, 1);
});

test('W: the IPC answers with the Host’s reply, and refuses a chat that runs on this Mac', async () => {
  const live = { remoteSend: () => ({ goal: (id: string, what: any) => (id === 'c' ? Promise.resolve({ goal: what }) : null) }) };
  assert.deepEqual(await goalChat(live, 'c', { action: 'clear' }), { goal: { action: 'clear' } });
  assert.throws(
    () => goalChat(live, 'local', {}),
    (e: any) => e.code === 'invalid' && e.message === 'This chat runs on this Mac.',
  );
  assert.throws(() => goalChat({ remoteSend: () => null }, 'c', {}), /runs on this Mac/);
  assert.throws(() => goalChat({}, 'c', {}), /runs on this Mac/);
  // no chat named: the service is asked about no chat at all, and a chat that is not on a machine is this Mac's
  const seen: string[] = [];
  assert.throws(() => goalChat({ remoteSend: () => ({ goal: (id: string) => (seen.push(id), null) }) }, undefined, {}), /runs on this Mac/);
  assert.deepEqual(seen, ['']);
  assert.throws(() => goalChat(undefined, undefined, {}), /runs on this Mac/);
});

test('I: `host:chatGoal` is registered with the IPC and answers through the remote service of main', async () => {
  const { register } = require('../electron/app/ipc/host.cjs');
  const handlers = new Map<string, any>();
  const reached: any[] = [];
  const deps: any = {
    app: { getPath: () => '/ud' },
    shell: { openExternal: async () => undefined },
    shellEnv: { childEnv: () => ({}) },
    broadcastAll: () => undefined,
    live: {},
  };
  register({ handle: (c: string, fn: any) => handlers.set(c, fn) }, deps, {
    create: () => ({}),
    allowed: () => true,
    makeRemoteSend: () => () => ({ goal: (...a: any[]) => (reached.push(a), Promise.resolve({ goal: null })) }),
    makeRemoteChats: () => ({ get: () => undefined }),
  });
  const handler = handlers.get('host:chatGoal');
  assert.ok(handler, 'the channel is registered');
  const out = await handler({}, `acp:host-claude:${U}`, { action: 'pause' });
  assert.deepEqual(out, { value: { goal: null } });
  assert.deepEqual(reached, [[`acp:host-claude:${U}`, { action: 'pause' }]]);
});

/** One queued message delivered through the outbox's own delivery code, to a machine that records what it is sent. */
async function deliver(opts: object, start?: object) {
  const sent: any[] = [];
  const host: any = {
    send: async (chatId: string, item: any) => (sent.push(['send', chatId, item]), { result: {} }),
    start: async (chatId: string, item: any) => (sent.push(['start', chatId, item]), { result: {} }),
    permit: async () => undefined,
  };
  const entry = {
    chatId: claudeId,
    key: 'key-goal-0000001',
    epoch: 3,
    state: 'queued',
    options: { item: { text: 'ship it', attachments: [], opts }, ...(start ? { start } : {}) },
  };
  await deliverRemote(entry, { hostId: 'm1', epoch: 3, folder: '/srv' }, host, {
    checks: { validate: async () => undefined },
    subscribed: async () => undefined,
    disposed: () => false,
    outbox: { pending: () => [{ key: entry.key, state: 'queued' }] },
    ownerOf: () => ({ hostId: 'm1', epoch: 3, folder: '/srv' }),
    state: () => ({ get: () => undefined }),
    projection: { remember: () => undefined, forget: () => undefined },
    hostFor: () => host,
  });
  return sent;
}

test('W: a queued message that sets the goal is sent as one, and the others are not', async () => {
  assert.equal((await deliver({ goal: 'ship it', human: true }))[0][2].goal, true);
  assert.equal('goal' in (await deliver({ human: true }))[0][2], false);
  const start = (await deliver({ goal: 'ship it' }, { harness: 'codex', projectId: null }))[0];
  assert.deepEqual([start[0], start[2].goal], ['start', true]);
  assert.equal('goal' in (await deliver({}, { harness: 'codex', projectId: null }))[0][2], false);
});

test('I: Claude Code and Codex on a machine have the goal run by the machine’s agent; a basic agent keeps what it lists, and a chat here is untouched', () => {
  const goal = (kind: string, acp: any = null) => acpBindings(acp, kind).goal;
  assert.deepEqual(goal('acp:host-claude'), { via: 'rpc', method: 'chat.goal' });
  assert.deepEqual(goal('acp:host-codex'), { via: 'rpc', method: 'chat.goal' });
  assert.equal(goal('acp:kimi').via, 'none');
  assert.equal(goal('acp:kimi', { commands: ['goal'] }).via, 'passthrough');
  assert.equal(goal('acp:host-claude-lookalike').via, 'none');
  assert.equal(acpBindings(null).goal.via, 'none');
  assert.equal(acpBindings({ commands: ['goal'] }).goal.via, 'passthrough');
  // the chat's capabilities say it is its own: native on a machine's Claude Code, absent for another basic agent with the words a chat here has
  const bare = { negotiated: null, provider: null, model: null, account: null, flags: {}, session: null };
  assert.equal(computeCaps({ kind: 'acp:host-claude', ...bare }).goal.state, 'native');
  assert.equal(computeCaps({ kind: 'acp:host-codex', ...bare }).goal.state, 'native');
  assert.equal(computeCaps({ kind: 'acp:kimi', ...bare }).goal.state, 'absent');
});
