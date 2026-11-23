// Read-only issue 1366 reproduction: current compaction notifications do not hold steers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tick, codex, selectSegment } from './support/controller/fixture';

const require = createRequire(import.meta.url);
const { assertInputCurrent } = require('../electron/session/contract/inputGuard.cjs');

const input = (id: string, followUp = 'steer') => ({
  id,
  text: `input ${id}`,
  attachments: [{ kind: 'image', name: 'diagram.png', path: '/tmp/diagram.png' }],
  opts: { human: true, model: 'chosen-model', effort: 'high', prefix: 'prepared prefix', note: { kind: 'handoff', text: 'prepared note' } },
  followUp,
});
function signal(c: any, chat: string, phase: 'active' | 'complete' | 'failed', id = 'compact-1', turnId = 'turn-1') {
  if (chat === 't1') {
    if (phase === 'failed') c.onCodexMessage(codex('turn/completed', { threadId: chat, turn: { id: turnId, status: 'failed' } }));
    else
      c.onCodexMessage(
        codex(phase === 'active' ? 'item/started' : 'item/completed', {
          threadId: chat,
          turnId,
          item: { type: 'contextCompaction', id },
        }),
      );
  } else
    c.onClaudeEvent({
      key: chat,
      kind: 'message',
      msg: {
        type: 'system',
        subtype: 'status',
        status: phase === 'active' ? 'compacting' : null,
        ...(phase !== 'active' ? { compact_result: phase === 'complete' ? 'success' : 'failed' } : {}),
        uuid: `${id}-${phase}`,
        session_id: 's1',
      },
    });
}
async function running(chat = 't1') {
  const f = setup({ auto: false });
  f.c.send(chat, { text: 'first', opts: { human: true } }, 1);
  f.execs[0].done({ started: true, turnId: 'turn-1' });
  await tick();
  // Production adapters recheck private input guards immediately before transport.
  for (const adapter of [f.c.codex, f.c.claudeTurns]) {
    const steer = adapter.steer;
    adapter.steer = (...args: any[]) => {
      assertInputCurrent(args[2]);
      return steer(...args);
    };
  }
  return f;
}

for (const chat of ['t1', 'claude:s1']) {
  test(`${chat}: compaction keeps a steer editable until completion`, async () => {
    const { c, execs, s } = setup({ auto: false });
    c.send(chat, { text: 'first', opts: { human: true } }, 1);
    execs[0].done({ started: true, turnId: 'turn-1' });
    await tick();
    if (chat === 't1') {
      c.onCodexMessage(
        codex('item/started', {
          threadId: chat,
          turnId: 'turn-1',
          item: { type: 'contextCompaction', id: 'compact-1' },
        }),
      );
    } else {
      c.onClaudeEvent({
        key: chat,
        kind: 'message',
        msg: {
          type: 'system',
          subtype: 'status',
          status: 'compacting',
          uuid: 'status-1',
          session_id: 's1',
        },
      });
    }
    const input = {
      id: 'steer-during-compact',
      text: 'keep this exact input',
      attachments: [{ name: 'diagram.png', path: '/tmp/diagram.png' }],
      opts: { human: true, model: 'chosen-model', effort: 'high' },
      followUp: 'steer',
    };
    const result = c.send(chat, input, 2);
    assert.equal(result.action, 'queued');
    assert.equal(execs.length, 1);
    const [held] = s(chat).queue;
    assert.equal(held.id, input.id);
    assert.equal(held.text, input.text);
    assert.deepEqual(held.attachments, input.attachments);
    assert.deepEqual(held.opts, input.opts);
    assert.equal(c.removeQueued(chat, held.id).id, input.id);
    assert.equal(s(chat).queue.length, 0);
  });
}

test('ACP without a compaction signal keeps its existing next-turn queue behavior', async () => {
  const { c, execs, s } = setup({ auto: false });
  const chat = 'acp:qwen:session-1';
  c.send(chat, { text: 'first', opts: {} }, 1);
  execs[0].done({ started: true, turnId: 'turn-1' });
  await tick();
  const result = c.send(chat, { text: 'follow up', opts: {}, followUp: 'steer' }, 1);
  assert.equal(result.action, 'queued');
  assert.equal(s(chat).queue.length, 1);
  assert.equal(execs.length, 1);
});

test('successful compaction releases only held steers once, preserving editable input and ordinary queue order', async () => {
  for (const chat of ['t1', 'claude:s1']) {
    const { c, execs, s } = await running(chat);
    c.send(chat, input('ordinary', 'queue'), 1);
    signal(c, chat, 'active');
    const one = input('one');
    assert.deepEqual(await c.send(chat, one, 2, true), { action: 'queued', id: one.id });
    c.send(chat, input('edited'), 3);
    signal(c, chat, 'active');
    assert.equal(s(chat).compaction, 'active');
    signal(c, chat, 'complete');
    signal(c, chat, 'complete');
    assert.equal(execs.length, 2);
    assert.equal(execs[1].item.id, one.id);
    assert.equal(execs[1].item.text, one.text);
    assert.deepEqual(execs[1].item.attachments, one.attachments);
    assert.deepEqual(execs[1].item.opts, one.opts);
    assert.equal(execs[1].origin, 2);
    const edited = c.removeQueued(chat, 'edited');
    assert.equal(edited.waitingFor, undefined);
    assert.equal(edited.text, 'input edited');
    execs[1].done({ started: true });
    await tick();
    assert.equal(execs.length, 2);
    assert.deepEqual(
      s(chat).queue.map((q: any) => q.id),
      ['ordinary'],
    );
    c.end(chat);
    assert.equal(execs.length, 3);
    assert.equal(execs[2].item.id, 'ordinary');
    execs[2].done({ started: true, turnId: 'turn-2' });
    await tick();
  }
});

test('queued Send now holds without removing its row and concurrent clicks cannot dispatch it twice', async () => {
  for (const chat of ['t1', 'claude:s1']) {
    const { c, execs, s } = await running(chat);
    c.send(chat, input('queued', 'queue'), 1);
    signal(c, chat, 'active');
    assert.equal(c.sendNow(chat, 'queued', 1), true);
    assert.deepEqual(await c.sendNow(chat, 'queued', 1, true), { status: 'queued', waitingFor: 'compaction' });
    assert.equal(s(chat).queue.length, 1);
    signal(c, chat, 'complete');
    assert.equal(c.sendNow(chat, 'queued', 1), false);
    assert.equal(execs.length, 2);
    execs[1].done({ started: true });
    await tick();
    assert.equal(s(chat).queue.length, 0);
  }
});

test('failed or stopped compaction preserves each input for explicit retry across later unrelated completions', async () => {
  for (const chat of ['t1', 'claude:s1'])
    for (const exit of ['failed', 'stop', 'crash']) {
      const { c, execs, s } = await running(chat);
      signal(c, chat, 'active');
      c.send(chat, input('keep'), 7);
      if (exit === 'failed') signal(c, chat, 'failed');
      else if (exit === 'stop') {
        c.noteStop(chat);
        c.end(chat, { drain: false });
      } else if (chat === 't1') c.onCodexExit();
      else c.onClaudeEvent({ key: chat, kind: 'closed' });
      signal(c, chat, 'complete');
      c.end(chat);
      await tick();
      assert.equal(execs.length, 1, `${chat} ${exit}`);
      assert.equal(s(chat).queue.length, 1);
      assert.equal(s(chat).queue[0].waitingFor, 'compactionRetry');
      const receipt = c.sendNow(chat, 'keep', null, true);
      assert.equal(execs.length, 2);
      assert.equal(execs[1].item.waitingFor, undefined);
      assert.deepEqual(execs[1].item.opts, input('keep').opts);
      execs[1].done({ started: true, turnId: 'retry-turn' });
      assert.deepEqual(await receipt, { status: 'sent' });
      assert.equal(s(chat).queue.length, 0);
    }
});

test('idle Claude auto-compaction queues input and starts exactly one next turn after a boundary', async () => {
  const { c, execs, s, chats } = setup({ auto: false });
  const chat = 'stable-id/quote"';
  selectSegment(c, chats, chat, [['claude', 's1']]);
  c.onClaudeEvent({
    key: 'claude:s1',
    kind: 'message',
    msg: { type: 'system', subtype: 'status', status: 'compacting', session_id: 's1' },
  });
  assert.equal(s(chat).turn, 'idle');
  assert.deepEqual(await c.send(chat, input('idle-one'), 1, true), { action: 'queued', id: 'idle-one' });
  c.send(chat, input('idle-two'), 2);
  assert.equal(execs.length, 0);
  for (let i = 0; i < 2; i++)
    c.onClaudeEvent({
      key: 'claude:s1',
      kind: 'message',
      msg: {
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 's1',
        compact_metadata: { trigger: 'auto', pre_tokens: 100 },
      },
    });
  assert.equal(execs.length, 1);
  assert.equal(execs[0].kind, 'claude-turn');
  assert.equal(execs[0].chatId, chat);
  assert.equal(s(chat).queue[0].id, 'idle-two');
  assert.equal(s(chat).queue[0].waitingFor, undefined);
  execs[0].done({ started: true, turnId: 'idle-turn' });
  await tick();
  c.end(chat);
  assert.equal(execs.length, 2);
  execs[1].done({ started: true, turnId: 'next-turn' });
  await tick();
});

test('unknown, malformed, wrong-turn and wrong-item events never release another compaction', async () => {
  const { c, execs, s } = await running();
  signal(c, 't1', 'active');
  c.send('t1', input('keep'), 1);
  signal(c, 't1', 'complete', 'wrong-item');
  signal(c, 't1', 'complete', 'compact-1', 'wrong-turn');
  c.onCodexMessage(
    codex('item/completed', { threadId: 'unknown', turnId: 'turn-1', item: { type: 'contextCompaction', id: 'compact-1' } }),
  );
  for (const params of [null, [], {}, { threadId: 't1', turnId: 'turn-1', item: { type: 'contextCompaction' } }])
    c.onCodexMessage(codex('item/completed', params));
  assert.equal(execs.length, 1);
  assert.equal(s('t1').compaction, 'active');
  signal(c, 't1', 'complete');
  execs[1].done({ started: true });
  await tick();
});

test('Claude permission-only statuses leave holds intact; failed, unknown completion and old sessions retain input', async () => {
  for (const ending of [{ status: null }, { status: 'requesting' }, { compact_result: 'failed', compact_error: 'raw failure' }]) {
    const { c, execs, s } = await running('claude:s1');
    signal(c, 'claude:s1', 'active');
    c.send('claude:s1', input('hold'), 1);
    for (const msg of [{ permissionMode: 'plan' }, { status: 'future' }, { status: 'compacting' }])
      c.onClaudeEvent({ key: 'claude:s1', kind: 'message', msg: { type: 'system', subtype: 'status', session_id: 's1', ...msg } });
    c.onClaudeEvent({ key: 'claude:s1', kind: 'message', msg: { type: 'system', subtype: 'compact_boundary', session_id: 'old' } });
    assert.equal(s('claude:s1').compaction, 'active');
    c.onClaudeEvent({ key: 'claude:s1', kind: 'message', msg: { type: 'system', subtype: 'status', session_id: 's1', ...ending } });
    assert.equal(s('claude:s1').compaction, 'compact_result' in ending ? 'failed' : null);
    assert.equal(s('claude:s1').queue[0].waitingFor, 'compactionRetry');
    assert.equal(execs.length, 1);
  }
});

test('segment, account, native-turn and process replacement retire automatic release while keeping the full input', async () => {
  for (const change of ['segment', 'same-native-segment', 'pending-switch', 'turn', 'account', 'process']) {
    const chat = change === 'account' || change === 'process' ? 'claude:s1' : 't1';
    const { c, execs, s, chats } = await running(chat);
    chats.ensure(chat);
    let account = 'account-a';
    c.claudeTurns.accountOf = () => account;
    if (change === 'account')
      c.onClaudeEvent({
        key: chat,
        kind: 'message',
        account,
        msg: {
          type: 'system',
          subtype: 'status',
          status: 'compacting',
          session_id: 's1',
        },
      });
    else signal(c, chat, 'active');
    c.send(chat, input('keep'), 2);
    if (change === 'segment')
      selectSegment(c, chats, chat, [
        ['codex', 't1'],
        ['acp:qwen', 'next'],
      ]);
    else if (change === 'same-native-segment')
      selectSegment(c, chats, chat, [
        ['codex', 't1'],
        ['codex', 't1'],
      ]);
    else if (change === 'pending-switch') c.state.patch(chat, { pendingSwitch: { harness: 'claude', model: null } });
    else if (change === 'turn') c.onCodexMessage(codex('turn/started', { threadId: chat, turn: { id: 'replacement-turn' } }));
    else if (change === 'account') account = 'account-b';
    else c.onClaudeEvent({ key: chat, kind: 'processStarted' });
    if (change === 'account') {
      c.onClaudeEvent({
        key: chat,
        kind: 'message',
        account: 'account-a',
        msg: { type: 'system', subtype: 'compact_boundary', session_id: 's1' },
      });
      c.send(chat, input('explicit-new-input', 'queue'), 1);
      // A current owner read retires the old account before any next dispatch.
      c.sendNow(chat, 'not-present', 1);
      c.invalidate();
    } else signal(c, chat, 'complete');
    assert.equal(execs.length, 1, change);
    assert.equal(s(chat).queue.find((q: any) => q.id === 'keep').waitingFor, 'compactionRetry', change);
    assert.deepEqual(s(chat).queue.find((q: any) => q.id === 'keep').attachments, input('keep').attachments);
  }
});

test('compaction starting during preflight is rechecked and completion before failure settlement releases exactly once', async () => {
  for (const stop of [false, true]) {
    const { c, execs, s } = await running();
    let open!: () => void;
    c.beforeDispatch = () =>
      new Promise<void>((r) => {
        open = r;
      });
    let settle!: () => void;
    c.onDispatchResult = () =>
      new Promise<void>((r) => {
        settle = r;
      });
    const receipt = c.send('t1', input('preflight'), 1, true);
    signal(c, 't1', 'active');
    open();
    await tick();
    assert.equal(execs.length, 1);
    c.beforeDispatch = null;
    c.onDispatchResult = null;
    signal(c, 't1', 'complete');
    if (stop) {
      c.noteStop('t1');
      c.end('t1', { drain: false });
    }
    settle();
    assert.deepEqual(await receipt, { action: 'queued', id: 'preflight' });
    await tick();
    if (stop) {
      assert.equal(execs.length, 1);
      assert.equal(s('t1').queue[0].waitingFor, 'compactionRetry');
    } else {
      assert.equal(execs.length, 2);
      assert.equal(execs[1].item.id, 'preflight');
      execs[1].done({ started: true });
      await tick();
      assert.equal(s('t1').queue.length, 0);
    }
  }
});

test('transport guards retain a steer if compaction begins while the adapter is preparing input', async () => {
  const { c, execs, s } = await running('claude:s1');
  let finish!: () => void;
  c.claudeTurns.steer = async (_chat: string, _ref: any, item: any) => {
    await new Promise<void>((r) => {
      finish = r;
    });
    assertInputCurrent(item);
    return { started: true };
  };
  const receipt = c.send('claude:s1', input('images'), 1, true);
  signal(c, 'claude:s1', 'active');
  finish();
  assert.deepEqual(await receipt, { action: 'queued', id: 'images' });
  assert.equal(s('claude:s1').queue[0].waitingFor, 'compaction');
  assert.equal(execs.length, 1);
});

test('native completion in either ACK order preserves remaining input and never repeats an accepted steer', async () => {
  for (const ackFirst of [false, true]) {
    const { c, execs, s } = await running();
    signal(c, 't1', 'active');
    c.send('t1', input('one'), 1);
    c.send('t1', input('two'), 1);
    signal(c, 't1', 'complete');
    if (ackFirst) {
      execs[1].done({ started: true });
      await tick();
    }
    c.end('t1');
    if (!ackFirst) execs[1].done({ started: true });
    else execs[2].done({ started: false, error: 'turn ended' });
    await tick();
    const twos = execs.filter((e: any) => e.item.id === 'two');
    assert.equal(execs.filter((e: any) => e.item.id === 'one').length, 1);
    assert.equal(twos.at(-1)?.kind, 'turn');
    twos.at(-1)!.done({ started: true, turnId: 'next' });
    await tick();
    assert.equal(s('t1').queue.length, 0);
  }
});

test('a late Claude boundary confirms an unconfirmed end, but never revives an explicit failure or retry', async () => {
  for (const end of ['ended', 'failed', 'retried']) {
    const { c, execs, s } = await running('claude:s1');
    signal(c, 'claude:s1', 'active');
    c.send('claude:s1', input('hold'), 1);
    c.onClaudeEvent({
      key: 'claude:s1',
      kind: 'message',
      msg: { type: 'system', subtype: 'status', session_id: 's1', status: null, ...(end === 'failed' ? { compact_result: 'failed' } : {}) },
    });
    if (end === 'retried') {
      const retry = c.sendNow('claude:s1', 'hold', 1, true);
      execs[1].done({ started: true });
      assert.deepEqual(await retry, { status: 'sent' });
    }
    c.onClaudeEvent({ key: 'claude:s1', kind: 'message', msg: { type: 'system', subtype: 'compact_boundary', session_id: 's1' } });
    if (end === 'ended') {
      execs[1].done({ started: true });
      await tick();
    }
    assert.equal(execs.length, end === 'failed' ? 1 : 2);
    assert.equal(s('claude:s1').queue.length, end === 'failed' ? 1 : 0);
  }
});

test('Stop, segment replacement and another compaction win before a released steer reaches native dispatch', async () => {
  for (const change of ['stop', 'segment', 'runtime', 'compaction']) {
    const { c, execs, s, chats } = await running();
    signal(c, 't1', 'active');
    c.send('t1', input('held'), 1);
    let resume!: () => void;
    c.beforeDispatch = () =>
      new Promise<void>((r) => {
        resume = r;
        c.beforeDispatch = null;
      });
    signal(c, 't1', 'complete');
    if (change === 'stop') {
      c.noteStop('t1');
      c.end('t1', { drain: false });
    } else if (change === 'segment')
      selectSegment(c, chats, 't1', [
        ['codex', 't1'],
        ['claude', 'replacement'],
      ]);
    else if (change === 'runtime') {
      c.rts.delete('t1');
      c.rt('t1');
      c.state.patch('t1', { turn: 'idle', activeTurn: null });
    } else signal(c, 't1', 'active', 'compact-2');
    resume();
    await tick();
    c.beforeDispatch = null;
    assert.equal(execs.length, 1, change);
    assert.equal(s('t1').queue.length, 1, change);
    assert.equal(s('t1').queue[0].id, 'held');
    assert.deepEqual(s('t1').queue[0].opts, input('held').opts);
    if (change === 'compaction') {
      assert.equal(s('t1').queue[0].waitingFor, 'compaction');
      signal(c, 't1', 'complete', 'compact-2');
      assert.equal(execs.length, 2);
      execs[1].done({ started: true });
      await tick();
      assert.equal(s('t1').queue.length, 0);
    } else assert.equal(s('t1').queue[0].waitingFor, 'compactionRetry');
  }
});
