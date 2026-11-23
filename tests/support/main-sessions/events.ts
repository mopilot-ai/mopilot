// Main session events wiring cases using shared fake timers and main harness.
import { test, assert, loadMain, calls, ready } from './fixture.ts';
import { createRequire } from 'node:module';

const { observeWith } = createRequire(import.meta.url)('../../../shared/observations.cjs');

export function registerEvents() {
  test('item events: to every window (mine for the sender), or only to the window it came from', async () => {
    const h = await ready();
    const codexEmit = h.one('CodexAdapter').opts.emit;
    const [w1] = h.windows;
    await h.invoke('window:open');
    const w2 = h.windows[1];
    assert.equal(codexEmit({ kind: 'x', origin: w2.webContents.id }), true);
    codexEmit({ kind: 'y' });
    assert.deepEqual(w1.webContents.on_('codex:item'), [
      [{ kind: 'x', origin: w2.webContents.id, mine: false }],
      [{ kind: 'y', mine: false }],
    ]);
    assert.deepEqual(w2.webContents.on_('codex:item')[0], [{ kind: 'x', origin: w2.webContents.id, mine: true }]);
    // targeted: windows that registered come first, the origin before the rest
    h.emitIpc('session:ready', w1.webContents);
    h.emitIpc('session:ready', w2.webContents);
    h.emitIpc('session:ready', w2.webContents);
    codexEmit({ kind: 'to2' }, w2.webContents.id);
    codexEmit({ kind: 'any' }, 'any');
    assert.deepEqual(w2.webContents.on_('codex:item').at(-1), [{ kind: 'to2', mine: true }]);
    assert.deepEqual(w1.webContents.on_('codex:item').at(-1), [{ kind: 'any', mine: true }]);
    // Quick Chat never gets them; closed windows are dropped
    await h.invoke('window:mini');
    const mini = h.windows[2];
    h.emitIpc('session:ready', mini.webContents);
    w1.close();
    codexEmit({ kind: 'z' }, 'any');
    assert.deepEqual(w2.webContents.on_('codex:item').at(-1), [{ kind: 'z', mine: true }]);
    // no registered window: the first main window
    w2.close();
    await h.invoke('window:open');
    const w4 = h.windows[3];
    assert.equal(codexEmit({ kind: 'late' }, 'any'), true);
    assert.deepEqual(w4.webContents.on_('codex:item'), [[{ kind: 'late', mine: true }]]);
    w4.close();
    mini.close();
    // whether a window got it: nobody, for a locked chat's message, means main keeps it
    assert.equal(codexEmit({ kind: 'nobody' }, 'any'), false);
    assert.equal(codexEmit({ kind: 'nobody' }), false);
    // a mini window that closed no longer filters
    assert.equal(mini.webContents.on_('codex:item').length, 0);
  });

  test('Claude and ACP events: broadcast, or to one window, saying whether anyone got it', async () => {
    const h = await ready();
    const claudeEmit = h.one('ClaudeAdapter').opts.emit;
    const acpEmit = h.one('AcpTurns').opts.emit;
    const w = h.windows[0];
    assert.equal(claudeEmit({ a: 1 }), true);
    assert.equal(acpEmit({ b: 1 }, 'any'), true);
    assert.deepEqual(w.webContents.on_('claude:event'), [[{ a: 1 }]]);
    assert.deepEqual(w.webContents.on_('acp:event'), [[{ b: 1 }]]);
    // 'shown': an offer someone has to see goes only to app windows on screen
    w.show();
    assert.equal(claudeEmit({ c: 1 }, 'shown'), true);
    assert.deepEqual(w.webContents.on_('claude:event').at(-1), [{ c: 1 }]);
    w.hide();
    assert.equal(claudeEmit({ c: 2 }, 'shown'), false, 'a hidden app window (one Quick Chat keeps) is nobody');
    w.close();
    assert.equal(claudeEmit({ a: 2 }), false);
    assert.equal(claudeEmit({ a: 2 }, 5), false);
    assert.equal(claudeEmit({ a: 2 }, 'shown'), false);
  });
}

export function registerEarlyPublishing() {
  test('session publish before computer use exists only reaches windows', async () => {
    const h = await loadMain({
      before: (h) =>
        (h.mods['electron/session/state.cjs'].SessionStore = h.cls('SessionStore', (o: any) => (o.publish({ early: true }), {}))),
    });
    await h.ready();
    assert.deepEqual(h.windows[0].webContents.on_('session:patch'), [[{ early: true }]], 'the startup window already exists');
  });

  test('session observation reads live state and owners for every harness without blocking window publication', async (test) => {
    const h = await ready();
    const sessions = h.one('SessionStore');
    const controller = h.one('ChatController');
    const facts: any[] = [];
    test.after(observeWith((fact: any) => facts.push(fact)));
    const state = {
      turn: 'running',
      activeTurn: { human: true },
      plan: true,
      goal: null,
      scheduled: null,
      queue: [],
      runningElsewhere: false,
    };
    sessions.get.mock.mockImplementation(() => state);
    const patch = { chatId: 'chat', rev: 1, patch: { plan: true } };
    for (const kind of ['codex', 'claude', 'acp:kimi']) {
      controller.ref.mock.mockImplementation(() => ({ kind, id: 'opaque:id', instance: 'one' }));
      sessions.opts.publish(patch);
      assert.equal(facts.at(-1).harness, kind);
      assert.equal(facts.at(-1).segment, JSON.stringify([kind, 'opaque:id', 'one']));
      assert.equal(facts.at(-1).running, true);
    }
    assert.equal(facts.length, 3);
    const count = () => h.windows[0].webContents.on_('session:patch').length;
    const before = count();
    sessions.get.mock.mockImplementation(() => {
      throw new Error('retired store');
    });
    assert.doesNotThrow(() => sessions.opts.publish(patch));
    sessions.get.mock.mockImplementation(() => state);
    controller.ref.mock.mockImplementation(() => {
      throw new Error('retired owner');
    });
    assert.doesNotThrow(() => sessions.opts.publish(patch));
    assert.equal(count(), before + 2, 'optional read failures preserve both normal window publications');
    assert.equal(facts.length, 3, 'invalid observations are dropped');
  });
}

export function registerPeerPreviews() {
  test('peer notification previews retain Unicode for every sender and recipient harness pair', async () => {
    const h = await ready({
      before: (h: any) => {
        h.mods['electron/session/peerRuntime.cjs'] = {
          PeerRuntime: h.cls('PeerRuntime', () => ({ service: { data: { messages: [] } } })),
        };
      },
    });
    const publish = h.one('PeerRuntime').opts.publish;
    const notifier = h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result;
    const chats = h.one('ChatsStore');
    chats.records = new Map();
    const body = 'x'.repeat(179) + '🙂tail';
    for (const sender of ['codex', 'claude', 'acp']) {
      for (const receiver of ['codex', 'claude', 'acp']) {
        const message = {
          id: `${sender}-${receiver}`,
          sourceChatId: `${sender}-chat`,
          targetChatId: `${receiver}-chat`,
          body,
          delivery: 'delivered',
        };
        publish({ messages: [message] });
        const notice = calls(notifier.notify).at(-1);
        assert.equal(notice[1], message.targetChatId);
        assert.equal(notice[2].body, 'x'.repeat(179));
        assert.equal(notice[2].body.isWellFormed(), true);
        assert.equal(message.body, body, 'the original peer message remains intact');
      }
    }
  });
}
