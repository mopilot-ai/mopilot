// Codex harness turns unit cases with shared server and session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defined, settle, NO_REPLY, thread, setup } from './fixture';

export function registerTurnsCases() {
  test('startTurn: a locked thread keeps the message, another failure is a toast, both to the window that asked', async () => {
    const { a, events } = setup({
      'thread/resume': (p: any) => {
        if (p.threadId === 'locked') throw new Error('thread has an active writer');
        throw new Error('disk');
      },
    });
    assert.deepEqual(await a.startTurn('locked', { kind: 'codex', id: 'locked' }, { text: 'hi' }), { started: false, held: true });
    assert.deepEqual(events.at(-1), { e: { kind: 'locked', chatId: 'locked', item: { text: 'hi' } }, target: 'any' });
    assert.deepEqual(await a.startTurn('t', { kind: 'codex', id: 't' }, { text: 'hi' }, 'win-2'), { started: false, error: 'disk' });
    assert.deepEqual(events.at(-1), {
      e: { kind: 'toast', level: 'error', text: "Couldn't open this chat for writing: disk" },
      target: 'win-2',
    });
  });

  test('startTurn reports the modality the model takes in, and falls back through prefs and config defaults', async () => {
    const models = {
      data: [
        { model: 'vis', inputModalities: ['text', 'image'], isDefault: true },
        { model: 'txt', inputModalities: ['text'] },
        { model: 'none', inputModalities: [] },
      ],
    };
    const { a, state, events } = setup({ 'model/list': () => models, 'config/read': () => ({}) }, { prefs: () => null });
    const ref = (id: string) => ({ kind: 'codex', id });
    await a.startTurn('t', ref('t'), { text: 'hi' });
    await settle();
    assert.equal(state.get('t').modality, 'image');
    assert.equal(state.get('t').permission, 'default');
    const starting = events.find((x) => x.e.kind === 'turnStarting')!.e;
    assert.deepEqual([starting.attachments, starting.opts, starting.origin], [[], {}, null]);
    await a.startTurn('t', ref('t'), { text: 'hi', opts: { model: 'txt' } });
    await settle();
    assert.equal(state.get('t').modality, 'text');
    await a.startTurn('t', ref('t'), { text: 'hi', opts: { model: 'none' } });
    await settle();
    assert.equal(state.get('t').modality, null);
    await a.startTurn('t', ref('t'), { text: 'hi', opts: { model: 'unknown' } });
    await settle();
    assert.equal(state.get('t').modality, null);
  });

  test('startTurn titles only a first message in its own, named-less, lasting thread; a failed start is turnFailed', async () => {
    const { a, events, server } = setup(
      {
        'thread/resume': (p: any) => ({
          thread: thread(p.threadId, p.threadId === 'named' ? { name: 'Mine' } : p.threadId === 'eph' ? { ephemeral: true } : {}),
        }),
        'turn/start': (p: any) => {
          if (p.threadId === 'fail') throw new Error('rate limited');
          return { turn: { id: 'turn-1' } };
        },
        'thread/start': NO_REPLY,
      },
      { segments: { chat: 'seg' }, prefs: () => ({ permission: 'full-access' }) },
    );
    for (const id of ['named', 'eph']) await a.startTurn(id, { kind: 'codex', id }, { text: 'x' });
    await a.startTurn('chat', { kind: 'codex', id: 'seg' }, { text: 'x' });
    assert.equal(a.titling.size, 0);
    assert.equal(a.meta.get('seg').preview, 'x');
    // the meta went away meanwhile: nothing to record the preview on
    a.meta.clear();
    a.hold('gone', null);
    await a.startTurn('gone', { kind: 'codex', id: 'gone' }, { text: 'title me' });
    assert.equal(a.meta.has('gone'), false);
    assert.ok(a.titling.has('gone'));
    assert.deepEqual(await a.startTurn('fail', { kind: 'codex', id: 'fail' }, { text: 'x' }), { started: false, error: 'rate limited' });
    assert.deepEqual(defined(events.at(-1)).e, {
      kind: 'turnFailed',
      chatId: 'fail',
      clientId: defined(events.at(-1)).e.clientId,
      error: 'rate limited',
    });
    assert.equal(server.params('turn/start').at(-1).approvalPolicy, 'never');
  });

  test('startTurn reports a non-Error failure as it is', async () => {
    const tools = {
      setUserServers() {},
      observe() {},
      exited() {},
      outgoing: (m: any) => {
        if (m.method === 'turn/start') throw 'refused';
        if (m.method === 'thread/resume') throw undefined;
        return m;
      },
    };
    const { a, events } = setup({}, { tools });
    a.hold('t', thread('t'));
    await a.startTurn('t', { kind: 'codex', id: 't' }, { text: 'x' });
    assert.equal(defined(events.at(-1)).e.error, 'refused');
    await a.startTurn('u', { kind: 'codex', id: 'u' }, { text: 'x' });
    assert.equal(defined(events.at(-1)).e.text, "Couldn't open this chat for writing: undefined");
  });

  test('steer: no running turn starts one; a refused steer says why and leaves the next turn to the controller', async () => {
    const { a, state, events, server } = setup({
      'turn/steer': () => {
        throw new Error('turn ended');
      },
    });
    assert.deepEqual(await a.steer('t', { kind: 'codex', id: 't' }, { text: 'more' }), { started: true, turnId: 'turn-1' });
    state.patch('t', { activeTurn: { id: 'turn-1' } });
    const before = events.length;
    assert.deepEqual(await a.steer('t', { kind: 'codex', id: 't' }, { text: 'more' }), { started: false, error: 'turn ended' });
    // no toast and no steered message: the ChatController sends it as the next turn
    assert.equal(events.length, before);
    assert.equal(server.params('turn/steer').length, 1);
    const ok = setup({ 'turn/steer': () => ({}) });
    ok.state.patch('t', { activeTurn: { id: 'turn-1' } });
    assert.deepEqual(await ok.a.steer('t', { kind: 'codex', id: 't' }, { text: 'more' }), { started: true });
    assert.deepEqual(defined(ok.events.at(-1)).e.attachments, []);
    const tools = {
      setUserServers() {},
      observe() {},
      exited() {},
      outgoing: (m: any) => {
        if (m.method === 'turn/steer') throw 'refused';
        return m;
      },
    };
    const raw = setup({}, { tools });
    raw.state.patch('t', { activeTurn: { id: 'turn-1' } });
    assert.deepEqual(await raw.a.steer('t', { kind: 'codex', id: 't' }, { text: 'more' }), { started: false, error: 'refused' });
  });

  test('startGoal: locked, unopenable, temporary, refused, and a goal that is not active', async () => {
    const { a, events } = setup({
      'thread/resume': (p: any) => {
        if (p.threadId === 'locked') throw new Error('thread has an active writer');
        if (p.threadId === 'bad') throw new Error('goals feature is disabled');
        return { thread: thread(p.threadId, { ephemeral: p.threadId === 'eph', name: 'n' }) };
      },
      'thread/goal/set': (p: any) => {
        if (p.threadId === 'refused') throw new Error('cannot set on ephemeral thread');
        return {};
      },
    });
    const goal = (id: string, origin: any = null) => a.startGoal(id, { kind: 'codex', id }, { opts: { goal: 'ship' } }, origin);
    assert.deepEqual(await goal('locked', 'w'), { started: false });
    assert.deepEqual(events.at(-1), { e: { kind: 'leaseLocked', chatId: 'locked' }, target: 'w' });
    await goal('locked');
    assert.equal(defined(events.at(-1)).target, 'any');
    await goal('bad');
    assert.equal(defined(events.at(-1)).e.text, "Couldn't set goal: Goals are turned off in Codex settings");
    await goal('eph', 'w');
    assert.deepEqual(events.at(-1), { e: { kind: 'toast', level: 'error', text: "Temporary chats can't have goals" }, target: 'w' });
    await goal('refused');
    assert.equal(defined(events.at(-2)).e.kind, 'goalFailed');
    assert.equal(defined(events.at(-1)).e.text, "Couldn't set goal: Temporary chats can't have goals");
    assert.deepEqual(await goal('ok'), { started: false });
    assert.deepEqual(defined(events.at(-1)).e, { kind: 'goal', chatId: 'ok', goal: null });
    assert.equal(a.titling.size, 0);
  });

  test('startGoal on a thread whose meta is gone still titles it from the objective', async () => {
    const { a } = setup({
      'thread/resume': () => ({}),
      'thread/goal/set': () => ({ goal: { status: 'active' } }),
      'thread/start': NO_REPLY,
    });
    assert.deepEqual(await a.startGoal('t', { kind: 'codex', id: 't' }, { opts: { goal: 'ship it' } }), { started: true });
    assert.ok(a.titling.has('t'));
  });
}
