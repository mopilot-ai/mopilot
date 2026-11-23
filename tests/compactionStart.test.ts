// Independent production-entrypoint adversarial checks for compaction ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tick } from './support/controller/fixture';
import { waitFor } from './support/waitFor.ts';
const { assertInputCurrent } = createRequire(import.meta.url)('../electron/session/contract/inputGuard.cjs');
const input = (id: string) => ({ id, text: id, attachments: [], opts: { human: true }, followUp: 'steer' });
const status = (c: any, s: any) =>
  c.onClaudeEvent({ key: 'claude:s1', kind: 'message', msg: { type: 'system', subtype: 'status', session_id: 's1', ...s } });

test('idle Claude compaction beginning during turn-start preflight holds the original input at transport', async () => {
  const { c, s, execs } = setup({ auto: false });
  let resume!: () => void;
  c.beforeDispatch = () =>
    new Promise<void>((resolve) => {
      resume = resolve;
    });
  const start = c.claudeTurns.startTurn;
  c.claudeTurns.startTurn = (...args: any[]) => {
    assertInputCurrent(args[2]);
    return start(...args);
  };
  const receipt = c.send('claude:s1', input('idle-start'), 1, true);
  status(c, { status: 'compacting' });
  resume();
  await tick();
  // Settle any accidental dispatch to avoid leaving a pending operation in the test.
  if (execs[0]) execs[0].done({ started: true });
  const result = await receipt;
  assert.equal(execs.length, 0, 'no turn-start transport call may enter an active compaction');
  assert.deepEqual(result, { action: 'queued', id: 'idle-start' });
  assert.equal(s('claude:s1').queue[0].waitingFor, 'compaction');
});

test('real ClaudeAdapter holds a new turn when idle native compaction starts during setModel', async () => {
  const { ClaudeAdapter } = createRequire(import.meta.url)('../electron/harness/claude/adapter.cjs');
  const { c, state, s, claudeSends } = setup();
  const chat = 'claude:s1';
  let release!: () => void;
  const events: any[] = [];
  const api = {
    isLive: () => true,
    control: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    sessionCwd: () => '/w',
    accounts: () => ({ active: 'default', accounts: [{ id: 'default', loggedIn: true }] }),
    metered: () => false,
  };
  const adapter = new ClaudeAdapter({
    api,
    state,
    prefs: () => ({ permission: 'default' }),
    send: (...args: any[]) => c.claudeSend(...args),
    enqueue: () => undefined,
    chatOf: (key: string) => c.chatOf(key),
    ref: (id: string) => c.ref(id),
    emit: (e: any) => (events.push(e), true),
    setGoal: () => false,
  });
  c.claudeTurns = adapter;
  adapter.live.set(chat, { ...adapter.settings(chat, {}), model: 'old-model' });
  const receipt = c.send(chat, input('native-start'), 1, true);
  await waitFor(() => release, 'the native send to start');
  assert.equal(typeof release, 'function');
  status(c, { status: 'compacting' });
  release();
  const result = await receipt;
  assert.equal(claudeSends.length, 0, 'real adapter must not send a new prompt while native compaction is active');
  assert.deepEqual(result, { action: 'queued', id: 'native-start' });
  assert.equal(s(chat).queue[0].waitingFor, 'compaction');
});

for (const ending of ['success', 'failure', 'stop', 'switch'])
  test(`a suspended idle start preserves one input through ${ending}`, async () => {
    const { c, execs, s, chats } = setup({ auto: false });
    const chat = 'claude:s1';
    let resume!: () => void;
    c.beforeDispatch = () =>
      new Promise<void>((r) => {
        resume = r;
      });
    const start = c.claudeTurns.startTurn;
    c.claudeTurns.startTurn = (...args: any[]) => {
      assertInputCurrent(args[2]);
      return start(...args);
    };
    const receipt = c.send(chat, { ...input('held'), opts: { human: true, effort: 'high' } }, 9, true);
    status(c, { status: 'compacting' });
    resume();
    assert.deepEqual(await receipt, { action: 'queued', id: 'held' });
    c.beforeDispatch = null;
    assert.equal(s(chat).turn, 'idle');
    assert.equal(s(chat).crashed, null);
    assert.equal(execs.length, 0);
    if (ending === 'stop') c.noteStop(chat);
    else if (ending === 'failure') status(c, { status: null, compact_result: 'failed' });
    else if (ending === 'switch') {
      const { selectSegment } = await import('./support/controller/fixture');
      selectSegment(c, chats, chat, [
        ['claude', 's1'],
        ['acp:qwen', 'new'],
      ]);
    }
    status(c, { status: null, compact_result: 'success' });
    await tick();
    if (ending !== 'success') {
      assert.equal(execs.length, 0);
      assert.equal(s(chat).queue[0].waitingFor, 'compactionRetry');
      const retry = c.sendNow(chat, 'held', null, true);
      execs[0].done({ started: true });
      assert.deepEqual(await retry, { status: 'sent' });
    } else {
      assert.equal(execs.length, 1);
      assert.equal(execs[0].item.origin, 9);
      assert.equal(execs[0].item.opts.effort, 'high');
      execs[0].done({ started: true });
      await tick();
    }
    assert.equal(s(chat).queue.length, 0);
  });

for (const outcome of ['complete', 'failed', 'stop', 'replacement'])
  test(`late start guard settlement after compaction ${outcome} preserves ownership`, async () => {
    const { c, execs, s } = setup({ auto: false });
    const chat = 'claude:s1';
    let resume!: () => void;
    let settle!: () => void;
    c.beforeDispatch = () =>
      new Promise<void>((r) => {
        resume = r;
      });
    c.onDispatchResult = () =>
      new Promise<void>((r) => {
        settle = r;
      });
    const start = c.claudeTurns.startTurn;
    c.claudeTurns.startTurn = (...args: any[]) => {
      assertInputCurrent(args[2]);
      return start(...args);
    };
    const receipt = c.send(chat, input('held'), 1, true);
    status(c, { status: 'compacting' });
    resume();
    await tick();
    c.beforeDispatch = null;
    c.onDispatchResult = null;
    if (outcome === 'stop') {
      c.noteStop(chat);
      c.end(chat, { drain: false });
    } else if (outcome === 'replacement') {
      c.end(chat, { drain: false });
      c.send(chat, input('replacement'), 1);
    } else status(c, { status: null, compact_result: outcome === 'complete' ? 'success' : 'failed' });
    settle();
    assert.deepEqual(await receipt, { action: 'queued', id: 'held' });
    await tick();
    if (outcome === 'complete') {
      assert.equal(execs.length, 1);
      assert.equal(execs[0].item.id, 'held');
      execs[0].done({ started: true });
      await tick();
      assert.equal(s(chat).queue.length, 0);
    } else {
      assert.equal(s(chat).queue.find((q: any) => q.id === 'held').waitingFor, 'compactionRetry');
      assert.equal(execs.length, outcome === 'replacement' ? 1 : 0);
      if (outcome === 'replacement') {
        execs[0].done({ started: true });
        await tick();
      }
    }
  });

test('same-process per-turn Claude init does not retire the remaining serialized compaction release', async () => {
  const { c, s, execs } = setup({ auto: false });
  const chat = 'claude:s1';
  c.send(chat, input('first'), 1);
  execs[0].done({ started: true });
  await tick();
  status(c, { status: 'compacting' });
  c.send(chat, input('held-one'), 1);
  c.send(chat, input('held-two'), 1);
  status(c, { status: null, compact_result: 'success' });
  assert.equal(execs.length, 2);
  c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'system', subtype: 'init', session_id: 's1' } });
  execs[1].done({ started: true });
  await tick();
  if (execs[2]) {
    execs[2].done({ started: true });
    await tick();
  }
  assert.equal(execs.length, 3, 'SDK init is per-turn metadata, not proof of a process replacement');
  assert.equal(s(chat).queue.length, 0);
});

test('Claude conversation_reset retires the old hold before a late same-process boundary', async () => {
  const { c, s, execs } = setup({ auto: false });
  const chat = 'claude:s1';
  c.send(chat, input('first'), 1);
  execs[0].done({ started: true });
  await tick();
  status(c, { status: 'compacting' });
  c.send(chat, input('held'), 1);
  c.onClaudeEvent({
    key: chat,
    kind: 'message',
    msg: { type: 'conversation_reset', session_id: 's1', new_conversation_id: 'new-conversation', uuid: 'reset-1', trigger: 'clear' },
  });
  c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'system', subtype: 'compact_boundary', session_id: 's1' } });
  await tick();
  if (execs[1]) {
    execs[1].done({ started: true });
    await tick();
  }
  assert.equal(execs.length, 1, 'the reset must invalidate automatic release into the discarded conversation');
  assert.equal(s(chat).queue[0].waitingFor, 'compactionRetry');
});
