// Refused controller retries retain exactly one input owner across send and steer entrypoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick } from './support/controller/fixture';

for (const wait of [false, true]) {
  test(`Send now preserves a renderer-held retry without duplicating it (awaited=${wait})`, async () => {
    const { c, state, execs, s } = setup({ auto: false });
    const item = { id: 'held', text: 'only once', attachments: [], opts: {}, origin: 1 };
    state.patch('t1', { queue: [item] });
    const result = c.sendNow('t1', item.id, 1, wait);
    execs[0].done({ started: false, held: true });
    if (wait) assert.deepEqual(await result, { status: 'held' });
    await tick();
    assert.deepEqual(s('t1').queue, []);
    c.send('t1', item, 1);
    execs[1].done({ started: true });
    await tick();
    c.end('t1');
    await tick();
    assert.equal(execs.length, 2);
  });
}

for (const family of ['codex', 'claude', 'acp:kimi']) {
  test(`unawaited Send now retains refused input and concurrent queued writes on ${family}`, async () => {
    const { c, chats, state, execs, s } = setup({ auto: false });
    chats.records.set('chat', { id: 'chat', segments: [{ kind: family, nativeId: 'native' }] });
    const item = { id: 'retry', text: 'keep me', attachments: [{ path: '/file' }], opts: { human: true }, origin: 1 };
    state.patch('chat', { queue: [item] });
    assert.equal(c.sendNow('chat', item.id, 1), true);
    c.send('chat', { id: 'later', text: 'later' }, 2);
    c.end('chat', { drain: false });
    execs[0].done({ started: false, error: 'refused' });
    await tick();
    assert.deepEqual(
      s('chat').queue.map((q: any) => q.id),
      ['retry', 'later'],
    );
    assert.deepEqual(s('chat').queue[0], item);
    const retry = c.sendNow('chat', item.id, 1, true);
    execs[1].done({ started: true });
    assert.deepEqual(await retry, { status: 'sent' });
    assert.deepEqual(
      s('chat').queue.map((q: any) => q.id),
      ['later'],
    );
  });
}

test('failed steer fallback honors renderer ownership after the running turn ends', async () => {
  const { c, state, execs, s } = setup({ auto: false });
  state.patch('t1', { turn: 'running', activeTurn: { id: 'live' } });
  const item = { id: 'steer', text: 'only once', attachments: [], opts: {}, origin: 1 };
  const delivery = c.steer('t1', item, 1);
  c.end('t1');
  execs[0].done({ started: false });
  await tick();
  execs[1].done({ started: false, held: true });
  assert.equal((await delivery).held, true);
  assert.deepEqual(s('t1').queue, []);
});

for (const wait of [false, true]) {
  test(`Send now preserves rejected native input (awaited=${wait})`, async () => {
    const { c, state, s } = setup();
    const startTurn = c.codex.startTurn;
    c.codex.startTurn = async () => {
      throw new Error('native transport failed');
    };
    const item = { id: 'reject', text: 'keep me', attachments: [], opts: {}, origin: 1 };
    state.patch('t1', { queue: [item] });
    const receipt = c.sendNow('t1', item.id, 1, wait);
    if (wait) assert.deepEqual(await receipt, { status: 'queued', error: 'native transport failed' });
    await tick();
    assert.deepEqual(s('t1').queue, [item]);
    assert.deepEqual([s('t1').turn, s('t1').crashed, s('t1').activeTurn], ['crashed', 'native transport failed', null]);
    // The user retries the one retained input; a successful start clears the old cause.
    c.codex.startTurn = startTurn;
    assert.deepEqual(await c.sendNow('t1', item.id, 1, true), { status: 'sent' });
    assert.deepEqual(s('t1').queue, []);
    assert.equal(s('t1').turn, 'running');
    assert.equal(s('t1').crashed, null);
    assert.equal(s('t1').activeTurn?.id, `pending-${item.id}`);
    c.end('t1');
  });
}

test('failed steer fallback preserves a rejecting native start', async () => {
  const { c, state, execs, s } = setup({ auto: false });
  c.codex.startTurn = async () => {
    throw new Error('native transport failed');
  };
  state.patch('t1', { turn: 'running', activeTurn: { id: 'live' } });
  const item = { id: 'steer-reject', text: 'keep me', attachments: [], opts: {}, origin: 1 };
  const receipt = c.steer('t1', item, 1);
  c.end('t1');
  execs[0].done({ started: false });
  assert.equal((await receipt).error, 'native transport failed');
  assert.deepEqual(s('t1').queue, [item]);
});

for (const accepted of [false, true]) {
  for (const olderFirst of [false, true]) {
    test(`independent retries preserve input when native replies reverse (olderFirst=${olderFirst}, accepted=${accepted})`, async () => {
      const { c, state, execs, s } = setup({ auto: false });
      const first = { id: 'first', text: 'first', attachments: [], opts: {}, origin: 1 };
      const second = { ...first, id: 'second', text: 'second' };
      state.patch('t1', { queue: [first, second] });
      const old = c.sendNow('t1', first.id, 1, true);
      c.end('t1', { drain: false });
      const newer = c.sendNow('t1', second.id, 1, true);
      if (olderFirst) {
        execs[0].done({ started: accepted, error: accepted ? undefined : 'old refused' });
        assert.equal((await old).status, accepted ? 'sent' : 'queued');
        assert.equal(s('t1').activeTurn.id, 'pending-second');
        execs[1].done({ started: true, turnId: 'second-turn' });
      } else {
        execs[1].done({ started: true, turnId: 'second-turn' });
        assert.equal((await newer).status, 'sent');
        execs[0].done({ started: accepted, error: accepted ? undefined : 'old refused' });
      }
      assert.equal((await old).status, accepted ? 'sent' : 'queued');
      assert.equal((await newer).status, 'sent');
      assert.equal(s('t1').activeTurn.id, 'second-turn');
      assert.deepEqual(s('t1').queue, accepted ? [] : [first]);
    });
  }
}
