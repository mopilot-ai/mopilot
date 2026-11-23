// The segment a switch leaves cannot take over the switching start's turn: turns it runs while its history is read (#4425).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, codex, selectSegment } from './support/controller/fixture.ts';
import { waitFor } from './support/waitFor.ts';
const require = createRequire(import.meta.url);
const { queueItem } = require('../electron/session/queueItem.cjs');

type Harness = ReturnType<typeof setup>;
/** Turn events of the segment `from` names: started twice, then ended. */
const OLD: Record<
  string,
  {
    from: [string, string];
    to: [string, string];
    start: (h: Harness, id: string) => void;
    end: (h: Harness, id: string) => void;
    exit: (h: Harness) => void;
    say: (h: Harness, text: string) => void;
  }
> = {
  codex: {
    from: ['codex', 't1'],
    to: ['claude', 'c1'],
    start: (h, id) => h.c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id } })),
    end: (h, id) => h.c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id, status: 'completed' } })),
    exit: (h) => h.c.onCodexExit(),
    say: (h, text) =>
      h.c.onCodexMessage(codex('item/completed', { threadId: 't1', turnId: 'g1', item: { type: 'agentMessage', id: 'i1', text } })),
  },
  claude: {
    from: ['claude', 'c1'],
    to: ['codex', 't1'],
    start: (h) => h.c.onClaudeEvent({ key: 'claude:c1', kind: 'message', msg: { type: 'assistant', message: { content: [] } } }),
    end: (h) => h.c.onClaudeEvent({ key: 'claude:c1', kind: 'message', msg: { type: 'result', subtype: 'success', result: 'x' } }),
    exit: (h) => h.c.onClaudeEvent({ key: 'claude:c1', kind: 'closed' }),
    say: (h, text) =>
      h.c.onClaudeEvent({ key: 'claude:c1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'text', text }] } } }),
  },
  acp: {
    from: ['acp:kimi', 'k1'],
    to: ['claude', 'c1'],
    start: (h, id) => h.c.onAcpEvent({ key: 'acp:kimi:k1', kind: 'turnStart', turnId: id }),
    end: (h, id) => h.c.onAcpEvent({ key: 'acp:kimi:k1', kind: 'turnEnd', turnId: id, stopReason: 'end_turn' }),
    exit: (h) => h.c.onAcpEvent({ key: 'acp:kimi:k1', kind: 'closed', error: 'gone' }),
    say: (h, text) =>
      h.c.onAcpEvent({
        key: 'acp:kimi:k1',
        kind: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      }),
  },
};

/** A message sent with a switch pending from `from`, whose handoff is held until the returned `settle`. */
async function switching(from: [string, string], harness: string) {
  const h = setup({ auto: false });
  selectSegment(h.c, h.chats, 'chat', [from]);
  h.c.state.patch('chat', { pendingSwitch: { harness } });
  const started = h.c.start('chat', queueItem({ id: 'm1', text: 'hi' }, 1));
  await waitFor(() => h.execs.some((x) => x.kind === 'handoff'), 'the handoff');
  const handoff = h.execs.find((x) => x.kind === 'handoff')!;
  return { h, started, settle: (r: Record<string, unknown>) => handoff.done(r) };
}

for (const [name, old] of Object.entries(OLD)) {
  test(`${name} → ${old.to[0]}: turns the old segment runs during the handoff neither replace nor end the start`, async () => {
    const { h, started, settle } = await switching(old.from, old.to[0]);
    const turnId = h.s('chat').activeTurn?.id;
    h.c.state.patch('chat', { progressAt: 0 });
    old.start(h, 'g1');
    old.say(h, 'old reply');
    old.start(h, 'g2');
    old.end(h, 'g1');
    // the pending start still owns the chat's turn; the old segment neither moved it nor wrote its reply
    assert.equal(h.s('chat').activeTurn?.id, turnId);
    assert.equal(h.s('chat').turn, 'running');
    assert.equal(h.s('chat').progressAt, 0);
    assert.equal(h.c.rt('chat').lastText, null);
    selectSegment(h.c, h.chats, 'chat', [old.from, old.to]);
    settle({ ready: true, prefix: '<handoff>' });
    await waitFor(() => h.execs.some((x) => x.kind !== 'handoff'), 'the new harness start');
    h.execs.find((x) => x.kind !== 'handoff')!.done({ started: true });
    const res = await started;
    assert.equal(res.started, true, JSON.stringify(res));
    // the message went to the new harness with its handoff
    const sent = h.execs.filter((x) => x.kind !== 'handoff');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].item.opts.prefix, '<handoff>');
    // the old segment's later end is not the chat's
    old.end(h, 'g2');
    assert.equal(h.s('chat').turn, 'running');
  });

  test(`${name} → ${old.to[0]}: the old harness exiting during the handoff does not crash the start`, async () => {
    const { h, started, settle } = await switching(old.from, old.to[0]);
    const turnId = h.s('chat').activeTurn?.id;
    old.exit(h);
    assert.equal(h.s('chat').turn, 'running');
    assert.equal(h.s('chat').activeTurn?.id, turnId);
    assert.equal(h.crashes.length, 0);
    selectSegment(h.c, h.chats, 'chat', [old.from, old.to]);
    settle({ ready: true, prefix: '<handoff>' });
    await waitFor(() => h.execs.some((x) => x.kind !== 'handoff'), 'the new harness start');
    h.execs.find((x) => x.kind !== 'handoff')!.done({ started: true });
    assert.equal((await started).started, true);
  });
}

test('a switch that does not settle leaves the old segment owning its turns again', async () => {
  const { h, started, settle } = await switching(['codex', 't1'], 'claude');
  settle({ ready: false, error: 'no' });
  const res = await started;
  assert.equal(res.started, false);
  // the chat says why; the message is kept for a retry
  assert.equal(h.s('chat').turn, 'crashed');
  assert.equal(h.c.rt('chat').switchingFrom, null);
  // the message waits with its switch; a turn the Codex thread starts is the chat's again
  OLD.codex.start(h, 'g3');
  assert.equal(h.s('chat').activeTurn?.id, 'g3');
  OLD.codex.end(h, 'g3');
  assert.notEqual(h.s('chat').turn, 'running');
});

test("once the switch commits, the new segment's events are the chat's while the start finishes", async () => {
  const { h, started, settle } = await switching(['codex', 't1'], 'claude');
  const turnId = h.s('chat').activeTurn?.id;
  selectSegment(h.c, h.chats, 'chat', [
    ['codex', 't1'],
    ['claude', 'c1'],
  ]);
  h.c.onClaudeEvent({
    key: 'claude:c1',
    kind: 'message',
    msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
  });
  assert.equal(h.c.rt('chat').lastText, 'hello');
  assert.equal(h.s('chat').activeTurn?.id, turnId);
  settle({ ready: true, prefix: '<handoff>' });
  await waitFor(() => h.execs.some((x) => x.kind !== 'handoff'), 'the new harness start');
  h.execs.find((x) => x.kind !== 'handoff')!.done({ started: true });
  assert.equal((await started).started, true);
});

test('Codex exiting during a switch that then fails still pauses its goal, and the chat says why', async () => {
  const { h, started, settle } = await switching(['codex', 't1'], 'claude');
  h.c.state.patch('chat', { goal: { objective: 'ship', status: 'active' } });
  assert.deepEqual(h.c.onCodexExit(), ['t1']);
  assert.equal(h.s('chat').goal.status, 'paused');
  assert.equal(h.s('chat').turn, 'running');
  settle({ ready: false, error: 'no' });
  assert.equal((await started).started, false);
  assert.equal(h.s('chat').turn, 'crashed');
});

test("a start's switch mark is its own: another start's mark outlives it", async () => {
  const { h, started, settle } = await switching(['codex', 't1'], 'claude');
  const other = { kind: 'claude', key: 'claude:other' };
  h.c.rt('chat').switchingFrom = other;
  settle({ ready: false, error: 'no' });
  await started;
  assert.equal(h.c.rt('chat').switchingFrom, other);
});

test("the Claude session a switch leaves cannot start a compaction of the switching start's turn", async () => {
  const { h, started, settle } = await switching(['claude', 'c1'], 'codex');
  h.c.onClaudeEvent({
    key: 'claude:c1',
    kind: 'message',
    msg: { type: 'system', subtype: 'status', status: 'compacting', session_id: 'c1' },
  });
  assert.equal(h.c.rt('chat').compaction ?? null, null);
  settle({ ready: false, error: 'no' });
  await started;
});
