// Initial send receipts retain one retry owner when a Codex provider cannot read its thread history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup as controller, tick, selectSegment } from './support/controller/fixture.ts';
import { setup as codex } from './support/codex-harness/fixture.ts';

const failure = 'list_turns is not supported yet';
const prompt = { text: 'Keep my input', attachments: [{ kind: 'file', path: '/work/a', name: 'a' }], opts: { human: true, plan: true } };

test('unsupported history returns the cause, never starts a provider turn, and stays queued once', async () => {
  const native = codex({
    'thread/resume': () => {
      throw new Error(failure);
    },
  });
  const { c, state } = controller();
  c.codex = native.a;
  const receipt = await c.send('t1', prompt, 7, true);
  assert.equal(receipt.action, 'queued');
  assert.equal(receipt.error, failure);
  assert.equal(state.get('t1').turn, 'crashed');
  assert.equal(state.get('t1').crashed, failure);
  assert.deepEqual(
    state.get('t1').queue.map(({ text, attachments, opts }: any) => ({ text, attachments, opts })),
    [prompt],
  );
  assert.equal(native.server.params('turn/start').length, 0);
  assert.equal(native.server.params('thread/resume').length, 1);
  await tick();
  assert.equal(native.server.params('thread/resume').length, 1, 'failure cannot trigger a provider retry');
});

test('the awaited receipt stays pending until native acceptance and another input queues independently', async () => {
  const { c, execs, s } = controller({ auto: false });
  let settled = false;
  const first = Promise.resolve(c.send('t1', prompt, 7, true)).then((r) => {
    settled = true;
    return r;
  });
  await tick();
  assert.equal(settled, false);
  assert.equal((await c.send('t1', { text: 'second' }, 8, true)).action, 'queued');
  execs[0].done({ started: true, turnId: 'turn-1' });
  const accepted = await first;
  assert.equal(accepted.action, 'started');
  assert.equal(accepted.error, undefined);
  assert.deepEqual(
    s('t1').queue.map((q: any) => q.text),
    ['second'],
  );
});

test('all harness failures keep the full retry context without claiming started', async () => {
  for (const family of ['codex', 'claude', 'acp:qwen']) {
    const { c, chats, execs, s } = controller({ auto: false });
    selectSegment(c, chats, 'chat', [[family, 'native-id']]);
    const receipt = Promise.resolve(c.send('chat', prompt, 7, true));
    execs[0].done({ started: false, error: 'provider unavailable' });
    assert.equal((await receipt).action, 'queued');
    assert.equal(s('chat').crashed, 'provider unavailable');
    assert.equal(s('chat').queue.length, 1);
    assert.deepEqual(s('chat').queue[0].opts, prompt.opts);
  }
});

test('a queued failure retries once with the same options and clears the visible failure', async () => {
  const { c, execs, s } = controller({ auto: false });
  const receipt = Promise.resolve(c.send('t1', prompt, 7, true));
  const original = execs[0].item;
  execs[0].done({ started: false, error: failure });
  const failed = await receipt;
  const retry = c.sendNow('t1', failed.id, 7, true);
  await tick();
  assert.deepEqual(execs[1].item, original);
  execs[1].done({ started: true, turnId: 'retry-turn' });
  assert.deepEqual(await retry, { status: 'sent' });
  assert.equal(s('t1').crashed, null);
  assert.equal(s('t1').queue.length, 0);
  assert.equal(execs.length, 2);
});

test('held and discarded input have an explicit owner instead of a second queued copy', async () => {
  for (const [result, action] of [
    [{ started: false, held: true }, 'held'],
    [{ started: false, discarded: true }, 'discarded'],
  ] as const) {
    const { c, execs, s } = controller({ auto: false });
    const receipt = Promise.resolve(c.send('t1', prompt, 7, true));
    execs[0].done(result);
    assert.equal((await receipt).action, action);
    assert.equal(s('t1').queue.length, 0);
    assert.equal(s('t1').crashed, null);
  }
});

test('a switch-prepared prefix and note survive a failed initial attempt in the sole retry owner', async () => {
  const { c, state, execs, s } = controller({ auto: false });
  state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto' } });
  const receipt = Promise.resolve(c.send('t1', prompt, 7, true));
  const note = { kind: 'switch', text: 'changed harness' };
  execs[0].done({ ready: true, prefix: '<handoff>Keep this</handoff>', note });
  await tick();
  execs[1].done({ started: false, error: failure });
  assert.equal((await receipt).action, 'queued');
  assert.equal(s('t1').queue.length, 1);
  assert.deepEqual(s('t1').queue[0].opts, { ...prompt.opts, prefix: '<handoff>Keep this</handoff>', note });
});

test('a switch’s prefix goes before one the message already carries, and is not added twice to a message that holds it', async () => {
  for (const [carried, prefix] of [
    ['ISSUE', '<handoff>Keep this</handoff>\n\nISSUE'],
    ['<handoff>Keep this</handoff>\n\nISSUE', '<handoff>Keep this</handoff>\n\nISSUE'],
  ]) {
    const { c, state, execs, s } = controller({ auto: false });
    state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto' } });
    const receipt = Promise.resolve(c.send('t1', { ...prompt, opts: { ...prompt.opts, prefix: carried } }, 7, true));
    execs[0].done({ ready: true, prefix: '<handoff>Keep this</handoff>' });
    await tick();
    execs[1].done({ started: false, error: failure });
    assert.equal((await receipt).action, 'queued');
    assert.equal(s('t1').queue[0].opts.prefix, prefix);
  }
});

test('a retired failed attempt cannot overwrite a replacement turn or its pending receipt', async () => {
  const { c, execs, s } = controller({ auto: false });
  const old = Promise.resolve(c.send('t1', prompt, 7, true));
  c.end('t1', { drain: false });
  const replacement = Promise.resolve(c.send('t1', { text: 'replacement', opts: {} }, 7, true));
  execs[0].done({ started: false, error: 'stale failure' });
  assert.equal((await old).action, 'queued');
  assert.equal(s('t1').turn, 'running');
  assert.equal(s('t1').crashed, null);
  execs[1].done({ started: true, turnId: 'replacement-turn' });
  assert.equal((await replacement).action, 'started');
  assert.equal(s('t1').activeTurn.id, 'replacement-turn');
});

test('a completion hook starting a replacement cannot be overwritten by the old failure', async () => {
  const { c, execs, s } = controller({ auto: false });
  const old = Promise.resolve(c.send('t1', prompt, 7, true));
  let replacement: any;
  c.onFinished = () => {
    replacement = c.send('t1', { text: 'new work' }, 8, true);
  };
  execs[0].done({ started: false, error: 'old failure' });
  assert.equal((await old).action, 'queued');
  assert.equal(s('t1').crashed, null);
  assert.equal(s('t1').turn, 'running');
  execs[1].done({ started: true, turnId: 'next' });
  assert.equal((await replacement).action, 'started');
});

test('an accepted native send stays accepted if its post-dispatch journal hook fails', async () => {
  const { c, s } = controller();
  c.onDispatchResult = async () => {
    throw new Error('journal unavailable');
  };
  const receipt = await c.send('t1', prompt, 7, true);
  assert.equal(receipt.action, 'started');
  assert.equal(s('t1').queue.length, 0);
  assert.equal(s('t1').crashed, null);
});

test('awaited steer failure keeps its input queued and never claims delivery', async () => {
  const { c, execs, s } = controller({ auto: false });
  c.send('t1', { text: 'running' }, 1);
  execs[0].done({ started: true, turnId: 'live' });
  await tick();
  const rejected = Promise.resolve(c.send('t1', { text: 'nudge', followUp: 'steer' }, 7, true));
  execs[1].done({ started: false, error: 'steer refused' });
  const receipt = await rejected;
  assert.equal(receipt.action, 'queued');
  assert.equal(receipt.error, 'steer refused');
  assert.deepEqual(
    s('t1').queue.map((q: any) => q.text),
    ['nudge'],
  );
  assert.equal(s('t1').activeTurn.id, 'live');
  const accepted = Promise.resolve(c.send('t1', { text: 'accepted nudge', followUp: 'steer' }, 7, true));
  execs[2].done({ started: true });
  assert.equal((await accepted).action, 'steered');
});

test('discarded command drains an independent queued message without restoring the obsolete command', async () => {
  const { c, state, s } = controller();
  const calls: string[] = [];
  c.start = async (_chat: string, item: any) => {
    calls.push(item.id);
    return item.id === 'obsolete' ? { started: false, discarded: true } : { started: true };
  };
  state.patch('t1', { queue: [{ id: 'later', text: 'independent', opts: {} }] });
  assert.equal((await c.startOrKeep('t1', { id: 'obsolete', text: 'old', opts: {} })).discarded, true);
  await tick();
  assert.deepEqual(calls, ['obsolete', 'later']);
  assert.equal(s('t1').queue.length, 0);
});
