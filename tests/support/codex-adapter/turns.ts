// Codex adapter turns cases using the shared scripted app-server and session fixtures.
import { test, assert, buildInput, turnParams, thread, setup } from './fixture.ts';

export function registerTurnStarts() {
  test('startTurn: resumes once, sends turn/start to the native thread with the prefs, and reports each step', async () => {
    const { a, server, events, kinds } = setup({}, { segments: { chat1: 'seg2' }, prefs: { model: 'm1', permission: 'read-only' } });
    const item = { id: 'q1', text: 'hello', attachments: [{ kind: 'selection', text: 'sel' }], opts: { plan: true, human: true } };
    const res = await a.startTurn('chat1', { kind: 'codex', id: 'seg2' }, item, 7);
    assert.deepEqual(res, { started: true, turnId: 'turn-1' });
    const start = server.sent.find((m) => m.method === 'turn/start');
    assert.equal(start.params.threadId, 'seg2');
    assert.equal(start.params.model, 'm1');
    assert.deepEqual(start.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(start.params.collaborationMode.mode, 'plan');
    assert.deepEqual(start.params.input, buildInput('hello', item.attachments));
    assert.equal(server.methods().filter((m) => m === 'thread/resume').length, 1);
    assert.deepEqual(
      kinds().filter((k) => k !== 'lease'),
      ['turnStarting', 'turnStarted'],
    );
    const starting = events.find((x) => x.e.kind === 'turnStarting')!.e;
    assert.equal(starting.origin, 7);
    assert.equal(starting.chatId, 'chat1');
    // the window that sent it can tell this turn from the copy of the message it showed early (a switch)
    assert.equal(starting.itemId, 'q1');
    // the lease is held now: the next turn doesn't resume again
    await a.startTurn('chat1', { kind: 'codex', id: 'seg2' }, { ...item, opts: {} }, 7);
    assert.equal(server.methods().filter((m) => m === 'thread/resume').length, 1);
  });

  test('peer input retains journal identity and the recipient sandbox', async () => {
    const { a, server } = setup({}, { segments: { chat1: 'seg2' }, prefs: { model: 'm1', permission: 'read-only' } });
    const receipt = await a.startTurn(
      'chat1',
      { kind: 'codex', id: 'seg2' },
      {
        id: 'peer-id',
        peer: { messageId: 'peer-id', sourceChatId: 'source' },
        text: 'Peer request',
        attachments: [],
        opts: { human: false },
      },
      null,
    );
    const send = server.sent.find((m) => m.method === 'turn/start');
    assert.equal(send.params.threadId, 'seg2');
    assert.equal(send.params.clientUserMessageId, 'peer-id');
    assert.deepEqual(send.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.deepEqual(receipt, { started: true, turnId: 'turn-1', itemId: 'peer-id' });
  });

  test("D-29: each chat's turn uses its own model, effort and Fast; another chat keeps the defaults", async () => {
    const { a, server } = setup(
      {},
      { prefs: { model: 'm1', effort: 'medium' }, config: { chatA: { model: 'm2', effort: 'ultra', serviceTier: 'priority' } } },
    );
    await a.startTurn('chatA', { kind: 'codex', id: 'chatA' }, { id: 'q1', text: 'a', attachments: [], opts: {} });
    await a.startTurn('chatB', { kind: 'codex', id: 'chatB' }, { id: 'q2', text: 'b', attachments: [], opts: {} });
    const starts = server.sent.filter((m) => m.method === 'turn/start').map((m) => m.params);
    assert.deepEqual(
      starts.map((p) => [p.threadId, p.model, p.effort, p.serviceTier]),
      [
        ['chatA', 'm2', 'ultra', 'priority'],
        ['chatB', 'm1', 'medium', null],
      ],
    );
  });

  test('startTurn on a thread another Codex app holds: nothing is sent, the window keeps the message', async () => {
    const { a, server, events } = setup({
      'thread/resume': () => {
        throw new Error('thread has an active writer');
      },
    });
    const item = { id: 'q1', text: 'hi', attachments: [], opts: {} };
    // a window took it: it holds the message, and main doesn't queue it as well (both would send it)
    assert.deepEqual(await a.startTurn('t1', { kind: 'codex', id: 't1' }, item, 3), { started: false, held: true });
    assert.equal(server.methods().includes('turn/start'), false);
    assert.deepEqual(events.at(-1), { e: { kind: 'locked', chatId: 't1', item }, target: 3 });
    // no window to take it: main keeps it
    a.emit = () => false;
    assert.deepEqual(await a.startTurn('t1', { kind: 'codex', id: 't1' }, item, 3), { started: false, held: false });
  });

  test('a failed turn/start is reported, and the turn did not start', async () => {
    const { a, kinds, events } = setup({
      'turn/start': () => {
        throw new Error('bad model');
      },
    });
    const res = await a.startTurn('t1', { kind: 'codex', id: 't1' }, { id: 'q', text: 'x', attachments: [], opts: {} }, 1);
    assert.deepEqual(res, { started: false, error: 'bad model' });
    assert.deepEqual(
      kinds().filter((k) => k !== 'lease'),
      ['turnStarting', 'turnFailed'],
    );
    assert.equal(events.at(-1)!.e.error, 'bad model');
  });
}

export function registerSteering() {
  test('steer goes into the running turn by its id', async () => {
    const { a, server, state, events } = setup();
    state.patch('t1', { turn: 'running', activeTurn: { id: 'turn-9', human: true } });
    await a.steer('t1', { kind: 'codex', id: 't1' }, { text: 'also this', attachments: [], opts: {} }, 1);
    const s = server.sent.find((m) => m.method === 'turn/steer');
    assert.equal(s.params.expectedTurnId, 'turn-9');
    assert.equal(events.at(-1)!.e.kind, 'steered');
  });

  test("a steer answered in the same read as the turn's end: the windows hear the app-server's copy first, under the id the steer gave it", async () => {
    const { a, server, state, events } = setup({ 'turn/steer': () => ({ turnId: 'turn-9' }) });
    state.patch('t1', { turn: 'running', activeTurn: { id: 'turn-9', human: true } });
    // main reads the app-server's stdout a chunk at a time and handles every line in it at once; under load
    // the steer's answer and the turn's last notifications come in one chunk
    const emit = server.emit;
    server.emit = (e: any) => {
      emit(e);
      if (e.msg?.result?.turnId !== 'turn-9') return;
      const clientId = server.sent.find((m) => m.method === 'turn/steer').params.clientUserMessageId;
      const user = { type: 'userMessage', id: 'srv-user', clientId, content: [{ type: 'text', text: 'also this', text_elements: [] }] };
      const reply = { type: 'agentMessage', id: 'srv-reply', text: 'fake-codex: also this', phase: null };
      emit({ kind: 'message', msg: { method: 'item/completed', params: { threadId: 't1', turnId: 'turn-9', item: user } } });
      emit({ kind: 'message', msg: { method: 'item/completed', params: { threadId: 't1', turnId: 'turn-9', item: reply } } });
      emit({
        kind: 'message',
        msg: { method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn-9', status: 'completed', items: [] } } },
      });
    };
    assert.deepEqual(await a.steer('t1', { kind: 'codex', id: 't1' }, { text: 'also this', attachments: [], opts: { human: true } }, 1), {
      started: true,
    });
    const seen = events.filter((x) => x.e.kind === 'notification' || x.e.kind === 'steered').map((x) => x.e.method ?? x.e.kind);
    assert.deepEqual(seen, ['item/completed', 'item/completed', 'turn/completed', 'steered']);
    const sent = server.sent.find((m) => m.method === 'turn/steer').params;
    assert.match(sent.clientUserMessageId, /^[0-9a-f-]{36}$/);
    assert.equal(events.at(-1)!.e.clientId, sent.clientUserMessageId);
  });

  test('peer steer uses the stable journal id and records the actual native acceptance', async () => {
    const { a, server, state, events } = setup({ 'turn/steer': () => ({ turnId: 'turn-9' }) });
    state.patch('t1', { turn: 'running', activeTurn: { id: 'turn-9', human: false } });
    const result = await a.steer(
      't1',
      { kind: 'codex', id: 't1' },
      {
        text: 'Peer input',
        attachments: [],
        opts: { human: false },
        peer: { messageId: 'peer-steer' },
      },
      null,
    );
    assert.deepEqual(result, { started: true, turnId: 'turn-9', itemId: 'peer-steer' });
    const input = server.sent.find((m) => m.method === 'turn/steer').params;
    assert.equal(input.clientUserMessageId, 'peer-steer');
    assert.equal(input.expectedTurnId, 'turn-9');
    assert.equal(events.at(-1)!.e.clientId, 'peer-steer');
    assert.equal(state.get('t1').activeTurn.human, false);
  });
}

export function registerTurnContext() {
  test('turnParams: a handoff prefix leads the input; plan mode falls back to the config model', () => {
    const p = turnParams(
      'n1',
      'c1',
      { text: 'go', attachments: [], opts: { plan: true, prefix: '<sage-handoff/>' } },
      { permission: 'full-access' },
      '/w',
      { model: 'cfg', effort: 'low' },
    );
    assert.equal(p.input[0].text, '<sage-handoff/>\n\ngo');
    assert.deepEqual(p.collaborationMode.settings, { model: 'cfg', reasoning_effort: 'low', developer_instructions: null });
    assert.deepEqual(p.sandboxPolicy, { type: 'dangerFullAccess' });
    assert.equal(p.approvalPolicy, 'never');
    // out of plan mode the turn says default, so the thread doesn't stay in plan mode (D-13)
    const d = turnParams('n1', 'c1', { text: 'go', attachments: [], opts: {} }, { model: 'm2', effort: 'high' }, '/w', {
      model: 'cfg',
      effort: 'low',
    });
    assert.deepEqual(d.collaborationMode, {
      mode: 'default',
      settings: { model: 'm2', reasoning_effort: 'high', developer_instructions: null },
    });
  });

  test("the Plan chip follows thread/settings/updated and a resumed thread's mode", async () => {
    const { a, server, state } = setup(
      { 'thread/resume': (p) => ({ thread: thread(p.threadId), collaborationMode: { mode: 'plan', settings: {} } }) },
      { segments: { chat1: 'seg2' } },
    );
    state.get('chat1');
    await a.ensureResumed('seg2');
    assert.equal(state.get('chat1').plan, true);
    server.notify('thread/settings/updated', {
      threadId: 'seg2',
      threadSettings: { collaborationMode: { mode: 'default', settings: {} } },
    });
    assert.equal(state.get('chat1').plan, false);
    // an earlier segment's thread isn't the chat's mode any more
    server.notify('thread/settings/updated', { threadId: 'chat1', threadSettings: { collaborationMode: { mode: 'plan', settings: {} } } });
    assert.equal(state.get('chat1').plan, false);
    // a chat no window follows isn't created by it
    server.notify('thread/settings/updated', { threadId: 'other', threadSettings: { collaborationMode: { mode: 'plan', settings: {} } } });
    assert.equal(state.has('other'), false);
  });

  test('a compaction the user asked for is marked manual; one inside a normal turn is not', async () => {
    const { a, server, events } = setup({}, { segments: { chat1: 'seg2' } });
    await a.leased('chat1', 'thread/compact/start');
    server.notify('turn/started', { threadId: 'seg2', turn: { id: 'tc' } });
    const item = { type: 'contextCompaction', id: 'c1' };
    server.notify('item/completed', { threadId: 'seg2', turnId: 'tc', item });
    server.notify('turn/completed', { threadId: 'seg2', turn: { id: 'tc', items: [item] } });
    server.notify('turn/started', { threadId: 'seg2', turn: { id: 't2' } });
    server.notify('item/completed', { threadId: 'seg2', turnId: 't2', item: { type: 'contextCompaction', id: 'c2' } });
    const n = events.filter((x) => x.e.kind === 'notification').map((x) => x.e);
    assert.equal(n.find((e) => e.method === 'item/completed' && e.params.turnId === 'tc').params.item.trigger, 'manual');
    assert.equal(n.find((e) => e.method === 'turn/completed').params.turn.items[0].trigger, 'manual');
    assert.equal(n.find((e) => e.method === 'item/completed' && e.params.turnId === 't2').params.item.trigger, undefined);
  });
}
