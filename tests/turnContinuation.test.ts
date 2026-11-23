// Account continuations join real controller completion with account success and retire on every competing chat owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tick, codex, selectSegment } from './support/controller/fixture.ts';
const require = createRequire(import.meta.url);
const { TurnContinuations } = require('../electron/session/turnContinuation.cjs');
const { assertInputCurrent } = require('../electron/session/contract/inputGuard.cjs');
const { acquireFolderMutation } = require('../electron/session/folderMutation.cjs');

async function current() {
  const h = setup();
  selectSegment(h.c, h.chats, 'stable-chat', [
    ['codex', 'stable-chat'],
    ['codex', 'native-thread'],
  ]);
  h.c.send('stable-chat', { text: 'limited', opts: { human: true } }, null);
  await tick();
  h.c.onCodexMessage(codex('turn/started', { threadId: 'native-thread', turn: { id: 'limited-turn' } }));
  const abort = new AbortController();
  const continuations = new TurnContinuations(h.c, abort.signal);
  const prepare = () => continuations.prepare('native-thread', 'limited-turn');
  const finish = () =>
    h.c.onCodexMessage(
      codex('turn/completed', {
        threadId: 'native-thread',
        turn: { id: 'limited-turn', status: 'failed' },
      }),
    );
  return { ...h, abort, continuations, prepare, finish };
}

test('account continuation starts after a folder merge without losing its start ownership', async () => {
  const h = await current();
  const moved = h.prepare();
  h.finish();
  const release = acquireFolderMutation(h.c, 'stable-chat');
  assert.ok(release);
  moved();
  await tick();
  assert.equal(h.execs.length, 1);
  release();
  await tick();
  assert.equal(h.execs.length, 2);
  assert.equal(h.execs[1].item.text, 'Continue where you left off.');
  assert.doesNotThrow(() => assertInputCurrent(h.execs[1].item));
});

for (const order of ['move-first', 'completion-first']) {
  test(`a moved account continues once with no window and ${order}`, async (t) => {
    const h = await current();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const moved = h.prepare();
    if (order === 'move-first') moved();
    t.mock.timers.tick(30_000);
    assert.equal(h.execs.length, 1, 'elapsed time never substitutes for actual completion');
    h.finish();
    if (order === 'completion-first') {
      await tick();
      assert.equal(h.execs.length, 1, 'completion never substitutes for successful account movement');
      moved();
    }
    await tick();
    assert.equal(h.execs.length, 2);
    assert.equal(h.execs[1].chatId, 'stable-chat');
    assert.equal(h.execs[1].ref.key, 'native-thread');
    assert.equal(h.execs[1].item.text, 'Continue where you left off.');
    assert.equal(h.execs[1].origin, null);
    moved();
    await tick();
    assert.equal(h.execs.length, 2, 'a duplicate account completion cannot send twice');
    assert.equal(h.continuations.pending.size, 0);
  });
}

test('user input queued during cleanup takes priority and no automatic extra turn follows it', async () => {
  const h = await current();
  const moved = h.prepare();
  moved();
  h.c.send('stable-chat', { text: 'my next request' }, null);
  h.finish();
  await tick();
  assert.equal(h.execs.length, 2);
  assert.equal(h.execs[1].item.text, 'my next request');
  assert.equal(h.s('stable-chat').queue.length, 0);
});

test('a newer preparation retires only the old automatic callback and a later valid attempt still works', async () => {
  const h = await current();
  const old = h.prepare();
  const moved = h.prepare();
  old();
  h.finish();
  await tick();
  assert.equal(h.execs.length, 1);
  moved();
  await tick();
  assert.equal(h.execs.length, 2);
});

for (const invalid of ['aborted', 'no-turn', 'wrong-source', 'wrong-turn', 'no-active-turn']) {
  test(`invalid ${invalid} preparation cannot start anything`, async () => {
    const h = await current();
    if (invalid === 'aborted') h.abort.abort();
    if (invalid === 'wrong-source') selectSegment(h.c, h.chats, 'stable-chat', [['claude', 'claude-thread']]);
    if (invalid === 'no-active-turn') h.state.patch('stable-chat', { activeTurn: null });
    const moved = h.continuations.prepare(
      'native-thread',
      invalid === 'no-turn' ? undefined : invalid === 'wrong-turn' ? 'another-turn' : 'limited-turn',
    );
    moved();
    h.finish();
    await tick();
    assert.equal(h.execs.length, 1);
    assert.equal(h.continuations.pending.size, 0);
  });
}

for (const event of ['onCrash', 'onInterrupt']) {
  test(`${event} retires pending continuation ownership`, async () => {
    const h = await current();
    const moved = h.prepare();
    h.c[event]('stable-chat');
    assert.equal(h.continuations.pending.size, 0);
    moved();
    h.finish();
    await tick();
    assert.equal(h.execs.length, 1);
  });
}

test('a mismatched or unrelated completion does not release the prepared turn', async () => {
  const h = await current();
  const moved = h.prepare();
  moved();
  h.c.onFinished({ chatId: 'unrelated', turnId: 'limited-turn' });
  h.c.onFinished({ chatId: 'stable-chat', turnId: 'obsolete-turn' });
  h.finish();
  await tick();
  assert.equal(h.execs.length, 1);
});

for (const change of ['new-turn', 'stop', 'switch', 'delete', 'runtime', 'busy', 'queue', 'pending-switch', 'abort']) {
  test(`a ${change} between completion and account success retires the automatic turn`, async () => {
    const h = await current();
    const moved = h.prepare();
    h.finish();
    await tick();
    const before = h.execs.length;
    switch (change) {
      case 'new-turn':
        h.c.send('stable-chat', { text: 'replacement' }, null);
        await tick();
        break;
      case 'stop':
        h.c.noteStop('stable-chat');
        break;
      case 'switch':
        selectSegment(h.c, h.chats, 'stable-chat', [['claude', 'claude-thread']]);
        break;
      case 'delete':
        h.chats.records.delete('stable-chat');
        break;
      case 'runtime':
        h.c.rts.delete('stable-chat');
        break;
      case 'busy':
        h.state.patch('stable-chat', { turn: 'running' });
        break;
      case 'queue':
        h.state.patch('stable-chat', { queue: [{ id: 'waiting', text: 'kept', opts: {} }] });
        break;
      case 'pending-switch':
        h.state.patch('stable-chat', { pendingSwitch: { to: 'claude' } });
        break;
      case 'abort':
        h.abort.abort();
        break;
    }
    moved();
    await tick();
    assert.equal(h.execs.length, before + (change === 'new-turn' ? 1 : 0));
  });
}

test('abort clears pending ownership and native dispatch checks its current segment after later awaits', async () => {
  const h = await current();
  const moved = h.prepare();
  moved();
  h.finish();
  await tick();
  const input = h.execs[1].item;
  assert.doesNotThrow(() => assertInputCurrent(input));
  selectSegment(h.c, h.chats, 'stable-chat', [['acp:gemini', 'other-thread']]);
  assert.throws(() => assertInputCurrent(input), /automatic input was paused/);
  const pending = await current();
  pending.prepare();
  assert.equal(pending.continuations.pending.size, 1);
  pending.abort.abort();
  assert.equal(pending.continuations.pending.size, 0);
});

test('a newer native turn that starts and completes also retires the old move', async () => {
  const h = await current();
  const moved = h.prepare();
  h.finish();
  h.c.onCodexMessage(codex('turn/started', { threadId: 'native-thread', turn: { id: 'native-next' } }));
  h.c.onCodexMessage(codex('turn/completed', { threadId: 'native-thread', turn: { id: 'native-next', status: 'completed' } }));
  moved();
  await tick();
  assert.equal(h.execs.length, 1, 'native turns retire continuation ownership just like local turns');
});

test('Stop while the automatic native start waits cancels it without queuing or replaying its synthetic input', async () => {
  const h = await current();
  let settle!: () => void;
  const wait = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const nativeInputs: string[] = [];
  h.c.codex.startTurn = async (_chat: string, _ref: unknown, input: any) => {
    await wait;
    try {
      assertInputCurrent(input);
      nativeInputs.push(input.text);
      return { started: true };
    } catch (error) {
      return { started: false, error: String(error) };
    }
  };
  h.prepare()();
  h.finish();
  await tick();
  h.c.noteStop('stable-chat');
  h.c.end('stable-chat', { drain: false });
  settle();
  await tick();
  assert.deepEqual(h.s('stable-chat').queue, [], 'cancelled automatic input is never retained as a human draft');
  h.c.send('stable-chat', { text: 'new human request' }, null);
  await tick();
  h.c.onCodexMessage(codex('turn/started', { threadId: 'native-thread', turn: { id: 'human-next' } }));
  h.c.onCodexMessage(codex('turn/completed', { threadId: 'native-thread', turn: { id: 'human-next', status: 'completed' } }));
  await tick();
  assert.deepEqual(nativeInputs, ['new human request']);
});

test('production deletion tombstones retire a move while retaining its canonical record and native aliases', async () => {
  const h = await current();
  const moved = h.prepare();
  h.finish();
  const { ChatDeletion } = require('../electron/session/chatDeletion.cjs');
  const deletion = new ChatDeletion({ store: h.chats, remove: { codex: async () => {} }, broadcast: () => {} });
  await deletion.delete('stable-chat');
  assert.equal(h.chats.records.has('stable-chat'), true);
  assert.equal(h.chats.isDeleted('stable-chat'), true);
  assert.equal(h.chats.isDeleted('native-thread'), true);
  moved();
  await tick();
  assert.equal(h.execs.length, 1);
});

test('an unaccepted automatic start reports a usable retry without retaining synthetic input', async () => {
  const h = await current();
  h.c.codex.startTurn = async () => ({ started: false });
  h.prepare()();
  h.finish();
  await tick();
  assert.equal(h.s('stable-chat').turn, 'crashed');
  assert.match(h.s('stable-chat').crashed, /Send a message to try again/);
  assert.deepEqual(h.s('stable-chat').queue, []);
  h.c.codex.startTurn = async () => ({ started: true });
  h.c.send('stable-chat', { text: 'retry myself' }, null);
  await tick();
  assert.equal(h.s('stable-chat').turn, 'running');
});

for (const retirement of ['crash', 'end', 'delete']) {
  test(`${retirement} while native preparation waits blocks its guarded dispatch`, async () => {
    const h = await current();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let accepted = false;
    h.c.codex.startTurn = async (_chat: string, _ref: unknown, input: any) => {
      await gate;
      try {
        assertInputCurrent(input);
        accepted = true;
        return { started: true };
      } catch (error) {
        return { started: false, error: String(error) };
      }
    };
    h.prepare()();
    h.finish();
    await tick();
    if (retirement === 'crash') h.c.crash('stable-chat', 'native process left');
    else if (retirement === 'end') h.c.end('stable-chat', { drain: false });
    else {
      const { ChatDeletion } = require('../electron/session/chatDeletion.cjs');
      await new ChatDeletion({ store: h.chats, remove: { codex: async () => {} }, broadcast: () => {} }).delete('stable-chat');
    }
    finish();
    await tick();
    assert.equal(accepted, false);
    assert.deepEqual(h.s('stable-chat').queue, []);
  });
}

test('an unavailable harness keeps its refusal visible without retaining the automatic item', async () => {
  const h = await current();
  h.c.killed = () => 'temporarily unavailable';
  h.prepare()();
  h.finish();
  await tick();
  assert.equal(h.s('stable-chat').crashed, 'temporarily unavailable');
  assert.deepEqual(h.s('stable-chat').queue, []);
});

test('native compaction during automatic preparation does not keep a synthetic draft, while human input stays retryable', async () => {
  const h = await current();
  const { observeCompaction } = require('../electron/session/compactionQueue.cjs');
  h.c.codex.startTurn = async (_chat: string, _ref: unknown, input: any) => {
    observeCompaction(h.c, { source: { kind: 'codex', key: 'native-thread' }, phase: 'active', id: 'cleanup' });
    try {
      assertInputCurrent(input);
      assert.fail('compaction must hold the native dispatch');
    } catch (error) {
      return { started: false, error: String(error) };
    }
  };
  h.prepare()();
  h.finish();
  await tick();
  assert.deepEqual(h.s('stable-chat').queue, []);
  assert.equal(h.c.rt('stable-chat').compactionInputs?.size ?? 0, 0);
  assert.match(h.s('stable-chat').crashed, /Send a message to try again/);
  h.c.send('stable-chat', { text: 'human input during compaction' }, null);
  await tick();
  assert.deepEqual(
    h.s('stable-chat').queue.map((q: any) => q.text),
    ['human input during compaction'],
  );
});

for (const order of ['before-refusal', 'after-refusal']) {
  test(`compaction completing ${order} cannot retry or requeue automatic input after its refusal settles`, async () => {
    const h = await current();
    const { observeCompaction } = require('../electron/session/compactionQueue.cjs');
    let acknowledge!: () => void;
    let retry!: () => void;
    const ack = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const retryWait = new Promise<void>((resolve) => {
      retry = resolve;
    });
    let attempts = 0;
    h.c.codex.startTurn = async (_chat: string, _ref: unknown, input: any) => {
      attempts++;
      if (attempts === 1) observeCompaction(h.c, { source: { kind: 'codex', key: 'native-thread' }, phase: 'active', id: 'ordered' });
      else await retryWait;
      try {
        assertInputCurrent(input);
        return { started: true };
      } catch (error) {
        return { started: false, error: String(error) };
      }
    };
    h.c.onDispatchResult = async () => {
      if (attempts === 1) await ack;
    };
    h.prepare()();
    h.finish();
    await tick();
    const complete = () => observeCompaction(h.c, { source: { kind: 'codex', key: 'native-thread' }, phase: 'complete', id: 'ordered' });
    if (order === 'before-refusal') complete();
    acknowledge();
    await tick();
    if (order === 'after-refusal') complete();
    retry();
    await tick();
    await tick();
    assert.equal(attempts, 1, 'automatic input has no hidden compaction retry');
    assert.deepEqual(h.s('stable-chat').queue, []);
  });
}
