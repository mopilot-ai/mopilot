// Main owns Retry admission across windows: an observed idle revision cannot become a queued or steered stale send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, selectSegment, tick } from './support/controller/fixture.ts';

for (const [kind, native] of [
  ['codex', 'native'],
  ['claude', 'claude:native'],
  ['acp:opencode', 'acp:opencode:native'],
]) {
  test(`${kind}: two windows claiming the same idle revision dispatch only one Retry, even after the first turn ends`, async () => {
    const f = setup();
    selectSegment(f.c, f.chats, 'chat', [[kind, native]]);
    const retry = { text: 'retry the failed message', opts: { human: true }, followUp: 'steer', retryAtRevision: f.s('chat').rev };
    f.c.send('chat', retry, 1);
    assert.equal(f.execs[0].item.opts.retainInMain, true);
    assert.throws(() => f.c.send('chat', retry, 2), /chat changed/i);
    assert.equal(f.s('chat').queue.length, 0);
    f.state.patch('chat', { turn: 'idle', activeTurn: null });
    assert.throws(() => f.c.send('chat', retry, 2), /chat changed/i);
    await tick();
    assert.equal(f.execs.length, 1);
  });
}

test('malformed and stale claims are refused before queueing, even with a current idle revision', async () => {
  const f = setup();
  for (const retryAtRevision of [null, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 42]) {
    assert.throws(() => f.c.send('chat', { text: 'retry', retryAtRevision }, 1), /chat changed/i);
  }
  for (const turn of ['running', 'awaitingUser']) {
    f.state.patch('chat', { turn });
    assert.throws(() => f.c.send('chat', { text: 'retry', retryAtRevision: f.s('chat').rev }, 1), /chat changed/i);
  }
  f.state.patch('chat', { turn: 'idle', activeTurn: { id: 'pending-current', human: true } });
  assert.throws(() => f.c.send('chat', { text: 'retry', retryAtRevision: f.s('chat').rev }, 1), /chat changed/i);
  assert.equal(f.execs.length, 0);
  assert.equal(f.s('chat').queue.length, 0);
  f.state.patch('chat', { activeTurn: null });
  const accepted = await f.c.send('chat', { text: 'retry', opts: { human: true }, retryAtRevision: f.s('chat').rev }, 1, true);
  assert.equal(accepted.action, 'started');
  assert.equal('retryAtRevision' in f.execs[0].item, false, 'the admission claim never reaches a harness or a persisted queue item');
  await tick();
});

test('native admission failure retains one main-owned Retry that survives serialization and is recovered from its queue', async () => {
  const f = setup({ auto: false });
  const retry = { text: 'hello', opts: { human: true }, retryAtRevision: f.s('chat').rev };
  const pending = f.c.send('chat', retry, 1, true);
  f.execs[0].done({ started: false, error: 'This chat is open in another Codex app.' });
  const receipt = await pending;
  assert.equal(receipt.action, 'queued');
  assert.equal(f.s('chat').queue.length, 1);
  const kept = JSON.parse(JSON.stringify(f.s('chat').queue[0]));
  assert.equal(kept.opts.retainInMain, true);
  assert.equal(kept.retryAtRevision, undefined);
  assert.throws(() => f.c.send('chat', { ...retry, retryAtRevision: f.s('chat').rev }, 2), /chat changed/i);
  f.state.patch('chat', { queue: [kept] });
  const recovered = f.c.sendNow('chat', kept.id, 1, true);
  f.execs[1].done({ started: true });
  assert.equal((await recovered).status, 'sent');
  assert.equal(f.s('chat').queue.length, 0);
});

test('main refuses a generic Retry while the original input is already retained in its queue', () => {
  const f = setup();
  const kept = { id: 'kept', text: 'hello', attachments: [], opts: { human: true } };
  f.state.patch('chat', { queue: [kept] });
  assert.throws(() => f.c.send('chat', { text: 'hello', retryAtRevision: f.s('chat').rev }, 1), /chat changed/i);
  assert.deepEqual(f.s('chat').queue, [kept]);
  assert.equal(f.execs.length, 0);
});
