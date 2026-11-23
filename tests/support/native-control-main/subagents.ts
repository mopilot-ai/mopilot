// Native-control subagents unit cases with shared protocol and lifecycle fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeCodexLifecycle, settle, injection, lifecycle, item, done, hookOf, started } from './fixture';

export function registerSubagentsCases() {
  const subTurn = (method: string, threadId: string, turnId: string) => ({
    method,
    params: { threadId, turn: { id: turnId, status: 'completed' } },
  });
  const collab = (method: string, turnId: string, receivers: string[] | undefined, states: any, threadId = 'th') => ({
    method,
    params: {
      threadId,
      turnId,
      item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: receivers, agentsStates: states },
    },
  });
  const activity = (method: string, turnId: string, agent: string, kind: string, threadId = 'th') => ({
    method,
    params: { threadId, turnId, item: { type: 'subAgentActivity', agentThreadId: agent, kind } },
  });

  test('distinct opaque child and turn IDs cannot suppress each other’s cleanup', async () => {
    const t = lifecycle();
    t.lc.observe(item('item/completed', 'p1', 'click'));
    for (const [child, turn] of [
      ['a', 'b:c'],
      ['a:b', 'c'],
    ]) {
      t.lc.observe(started(child, { parentThreadId: 'th' }));
      t.lc.observe(subTurn('turn/started', child, turn));
      t.lc.observe(subTurn('turn/completed', child, turn));
    }
    await t.lc.ready('th');
    assert.deepEqual(t.calls.map(hookOf), [
      ['turn_ended', 'SubagentStop', 'a', 'b:c'],
      ['turn_ended', 'SubagentStop', 'a:b', 'c'],
    ]);
  });

  test('a root turn ID cannot impersonate a child cleanup key', async () => {
    const t = lifecycle();
    t.lc.observe(item('item/completed', 'p1', 'click'));
    t.lc.observe(done('subagent:a:b'));
    t.lc.observe(started('a', { parentThreadId: 'th' }));
    t.lc.observe(subTurn('turn/started', 'a', 'b'));
    t.lc.observe(subTurn('turn/completed', 'a', 'b'));
    await t.lc.ready('th');
    assert.deepEqual(t.calls.map(hookOf), [['turn_ended', 'SubagentStop', 'a', 'b']]);
  });

  test('racing native-control turns retain distinct thread and turn boundaries', async () => {
    let release!: (value: any) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const t = lifecycle({ respond: () => pending });
    t.lc.observe(item('item/completed', 'p1', 'click'));
    t.lc.observe(done('p1'));
    t.lc.guard('th', 'b\nc', 'a');
    t.lc.guard('th', 'c', 'a\nb');
    assert.equal(t.lc.racing.get('th').size, 2);
    t.lc.raced('th', 'a', 'b\nc');
    assert.equal(t.lc.racing.get('th').size, 1);
    release({ content: [] });
    await t.lc.ready('th');
  });

  test('forgetting one native thread cannot clear a different thread with that delimiter prefix', async () => {
    const t = lifecycle({ respond: () => ({ isError: true }) });
    t.lc.observe(item('item/completed', 'p1', 'click'));
    t.lc.observe(done('p1'));
    await settle();
    t.lc.guard('th', 'one', 'a');
    t.lc.guard('th', 'two', 'a\nb');
    assert.equal(t.lc.blocked.size, 2);
    t.lc.forget('a');
    assert.equal(t.lc.blocked.size, 1);
    t.lc.guard('th', 'two', 'a\nb');
    assert.equal(t.blocked.length, 2);
    t.lc.forget('a\nb');
    assert.equal(t.lc.blocked.size, 0);
    t.lc.guard('th', 'three', 'child');
    assert.equal(t.lc.blocked.size, 1);
    t.lc.forget('th');
    assert.equal(t.lc.blocked.size, 0);
  });

  test('a subagent of a native thread ends its turn with SubagentStop on the native thread, so its tabs close', async () => {
    const t = lifecycle();
    // the plugin runtime ran on the parent
    t.lc.observe(item('item/completed', 'p1', 'click'));
    t.lc.observe(started('sub', { parentThreadId: 'th' }));
    t.lc.observe(subTurn('turn/started', 'sub', 's1'));
    t.lc.observe(subTurn('turn/completed', 'sub', 's1'));
    assert.deepEqual(t.calls.map(hookOf), [['turn_ended', 'SubagentStop', 'sub', 's1']]);
    assert.equal(t.calls[0].threadId, 'th', "sent on the native thread's connection");
    await t.lc.ready('th');
    assert.equal(t.lc.threads.get('th').has(JSON.stringify(['subagent', 'sub', 's1'])), true);
    // the same end seen again (the collab wait reports it too) is not repeated
    t.lc.observe(collab('item/completed', 'p1', ['sub'], { sub: { status: 'completed' } }));
    t.lc.observe(activity('item/completed', 'p1', 'sub', 'completed'));
    await settle();
    assert.equal(t.calls.length, 1);
    // a further turn of the same subagent ends again
    t.lc.observe(subTurn('turn/started', 'sub', 's2'));
    t.lc.observe(subTurn('turn/completed', 'sub', 's2'));
    assert.deepEqual(t.calls.at(-1) && hookOf(t.calls.at(-1)), ['turn_ended', 'SubagentStop', 'sub', 's2']);
  });

  test('subagents are found by their spawn source, collab calls and activity items; nested ones belong to the native root', async () => {
    const t = lifecycle();
    t.lc.observe(item('item/started', 'p1', 'click'));
    t.lc.observe(started('a', { source: { subAgent: { thread_spawn: { parent_thread_id: 'th', depth: 1 } } } }));
    t.lc.observe(started('a2', { parentThreadId: 'a' }));
    t.lc.observe(collab('item/started', 'p1', ['b'], { b: { status: 'running' } }));
    t.lc.observe(activity('item/started', 'p1', 'c', 'started'));
    assert.deepEqual(
      [...t.lc.subagents].map(([id, s]: any) => [id, s.parent]),
      [
        ['a', 'th'],
        ['a2', 'th'],
        ['b', 'th'],
        ['c', 'th'],
      ],
    );
    // without its own turn id, the end carries the parent turn the notification came in
    t.lc.observe(collab('item/completed', 'p1', ['b'], { b: { status: 'errored' } }));
    t.lc.observe(activity('item/completed', 'p1', 'c', 'interrupted'));
    t.lc.observe(collab('item/completed', 'p1', undefined, { a2: { status: 'shutdown' } }, 'a'));
    assert.deepEqual(t.calls.map(hookOf), [
      ['turn_ended', 'SubagentStop', 'b', 'p1'],
      ['turn_ended', 'SubagentStop', 'c', 'p1'],
      ['turn_ended', 'SubagentStop', 'a2', 'p1'],
    ]);
    // activity again (interacted) reopens it; an end with the same parent turn is not sent twice
    t.lc.observe(activity('item/started', 'p1', 'c', 'interacted'));
    assert.equal(t.lc.subagents.get('c').stopped, false);
    t.lc.observe(activity('item/completed', 'p1', 'c', 'completed'));
    assert.equal(t.calls.length, 3);
    // a collab call without states, an unknown agent's state, a state without a status
    t.lc.observe(collab('item/started', 'p1', [], undefined));
    t.lc.observe(collab('item/completed', 'p1', [], { stranger: { status: 'completed' }, a: null }));
    t.lc.subagentActive('stranger');
    assert.equal(t.lc.subagents.has('stranger'), false);
    assert.equal(t.calls.length, 3);
    await t.lc.ready('th');
  });

  test('a subagent that used native control itself is released even when its parent never did; without either, nothing is sent', async () => {
    const t = lifecycle();
    t.lc.observe(started('quiet', { parentThreadId: 'th' }));
    t.lc.observe(subTurn('turn/started', 'quiet', 'q1'));
    t.lc.observe(subTurn('turn/completed', 'quiet', 'q1'));
    assert.deepEqual(t.calls, [], 'a coding-only subagent never depends on the plugin');
    t.lc.observe(started('busy', { parentThreadId: 'th' }));
    t.lc.observe(subTurn('turn/started', 'busy', 'b1'));
    t.lc.observe(item('item/started', 'b1', 'js', 'x', 'busy'));
    assert.equal(t.lc.runtimes.has('th'), true);
    t.lc.observe(subTurn('turn/completed', 'busy', 'b1'));
    assert.deepEqual(t.calls.map(hookOf), [['turn_ended', 'SubagentStop', 'busy', 'b1']]);
    await t.lc.ready('th');
  });

  test("subagent tracking ignores what is not a native thread's subagent", async () => {
    const t = lifecycle({ native: ['th', 'native2'] });
    t.lc.observe(item('item/started', 'p1', 'click'));
    const ignored: any[] = [
      started('x', {}),
      started('', { parentThreadId: 'th' }),
      { method: 'thread/started', params: {} },
      started('th', { parentThreadId: 'th' }),
      started('native2', { parentThreadId: 'th' }),
      started('y', { parentThreadId: 'managed' }),
      collab('item/started', 'p1', ['z'], {}, ''),
      { method: 'item/started', params: { threadId: 'th', turnId: 'p1', item: { type: 'subAgentActivity', kind: 'started' } } },
      { method: 'item/started', params: { threadId: 'th', turnId: 'p1' } },
      item('item/started', 'm1', 'click', 'm', 'managed'),
      subTurn('turn/started', 'managed', 'm1'),
      { method: 'turn/started', params: { threadId: 'sub' } },
      { method: 'thread/closed', params: { threadId: 'managed' } },
    ];
    for (const m of ignored) t.lc.observe(m);
    assert.deepEqual([...t.lc.subagents.keys()], []);
    // a subagent seen twice keeps its first parent
    t.lc.observe(started('sub', { parentThreadId: 'th' }));
    t.lc.observe(collab('item/started', 'p1', ['sub'], {}, 'native2'));
    assert.equal(t.lc.subagents.get('sub').parent, 'th');
    t.lc.observe({ method: 'turn/started', params: { threadId: 'sub' } });
    t.lc.observe({ method: 'turn/completed', params: { threadId: 'sub', turn: {} } });
    assert.equal(t.lc.subagents.get('sub').turnId, null);
    await settle();
    assert.deepEqual(t.calls, []);
  });

  test('a closed subagent is released with its last turn and forgotten; closing the parent forgets its subagents', async () => {
    const t = lifecycle();
    t.lc.observe(item('item/started', 'p1', 'click'));
    t.lc.observe(started('s', { parentThreadId: 'th' }));
    t.lc.observe(subTurn('turn/started', 's', 's1'));
    t.lc.observe({ method: 'thread/closed', params: { threadId: 's' } });
    assert.deepEqual(t.calls.map(hookOf), [['turn_ended', 'SubagentStop', 's', 's1']]);
    assert.equal(t.lc.subagents.has('s'), false);
    // closed without a known turn: nothing to send
    t.lc.observe(started('n', { parentThreadId: 'th' }));
    t.lc.observe({ method: 'thread/closed', params: { threadId: 'n' } });
    assert.equal(t.calls.length, 1);
    t.lc.observe(started('k', { parentThreadId: 'th' }));
    t.lc.forget('th');
    assert.equal(t.lc.subagents.has('k'), false);
  });

  test('a subagent ending after its parent lost the native path reports the release as failed', async () => {
    const t = lifecycle();
    t.lc.observe(item('item/started', 'p1', 'click'));
    t.lc.observe(started('s', { parentThreadId: 'th' }));
    t.native.delete('th');
    t.lc.observe(subTurn('turn/completed', 's', 's1'));
    await assert.rejects(t.lc.ready('th'), /closed before cleanup/);
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.errors, [['th', 'The original native connection closed before cleanup']]);
  });

  test("a disconnect clears every thread's strip and all stop and subagent state", () => {
    const { lc, states } = lifecycle();
    lc.observe(done('u1'));
    lc.observe(started('s', { parentThreadId: 'th' }));
    lc.interrupt('th', 'u2');
    states.length = 0;
    lc.clear();
    assert.deepEqual(states, [['th', null]]);
    assert.equal(lc.has('th'), false);
    assert.equal(lc.stops.size + lc.subagents.size + lc.runtimes.size + lc.racing.size + lc.blocked.size, 0);
    // publishing a thread it no longer tracks clears its strip
    lc.publish('gone');
    assert.deepEqual(states.at(-1), ['gone', null]);
  });

  test('old finished turns are pruned; a pending or failed cleanup is kept', async () => {
    let release!: () => void;
    const t = lifecycle({
      respond: (_m: string, p: any) =>
        p.arguments.turn_id === 'slow'
          ? new Promise((r) => (release = () => r({ content: [] })))
          : p.arguments.turn_id === 'bad'
            ? { isError: true }
            : { content: [] },
    });
    t.lc.observe(item('item/started', 'slow', 'click'));
    t.lc.observe(done('slow'));
    t.lc.observe(item('item/started', 'bad', 'click'));
    t.lc.observe(done('bad'));
    await settle();
    for (let i = 0; i < 40; i++) t.lc.observe(done(`n${i}`));
    const turns = t.lc.threads.get('th');
    assert.equal(turns.size, 32);
    assert.ok(turns.has(JSON.stringify(['turn', 'slow'])));
    assert.ok(turns.has(JSON.stringify(['turn', 'bad'])));
    assert.ok(!turns.has(JSON.stringify(['turn', 'n0'])));
    assert.deepEqual(t.states.at(-1), ['th', { phase: 'failed', turnId: 'bad', error: 'The original runtime rejected turn cleanup' }]);
    release();
    await assert.rejects(t.lc.ready('th'), /rejected turn cleanup/);
  });

  test('without listeners the lifecycle still cleans up, times stops and reports failures nowhere', async () => {
    const { lc, calls } = lifecycle({ defaults: true, respond: () => ({ isError: true }) });
    lc.observe(item('item/started', 'u1', 'click'));
    lc.interrupt('th', 'u1');
    lc.acknowledged('th', 'u1');
    lc.observe(done('u1', 'interrupted'));
    await assert.rejects(lc.ready('th'), /rejected turn cleanup/);
    assert.equal(calls[0].timeout, 60_000);
    lc.observe(item('item/started', 'u2', 'click'));
    assert.equal(lc.blocked.size, 1);
    lc.forget('th');
  });
}

export function registerOwnershipCases() {
  test('real injection and cleanup observers agree on spawned children without adopting message receivers', () => {
    const { inj } = injection({ nativeEnabled: () => true });
    inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    inj.observe({ id: 1, result: { thread: { id: 'root' } } });
    const lc = new NativeCodexLifecycle({
      call: async () => ({ content: [] }),
      isNativeThread: (id: string) => inj.isNativeThread(id),
      isLoadedThread: (id: string) => inj.isLoadedThread(id),
    });
    const child = started('child', { parentThreadId: 'root' });
    inj.observe(child);
    lc.observe(child);
    assert.equal(lc.subagents.get('child')?.parent, 'root');
    const message = {
      method: 'item/completed',
      params: {
        threadId: 'child',
        item: {
          type: 'collabAgentToolCall',
          tool: 'sendMessage',
          receiverThreadIds: ['root', 'unrelated'],
          agentsStates: {},
        },
      },
    };
    inj.observe(message);
    lc.observe(message);
    assert.equal(inj.subagents.has('root'), false);
    assert.equal(lc.subagents.has('root'), false);
    assert.equal(lc.subagents.has('unrelated'), false);
  });

  test('malformed child ids cannot enter native cleanup ownership', () => {
    const t = lifecycle();
    for (const id of [null, '', 42, {}]) t.lc.adopt(id, 'th');
    assert.equal(t.lc.subagents.size, 0);
  });
}
