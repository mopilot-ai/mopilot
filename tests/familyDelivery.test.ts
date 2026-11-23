// ChatController.deliverFamily: another session's message steers into a running chat where its harness can steer, and
// stays in the queue with a named reason where it cannot (awaiting the user, a pending switch, no steer capability).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './support/controller-coverage/setup.ts';
import { tick } from './support/async-scenarios.ts';

const item = (id: string, text = id) => ({ id, text, sideSession: { id }, attachments: [], opts: { human: false } });
const steerable = (c: any) => {
  c.codex.peerCapabilities = () => ({ messaging: true, read: true, steer: true });
  c.claudeTurns.peerCapabilities = () => ({ messaging: true, read: true, steer: true });
};
const ids = (s: any) => s.queue.map((x: any) => x.id);

test('an idle chat starts a turn with the message', async () => {
  const { c, log, s } = setup();
  assert.deepEqual(await c.deliverFamily('cx1', item('m1', 'hello')), { started: true });
  assert.deepEqual(log[0].slice(0, 3), ['turn', 'cx1', 'hello']);
  assert.deepEqual(ids(s('cx1')), []);
});

test('a running Codex or Claude chat takes the message as a steer and keeps nothing queued', async () => {
  for (const [id, step] of [
    ['cx1', 'steer'],
    ['cl1', 'claude-steer'],
  ]) {
    const { c, state, log, s } = setup({ ids: [id] });
    steerable(c);
    state.patch(id, { turn: 'running', activeTurn: { id: 't' } });
    assert.deepEqual(await c.deliverFamily(id, item('m1', 'mid-turn')), { started: true, steered: true });
    assert.deepEqual(log.at(-1).slice(0, 3), [step, id, 'mid-turn']);
    assert.deepEqual(ids(s(id)), []);
  }
});

test('a running ACP chat cannot steer: the message waits in the queue and the reason is no_steer', async () => {
  const { c, state, log, s } = setup({ ids: ['acp1'] });
  state.patch('acp1', { turn: 'running', activeTurn: { id: 't' } });
  assert.deepEqual(await c.deliverFamily('acp1', item('m1')), { started: false, queued: true, waitingFor: 'no_steer' });
  assert.deepEqual(ids(s('acp1')), ['m1']);
  assert.deepEqual(log, []);
});

test('a chat that declares no steer capability keeps the message queued even when its harness family steers', async () => {
  const { c, state, s } = setup();
  c.codex.peerCapabilities = () => ({ messaging: true, read: true, steer: false });
  state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
  assert.equal((await c.deliverFamily('cx1', item('m1'))).waitingFor, 'no_steer');
  assert.deepEqual(ids(s('cx1')), ['m1']);
});

test('a turn waiting for the user or a pending harness switch never takes a steer', async () => {
  for (const [patch, reason] of [
    [{ turn: 'awaitingUser', activeTurn: { id: 't' } }, 'awaiting_user'],
    [{ turn: 'running', activeTurn: { id: 't' }, pendingSwitch: { to: 'claude' } }, 'switch_pending'],
  ] as const) {
    const { c, state, log, s } = setup();
    steerable(c);
    state.patch('cx1', patch);
    assert.deepEqual(await c.deliverFamily('cx1', item('m1')), { started: false, queued: true, waitingFor: reason });
    assert.deepEqual(ids(s('cx1')), ['m1']);
    assert.deepEqual(log, []);
  }
});

test('an older family message in the queue keeps its place: the new one joins behind it instead of steering past it', async () => {
  const { c, state, log, s } = setup();
  steerable(c);
  state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
  c.send('cx1', item('old'));
  assert.deepEqual(await c.deliverFamily('cx1', item('new')), { started: false, queued: true, waitingFor: 'earlier_queued' });
  assert.deepEqual(ids(s('cx1')), ['old', 'new']);
  assert.deepEqual(log, []);
});

test("the user's own queued message does not hold a family steer back", async () => {
  const { c, state, s } = setup();
  steerable(c);
  state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
  c.send('cx1', { id: 'mine', text: 'typed' });
  assert.deepEqual(await c.deliverFamily('cx1', item('m1')), { started: true, steered: true });
  assert.deepEqual(ids(s('cx1')), ['mine']);
});

test('a steer the harness refuses leaves the message first in line with the cause', async () => {
  const { c, state, s } = setup({ result: { started: false, error: 'steer refused' } });
  steerable(c);
  state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
  const result = await c.deliverFamily('cx1', item('m1'));
  assert.equal(result.started, false);
  assert.equal(result.queued, true);
  assert.equal(result.error, 'steer refused');
  assert.deepEqual(ids(s('cx1')), ['m1']);
});

test('a turn that ended during the steer leaves a message that starts the next turn', async () => {
  const { c, state, s } = setup();
  steerable(c);
  state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
  const sent = c.deliverFamily('cx1', item('m1'));
  state.patch('cx1', { turn: 'idle', activeTurn: null });
  assert.deepEqual(await sent, { started: true, steered: true });
  await tick();
  assert.deepEqual(ids(s('cx1')), []);
});

test('a message the user removed before it was steered is reported as discarded, not delivered', async () => {
  const { c, state, s } = setup();
  steerable(c);
  state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
  const orig = c.sendNow.bind(c);
  c.sendNow = (chatId: string, qid: string, ...rest: any[]) => (c.removeQueued(chatId, qid), orig(chatId, qid, ...rest));
  assert.deepEqual(await c.deliverFamily('cx1', item('m1')), { started: false, discarded: true });
  assert.deepEqual(ids(s('cx1')), []);
});

test('compaction, voice and failed-dispatch outcomes of Send now map to the receipt shapes', async () => {
  for (const [status, expected] of [
    [{ status: 'held' }, { started: false, held: true }],
    [
      { status: 'queued', waitingFor: 'compaction' },
      { started: false, queued: true, waitingFor: 'compaction' },
    ],
    [{ status: 'queued' }, { started: false, queued: true }],
    [{ status: 'failed' }, { started: false, error: 'The harness did not accept the message.' }],
    [
      { status: 'failed', error: 'boom' },
      { started: false, error: 'boom' },
    ],
  ] as const) {
    const { c, state } = setup();
    steerable(c);
    state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
    c.sendNow = () => status as any;
    assert.deepEqual(await c.deliverFamily('cx1', item('m1')), expected);
  }
});

test('a chat whose family cannot steer keeps the message queued even if its adapter declares a steer', async () => {
  const { c, state, s } = setup({ ids: ['acp1'] });
  c.acpTurns.peerCapabilities = () => ({ messaging: true, read: true, steer: true });
  state.patch('acp1', { turn: 'running', activeTurn: { id: 't' } });
  assert.equal((await c.deliverFamily('acp1', item('m1'))).waitingFor, 'no_steer');
  assert.deepEqual(ids(s('acp1')), ['m1']);
});

test('familyWait names why a message would wait in a running chat, and null when it would steer in', () => {
  const { c, state } = setup();
  steerable(c);
  state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
  assert.equal(c.familyWait('cx1'), null);
  state.patch('cx1', { turn: 'awaitingUser' });
  assert.equal(c.familyWait('cx1'), 'awaiting_user');
});
