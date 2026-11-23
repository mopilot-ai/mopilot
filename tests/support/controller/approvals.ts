// Approval routing, ancestry and background-card lifetime scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, codex } from './fixture';

export function registerApprovalsCases() {
  test('approvals: awaitingUser until answered; a second window answering the same request is dropped', () => {
    const { c, s } = setup();
    c.send('t1', { text: 'first' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-1' } }));
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 't1', turnId: 'turn-1' }, 42));
    assert.equal(s('t1').turn, 'awaitingUser');
    assert.equal(s('t1').approvals[0].id, 42);
    assert.equal(c.onCodexOutgoing({ id: 42, result: { decision: 'accept' } }), true);
    assert.equal(s('t1').turn, 'running');
    assert.equal(s('t1').approvals.length, 0);
    assert.equal(c.onCodexOutgoing({ id: 42, result: { decision: 'decline' } }), false);
    // codex:respond carries only answers to cards: anything else names no card main holds, and is not sent
    assert.equal(c.onCodexOutgoing({ id: 'w1', method: 'thread/list', params: {} }), false);
    // a legacy approval names its thread conversationId; it is the chat's card all the same
    c.onCodexMessage(codex('execCommandApproval', { conversationId: 't1', callId: 'c', command: ['ls'] }, 43));
    assert.equal(s('t1').turn, 'awaitingUser');
    assert.deepEqual(
      s('t1').approvals.map((a: { id: number; method: string }) => [a.id, a.method]),
      [[43, 'execCommandApproval']],
    );
    // one with no thread at all is no chat's
    c.onCodexMessage(codex('applyPatchApproval', { callId: 'c' }, 44));
    assert.equal(s('t1').approvals.length, 1);
  });

  test("a sub-agent's approval is the spawning chat's card, through nested agents; a thread nobody spawned stays no chat's", () => {
    const { c, s } = setup();
    c.send('t1', { text: 'go' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-1' } }));
    const spawn = (parent: string, ...kids: any[]) =>
      c.onCodexMessage(
        codex('item/completed', {
          threadId: parent,
          turnId: 'x',
          item: { type: 'collabAgentToolCall', tool: 'spawnAgent', id: `s-${parent}`, receiverThreadIds: kids },
        }),
      );
    // before anyone is spawned, a child's request has no chat
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'kid', turnId: 'k' }, 81));
    assert.equal(s('t1').approvals.length, 0);
    spawn('t1', 'kid', 7);
    spawn('kid', 'grandkid');
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'kid', turnId: 'k' }, 82));
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'grandkid', turnId: 'g' }, 83));
    assert.deepEqual(
      s('t1').approvals.map((a: { id: number }) => a.id),
      [82, 83],
    );
    assert.equal(s('t1').turn, 'awaitingUser');
    // the card is answered like any other
    assert.equal(c.onCodexOutgoing({ id: 82, result: { decision: 'accept' } }), true);
    assert.deepEqual(
      s('t1').approvals.map((a: { id: number }) => a.id),
      [83],
    );
    // the kid's own turn events stay out of the chat's turn
    c.onCodexMessage(codex('turn/started', { threadId: 'kid', turn: { id: 'kid-turn' } }));
    assert.equal(s('t1').activeTurn.id, 'turn-1');
  });

  test('non-spawn collaboration cannot steal a child or another chat approval', () => {
    const { c, s } = setup();
    c.send('left', { text: 'go' }, 1);
    c.send('right', { text: 'go' }, 2);
    const event = (parent: string, tool: string, children: string[]) =>
      c.onCodexMessage(
        codex('item/completed', {
          threadId: parent,
          item: { type: 'collabAgentToolCall', tool, receiverThreadIds: children },
        }),
      );
    event('left', 'spawnAgent', ['kid']);
    for (const tool of ['sendMessage', 'wait', 'closeAgent']) {
      event('right', tool, ['kid']);
      event('kid', tool, ['right']);
    }
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'kid' }, 91));
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'right' }, 92));
    assert.deepEqual(
      s('left').approvals.map((a: any) => a.id),
      [91],
    );
    assert.deepEqual(
      s('right').approvals.map((a: any) => a.id),
      [92],
    );
  });

  test('approval ancestry keeps roots and first parents, rejects malformed edges, and routes deeply nested children', () => {
    const { c, s, chats } = setup();
    c.send('root', { text: 'go' }, 1);
    c.send('other', { text: 'go' }, 2);
    chats.ensure('root');
    chats.ensure('other');
    chats.setSegments('other', [{ harness: 'codex', nativeId: 'other-segment', start: 0, count: null }]);
    c.invalidate();
    const spawn = (parent: any, children: any[], method = 'item/completed', requestId?: number) =>
      c.onCodexMessage(
        codex(
          method,
          { threadId: parent, item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: children } },
          requestId,
        ),
      );
    spawn('root', ['', null, 7, 'root', 'other', 'other-segment', 'kid']);
    spawn('other', ['kid']);
    spawn(7, ['invalid-parent']);
    spawn('root', ['unknown-event'], 'custom/event');
    spawn('root', ['request-child'], 'custom/request', 93);
    spawn('root', ['missing-list']);
    c.onCodexMessage(codex('item/completed', { threadId: 'root', item: { type: 'collabAgentToolCall', tool: 'spawnAgent' } }));
    assert.equal(c.parents.parentOf('kid'), 'root');
    for (const id of ['', null, 7, 'root', 'invalid-parent', 'unknown-event', 'request-child']) assert.equal(c.parents.parentOf(id), null);
    // a chat, or a segment of one, may be named as a child: the link is kept, but it asks in its own chat (below)
    assert.equal(c.requestChat('other'), 'other');
    assert.equal(c.requestChat('other-segment'), 'other');
    // the spawn chain a request (and a Codex thread's turn token group) climbs stops at the thread that is a chat
    assert.equal(c.requestThread('other-segment'), 'other-segment');
    assert.equal(c.requestThread('kid'), 'root');
    // A cycle among not-yet-associated threads is refused, too.
    spawn('a', ['b']);
    spawn('b', ['a']);
    assert.equal(c.parents.parentOf('a'), null);
    let parent = 'root';
    for (let i = 0; i < 12; i++) {
      const child = `deep-${i}`;
      spawn(parent, [child], 'item/started');
      parent = child;
    }
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: parent }, 94));
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'other-segment' }, 95));
    assert.deepEqual(
      s('root').approvals.map((a: any) => a.id),
      [94],
    );
    assert.deepEqual(
      s('other').approvals.map((a: any) => a.id),
      [95],
    );
    // A child later incorporated as a segment belongs to that durable chat.
    spawn('root', ['segment-child']);
    chats.setSegments('other', [
      { harness: 'codex', nativeId: 'other-segment', start: 0, count: 1 },
      { harness: 'codex', nativeId: 'segment-child', start: 1, count: null },
    ]);
    c.invalidate();
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'segment-child' }, 97));
    assert.equal(s('other').approvals.at(-1).id, 97);
    // Opening a former child as its own durable chat gives its approval to that chat.
    chats.ensure('kid');
    s('kid');
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'kid' }, 96));
    assert.deepEqual(
      s('kid').approvals.map((a: any) => a.id),
      [96],
    );
  });

  test('a parent turn completing cannot erase a live sub-agent approval or retract its notification', () => {
    const retracted: string[] = [];
    const notices: string[] = [];
    const { c, s } = setup({ retract: (id) => retracted.push(id), notify: (kind) => notices.push(kind) });
    c.send('root', { text: 'go' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 'root', turn: { id: 'T' } }));
    c.onCodexMessage(
      codex('item/started', {
        threadId: 'root',
        item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['kid'] },
      }),
    );
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'root', turnId: 'T' }, 97));
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'kid', turnId: 'K' }, 98));
    c.onCodexMessage(codex('turn/completed', { threadId: 'root', turn: { id: 'T', status: 'completed' } }));
    assert.equal(s('root').turn, 'idle');
    assert.equal(notices.includes('turn'), false);
    assert.deepEqual(
      s('root').approvals.map((a: any) => a.id),
      [98],
    );
    assert.deepEqual(retracted, []);
    assert.equal(c.onCodexOutgoing({ id: 98, result: { decision: 'accept' } }), true);
    assert.deepEqual(s('root').approvals, []);
    assert.equal(s('root').turn, 'idle');
    assert.deepEqual(retracted, ['root']);
  });

  test('Claude sub-agent permissions survive a parent result through agent ID or recorded tool ownership', () => {
    for (const metadata of [{ agentID: 'agent' }, { toolUseID: 'child-tool' }]) {
      const retracted: string[] = [];
      const { c, s } = setup({ retract: (id) => retracted.push(id) });
      const key = 'claude:parent';
      s(key);
      c.onClaudeEvent({ key, kind: 'message', msg: { type: 'assistant', message: { content: [] } } });
      c.onClaudeEvent({
        key,
        kind: 'message',
        msg: { type: 'assistant', parent_tool_use_id: 'spawn', message: { content: [{ type: 'tool_use', id: 'child-tool' }] } },
      });
      c.onClaudeEvent({ key, kind: 'permission', requestId: 'child', toolName: 'Bash', ...metadata });
      for (const agentID of [undefined, null, '', 7])
        c.onClaudeEvent({ key, kind: 'permission', requestId: `root-${agentID}`, toolName: 'Bash', toolUseID: 'root-tool', agentID });
      c.addApproval(key, { id: 'malformed', method: 'claude/permission', params: null });
      c.onClaudeEvent({ key, kind: 'message', msg: { type: 'result', subtype: 'success', result: 'Done' } });
      assert.deepEqual(
        s(key).approvals.map((a: any) => a.id),
        ['child'],
      );
      assert.equal(s(key).turn, 'idle');
      assert.deepEqual(retracted, []);
      c.onClaudeEvent({ key, kind: 'permissionCancelled', requestId: 'child' });
      assert.deepEqual(s(key).approvals, []);
      assert.deepEqual(retracted, [key]);
    }
  });

  test('background approval lifetime uses legacy thread IDs, clears on interruption and on harness exit', () => {
    for (const outcome of ['failed', 'interrupted', 'exit']) {
      const { c, s } = setup();
      c.send('parent', { text: 'go' }, 1);
      c.onCodexMessage(codex('turn/started', { threadId: 'parent', turn: { id: 'T' } }));
      c.onCodexMessage(
        codex('item/completed', {
          threadId: 'parent',
          item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['kid'] },
        }),
      );
      c.onCodexMessage(codex('execCommandApproval', { conversationId: 'kid' }, 99));
      c.onCodexMessage(
        codex('turn/completed', { threadId: 'parent', turn: { id: 'T', status: outcome === 'exit' ? 'completed' : outcome } }),
      );
      if (outcome === 'interrupted') assert.deepEqual(s('parent').approvals, []);
      else {
        assert.equal(s('parent').approvals[0]?.id, 99);
        c.onCodexExit();
        assert.deepEqual(s('parent').approvals, []);
        assert.equal(s('parent').turn, 'crashed');
      }
    }
  });

  test('a former sub-agent now used as its own root still clears root-turn approvals', () => {
    const { c, s, chats } = setup();
    c.onCodexMessage(
      codex('item/started', {
        threadId: 'old-root',
        item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['own'] },
      }),
    );
    chats.ensure('own');
    c.send('own', { text: 'go' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 'own', turn: { id: 'T' } }));
    c.onCodexMessage(codex('item/fileChange/requestApproval', { threadId: 'own', turnId: 'T' }, 100));
    c.onCodexMessage(codex('turn/completed', { threadId: 'own', turn: { id: 'T', status: 'completed' } }));
    assert.deepEqual(s('own').approvals, []);
  });

  test('ACP prompt completion keeps its existing root-approval cleanup', () => {
    const { c, s } = setup();
    const key = 'acp:kimi:root';
    s(key);
    c.onAcpEvent({ key, kind: 'turnStart', turnId: 'T' });
    c.onAcpEvent({ key, kind: 'permission', requestId: 'root', toolCall: { toolCallId: 'tool' } });
    c.onAcpEvent({ key, kind: 'turnEnd', turnId: 'T', stopReason: 'end_turn' });
    assert.deepEqual(s(key).approvals, []);
    assert.equal(s(key).turn, 'idle');
  });

  test('retaining a background approval does not lose or block the parent queued message', () => {
    const { c, s, execs } = setup();
    c.send('root', { text: 'first' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 'root', turn: { id: 'T' } }));
    c.onCodexMessage(
      codex('item/started', { threadId: 'root', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['kid'] } }),
    );
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'kid' }, 101));
    c.send('root', { text: 'later' }, 1);
    c.onCodexMessage(codex('turn/completed', { threadId: 'root', turn: { id: 'T', status: 'completed' } }));
    assert.equal(execs.length, 2);
    assert.equal(execs[1].item.text, 'later');
    assert.deepEqual(s('root').queue, []);
    assert.equal(s('root').approvals[0].id, 101);
  });

  test('a switched chat removes its old Codex approval on exit without crashing the replacement turn', () => {
    const retracted: string[] = [];
    const { c, s, chats, state, crashes } = setup({ retract: (id) => retracted.push(id) });
    c.send('root', { text: 'go' }, 1);
    chats.ensure('root');
    c.onCodexMessage(codex('turn/started', { threadId: 'root', turn: { id: 'T' } }));
    c.onCodexMessage(
      codex('item/started', { threadId: 'root', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['kid'] } }),
    );
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'kid' }, 102));
    c.onCodexMessage(codex('turn/completed', { threadId: 'root', turn: { id: 'T', status: 'completed' } }));
    chats.setSegments('root', [
      { harness: 'codex', nativeId: 'root', start: 0, count: 1 },
      { harness: 'claude', nativeId: 'claude:new', start: 1, count: null },
    ]);
    c.invalidate();
    state.patch('root', { turn: 'running', activeTurn: { id: 'new', human: true }, goal: { status: 'active', objective: 'keep going' } });
    c.onCodexExit();
    assert.deepEqual(s('root').approvals, []);
    assert.equal(s('root').turn, 'running');
    assert.equal(s('root').activeTurn.id, 'new');
    assert.equal(s('root').goal.status, 'active');
    assert.deepEqual(retracted, ['root']);
    assert.deepEqual(crashes, []);
  });
}
