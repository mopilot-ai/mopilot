// Scheduled-run, crash, exit and notification lifecycle scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crashText, setup, tick, codex } from './fixture';

export function registerLifecycleCases() {
  test('a scheduled run set to skip stops at its first approval; one set to wait keeps the card', async () => {
    const { c, s } = setup();
    const skipped: string[] = [];
    const stops: string[] = [];
    c.onSkipped = (id: string) => skipped.push(id);
    c.codex.stopTurn = async (id: string) => (stops.push(id), true);
    for (const [chat, onApproval, id] of [
      ['t1', 'skip', 51],
      ['t2', 'wait', 52],
    ] as const) {
      c.send(chat, { text: 'run' }, 1);
      c.state.patch(chat, { scheduled: { unattended: true, computer: false, onApproval } });
      c.onCodexMessage(codex('turn/started', { threadId: chat, turn: { id: `${chat}-turn` } }));
      c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: chat, turnId: `${chat}-turn` }, id));
    }
    await tick();
    assert.deepEqual(skipped, ['t1']);
    assert.deepEqual(stops, ['t1']);
    assert.equal(s('t2').approvals.length, 1);
    // a person watching (Run now) is asked, whatever the task says
    c.send('t3', { text: 'run' }, 1);
    c.state.patch('t3', { scheduled: { unattended: false, computer: false, onApproval: 'skip' } });
    c.onCodexMessage(codex('turn/started', { threadId: 't3', turn: { id: 't3-turn' } }));
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 't3', turnId: 't3-turn' }, 53));
    assert.deepEqual(skipped, ['t1']);
  });

  test('without an onSkipped listener a scheduled skip-run still stops at its first approval', async () => {
    const { c, s } = setup();
    const stops: string[] = [];
    c.codex.stopTurn = async (id: string) => (stops.push(id), true);
    c.send('t1', { text: 'run' }, 1);
    c.state.patch('t1', { scheduled: { unattended: true, computer: false, onApproval: 'skip' } });
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 't1-turn' } }));
    assert.doesNotThrow(() => c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 't1', turnId: 't1-turn' }, 61)));
    await tick();
    assert.deepEqual(stops, ['t1']);
    assert.equal(s('t1').approvals.length, 1);
  });

  test('a scheduled skip-run whose stop fails is still skipped', async () => {
    const { c } = setup();
    const skipped: string[] = [];
    const stops: string[] = [];
    c.onSkipped = (id: string) => skipped.push(id);
    c.stopChat = async (id: string) => {
      stops.push(id);
      throw new Error('app-server gone');
    };
    c.send('t1', { text: 'run' }, 1);
    c.state.patch('t1', { scheduled: { unattended: true, computer: false, onApproval: 'skip' } });
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 't1-turn' } }));
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 't1', turnId: 't1-turn' }, 71));
    await tick();
    assert.deepEqual(stops, ['t1']);
    assert.deepEqual(skipped, ['t1']);
  });

  test('harness exit clears an idle chat approval, retracts its notification and keeps queued input', () => {
    for (const kind of ['codex', 'claude', 'acp:kimi']) {
      const retracted: string[] = [];
      const { c, s, state, chats, crashes, execs } = setup({ retract: (id) => retracted.push(id) });
      const id = kind === 'codex' ? 'idle-approval' : `${kind}:idle-approval`;
      chats.ensure(id);
      state.patch(id, { queue: [{ id: 'keep', text: 'later', attachments: [], opts: {}, queuedAt: 1, origin: 1 }] });
      c.addApproval(id, { id: 71, method: 'item/commandExecution/requestApproval', params: {} });
      assert.equal(s(id).turn, 'idle');
      if (kind === 'codex') c.onCodexExit();
      else if (kind === 'claude') c.onClaudeEvent({ key: id, kind: 'closed', error: 'gone' });
      else c.onAcpEvent({ key: id, kind: 'closed', error: 'gone' });
      assert.deepEqual(s(id).approvals, []);
      assert.equal(s(id).turn, 'crashed');
      assert.equal(s(id).queue[0].id, 'keep');
      assert.equal(c.crash(id, 'again'), false, 'repeated exit needs no second cleanup');
      assert.deepEqual(retracted, [id]);
      assert.deepEqual(crashes, [id]);
      assert.equal(execs.length, 0);
      state.get('empty');
      assert.equal(c.crash('empty', 'gone'), false);
      assert.equal(s('empty').turn, 'idle');
    }
  });

  test('notification retraction failure cannot interrupt approval cleanup or crash hooks', () => {
    const { c, s, crashes } = setup({
      retract: () => {
        throw new Error('notification gone');
      },
    });
    c.addApproval('idle', { id: 72, method: 'item/commandExecution/requestApproval', params: {} });
    assert.doesNotThrow(() => c.crash('idle', 'closed'));
    assert.equal(s('idle').turn, 'crashed');
    assert.deepEqual(s('idle').approvals, []);
    assert.deepEqual(crashes, ['idle']);
  });

  test('the app-server dying mid-turn: crashed with the reason, cards gone, tool calls stopped, queue kept', () => {
    const { c, s, crashes } = setup();
    c.send('t1', { text: 'first' }, 1);
    c.send('t1', { text: 'queued', opts: { plan: true } }, 1);
    c.onCodexMessage(codex('item/fileChange/requestApproval', { threadId: 't1' }, 5));
    // a chat that wasn't mid-turn isn't crashed
    c.state.get('idle-chat');
    c.onCodexExit();
    assert.equal(s('t1').turn, 'crashed');
    assert.equal(s('t1').crashed, 'Codex quit while working. Pending approvals were cancelled · Your queued messages are kept');
    assert.equal(s('t1').crashed, crashText('codex'));
    assert.deepEqual(s('t1').approvals, []);
    assert.equal(s('t1').queue.length, 1);
    assert.deepEqual(s('t1').queue[0].opts, { plan: true });
    assert.deepEqual(crashes, ['t1']);
    assert.equal(s('idle-chat').turn, 'idle');
    // the queue isn't sent by itself; the next message starts a turn as usual
    assert.equal(c.send('t1', { text: 'again' }, 1).action, 'started');
    assert.equal(s('t1').crashed, null);
  });

  test('the app-server dying pauses an active Codex goal, and says which threads to pause once it is back', () => {
    const { c, s, state } = setup();
    state.clientPatch('t1', { goal: { objective: 'ship', status: 'active' } });
    state.clientPatch('t2', { goal: { objective: 'done', status: 'complete' } });
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'goal-round' } }));
    assert.deepEqual(c.onCodexExit(), ['t1']);
    assert.equal(s('t1').goal.status, 'paused');
    assert.equal(s('t1').goal.objective, 'ship');
    assert.equal(s('t2').goal.status, 'complete');
    assert.equal(s('t1').turn, 'crashed');
  });
}

export function registerNotificationCases() {
  test('a finished turn and a waiting approval notify from the controller, with no window', () => {
    const seen: any[] = [];
    const { c } = setup({ notify: (...a: any[]) => seen.push(a) });
    c.send('named', { text: 'go' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 'named', turn: { id: 'n-1' } }));
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'named', turnId: 'n-1' }, 61));
    assert.equal(seen[0][0], 'approval');
    assert.equal(seen[0][1], 'named');
    assert.equal(seen[0][2].title, 'Codex needs your approval');
    assert.equal(seen[0][2].body, 'Named chat');
    // the same request again is not a new notification
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'named', turnId: 'n-1' }, 61));
    assert.equal(seen.length, 1);
    c.onCodexMessage(codex('item/completed', { threadId: 'named', turnId: 'n-1', item: { type: 'agentMessage', text: 'All done.' } }));
    c.onCodexMessage(codex('turn/completed', { threadId: 'named', turn: { id: 'n-1', status: 'completed' } }));
    assert.equal(seen.length, 2);
    assert.deepEqual([seen[1][0], seen[1][2].title, seen[1][2].body, seen[1][2].viewing], ['turn', 'Named chat', 'All done.', false]);
  });

  test('an answered approval retracts its notification; so does the end of the turn', () => {
    const retracted: string[] = [];
    const { c } = setup({ retract: (id: string) => retracted.push(id) });
    c.send('named', { text: 'go' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 'named', turn: { id: 'n-1' } }));
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'named', turnId: 'n-1' }, 61));
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'named', turnId: 'n-1' }, 62));
    c.resolveApproval(61);
    assert.deepEqual(retracted, []);
    c.resolveApproval(62);
    assert.deepEqual(retracted, ['named']);
    c.onCodexMessage(codex('turn/completed', { threadId: 'named', turn: { id: 'n-1', status: 'completed' } }));
    assert.deepEqual(retracted, ['named', 'named']);
  });

  test('an interrupted turn, or one that never started, does not notify', () => {
    const seen: any[] = [];
    const { c } = setup({ notify: (...a: any[]) => seen.push(a) });
    c.send('t1', { text: 'go' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'a' } }));
    c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'a', status: 'interrupted' } }));
    assert.deepEqual(seen, [] as any[]);
    // a turn with no named text says so
    c.send('t2', { text: 'go' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 't2', turn: { id: 'b' } }));
    c.onCodexMessage(codex('turn/completed', { threadId: 't2', turn: { id: 'b', status: 'completed' } }));
    assert.equal(seen.length, 1);
    assert.equal(seen[0][2].body, 'Task complete');
    assert.equal(seen[0][2].title, 'Codex');
  });
}
