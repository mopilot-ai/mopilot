// Codex adapter titles cases using the shared scripted app-server and session fixtures.
import { mock } from 'node:test';
import { test, assert, thread, setup, settle, require } from './fixture.ts';

const { TITLE_MS } = require('../../../electron/harness/autoTitle.cjs');

export function registerTitleStart() {
  test('the first turn of an unnamed chat gets a title from a hidden helper thread', async () => {
    let started = 0;
    const { a, server, events } = setup({
      'thread/start': () => ({ thread: thread(`helper-${++started}`, { ephemeral: true }) }),
      'turn/start': (p) => {
        if (p.threadId.startsWith('helper'))
          setImmediate(
            () => (
              server.notify('item/completed', { threadId: p.threadId, item: { type: 'agentMessage', text: 'A short title' } }),
              server.notify('turn/completed', { threadId: p.threadId, turn: {} })
            ),
          );
        return { turn: { id: p.threadId.startsWith('helper') ? 'h' : 'turn-1' } };
      },
    });
    await a.startTurn(
      't1',
      { kind: 'codex', id: 't1' },
      { id: 'q', text: 'fix the flaky login test please', attachments: [], opts: {} },
      1,
    );
    // the helper starts with the turn, before the chat's own output (#2150)
    await settle();
    await settle();
    assert.equal(started, 1);
    assert.deepEqual(events.find((x) => x.e.kind === 'threadName')!.e, {
      kind: 'threadName',
      chatId: 't1',
      name: 'fix the flaky login test please',
    });
    const names = server.sent.filter((m) => m.method === 'thread/name/set');
    assert.deepEqual(
      names.map((m) => m.params),
      [{ threadId: 't1', name: 'A short title' }],
    );
    assert.ok(server.methods().includes('thread/unsubscribe'));
    // nothing from the helper reached a window
    assert.equal(
      events.some((x) => x.e.kind === 'notification' && String(x.e.chatId).startsWith('helper')),
      false,
    );
  });
}

export function registerTitleRecovery() {
  test('Codex preserves manual names whether its title helper succeeds or fails, even if they match the provisional title', async () => {
    for (const [name, fails] of [
      ['My title', true],
      ['first prompt', true],
      ['My title', false],
      ['first prompt', false],
    ] as const) {
      const { a, server } = setup({ 'thread/start': () => ({ thread: thread('helper', { ephemeral: true }) }) });
      a.meta.set('t1', { cwd: '/work', name: null });
      let finish!: () => void;
      a.helperTurn = async () =>
        new Promise((resolve, reject) => {
          finish = () => (fails ? reject(new Error('offline')) : resolve('Generated title'));
        });
      const naming = a.autoTitle('t1', 'first prompt');
      await settle();
      await a.threadRename('t1', name);
      finish();
      await naming;
      assert.deepEqual(
        server.sent.filter((m) => m.method === 'thread/name/set').map((m) => m.params.name),
        [name],
      );
      assert.ok(server.methods().includes('thread/unsubscribe'));
    }
  });

  test('a helper thread that starts after the title stopped waiting is let go, not left subscribed', async () => {
    let started!: (r: any) => void;
    const { a, server } = setup({ 'thread/start': () => new Promise((r) => (started = r)) });
    a.meta.set('t1', { cwd: '/work', name: null });
    let turns = 0;
    a.helperTurn = async () => (turns++, 'Late title');
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const naming = a.autoTitle('t1', 'first prompt');
      await settle();
      mock.timers.tick(TITLE_MS);
      await naming;
    } finally {
      mock.timers.reset();
    }
    // the chat kept its provisional title
    assert.deepEqual(
      server.sent.filter((m) => m.method === 'thread/name/set').map((m) => m.params.name),
      ['first prompt'],
    );
    started({ thread: thread('late-helper', { ephemeral: true }) });
    await settle();
    assert.equal(turns, 0);
    assert.deepEqual(
      server.sent.filter((m) => m.method === 'thread/unsubscribe').map((m) => m.params.threadId),
      ['late-helper'],
    );
  });

  test('Codex saves the provisional title when generation fails without a manual rename', async () => {
    const { a, server } = setup({
      'thread/start': () => {
        throw new Error('offline');
      },
    });
    a.meta.set('t1', { cwd: '/work', name: null });
    await a.autoTitle('t1', 'first prompt');
    assert.deepEqual(
      server.sent.filter((m) => m.method === 'thread/name/set').map((m) => m.params),
      [{ threadId: 't1', name: 'first prompt' }],
    );
  });
}

export function registerTitleGate() {
  test('a Codex title helper starts with the turn, and never when turn/start is refused', async () => {
    const helpers = (server: any) => server.sent.filter((m: any) => m.method === 'thread/start').length;
    const send = (a: any) =>
      a.startTurn('t1', { kind: 'codex', id: 't1' }, { id: 'q', text: 'first prompt', attachments: [], opts: {} }, 1);
    // no output and no turn end needed: the title is written beside the turn
    const started = setup({ 'thread/start': () => ({ thread: thread('helper', { ephemeral: true }) }) });
    started.a.helperTurn = async () => 'Generated title';
    await send(started.a);
    await settle();
    assert.equal(helpers(started.server), 1);
    assert.deepEqual(
      started.server.sent.filter((m: any) => m.method === 'thread/name/set').map((m: any) => m.params.name),
      ['Generated title'],
    );
    // turn/start refused: nothing is named
    const refused = setup({
      'turn/start': () => {
        throw new Error('refused');
      },
    });
    assert.equal((await send(refused.a)).started, false);
    await settle();
    assert.equal(helpers(refused.server), 0);
    assert.equal(refused.a.titling.size, 0);
  });

  test('a goal names its new chat at once, and leaves a named chat alone', async () => {
    const goal = (a: any) => a.startGoal('t1', { kind: 'codex', id: 't1' }, { text: '/goal ship it', opts: { goal: 'ship it' } });
    const goalSet = (p: any) => ({ goal: { threadId: p.threadId, objective: 'ship it', status: 'active' } });
    const fresh = setup({ 'thread/goal/set': goalSet, 'thread/start': () => ({ thread: thread('helper', { ephemeral: true }) }) });
    fresh.a.helperTurn = async () => 'Ship it';
    await goal(fresh.a);
    await settle();
    assert.deepEqual(
      fresh.server.sent.filter((m: any) => m.method === 'thread/name/set').map((m: any) => m.params.name),
      ['Ship it'],
    );
    const named = setup({ 'thread/goal/set': goalSet, 'thread/resume': (p: any) => ({ thread: thread(p.threadId, { name: 'Mine' }) }) });
    await goal(named.a);
    await settle();
    assert.equal(named.server.methods().includes('thread/start'), false);
    assert.equal(named.a.titling.size, 0);
    const refused = setup({
      'thread/goal/set': () => {
        throw new Error('no goals');
      },
    });
    await goal(refused.a);
    await settle();
    assert.equal(refused.server.methods().includes('thread/start'), false);
  });
}
