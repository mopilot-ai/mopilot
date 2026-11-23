// createExitGate's wiring in electron/platform/exitGate.cjs: asking a window or a native dialog,
// counting with failing lookups, and pausing goals with whatever adapters are present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { createExitGate, askWindow, summarize, codexBackground } = require('../electron/platform/exitGate.cjs');

function fakeWindow(answer: (id: number, ipc: EventEmitter) => void) {
  const ipc = new EventEmitter();
  const wc = Object.assign(new EventEmitter(), {
    sent: [] as any[],
    send: (ch: string, id: number, payload: any) => {
      wc.sent.push([ch, payload]);
      answer(id, ipc);
    },
  });
  const win = { shown: 0, focused: 0, show: () => win.shown++, focus: () => win.focused++, webContents: wc };
  return { ipc, wc, win };
}

const states: Record<string, any> = {
  run: { turn: 'running', goal: { status: 'active' } },
};

function gate(o: any) {
  return createExitGate({
    ipcMain: o.ipc ?? new EventEmitter(),
    dialog: o.dialog ?? {},
    window: () => o.win ?? null,
    sessions: () => ({ all: () => ['run', 'missing'], get: (id: string) => states[id] }),
    controller: () => ({ ref: (id: string) => ({ kind: 'codex', key: id }) }),
    codex: () => o.codex ?? null,
    claude: () => o.claude ?? null,
    claudeTurns: o.claudeTurns,
    prefs: () => o.prefs,
    ...o.override,
  });
}

test('summarize skips chats without state and stringifies a missing objective', () => {
  const s = summarize({ chats: ['run', 'missing'], get: (id: string) => states[id], kindOf: () => 'codex' });
  assert.deepEqual(s, { turns: ['run'], background: 0, goals: [{ chatId: 'run', kind: 'codex', objective: '' }] });
});

test('codexBackground counts terminals from data or terminals, 0 for odd answers', async () => {
  const replies: Record<string, any> = { a: { terminals: [1, 2] }, b: null, c: { data: [1] } };
  const codex = {
    leases: new Map([
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]),
    request: async (_m: string, { threadId }: any) => replies[threadId],
  };
  assert.equal(await codexBackground(codex), 3);
});

test('a window answers the confirm dialog; the default setting asks only when something would stop', async () => {
  const { ipc, wc, win } = fakeWindow((id, ipc) =>
    setImmediate(() => {
      ipc.emit('exitGate:confirm:reply', {}, id + 1000, false);
      ipc.emit('exitGate:confirm:reply', {}, id, true);
    }),
  );
  const g = gate({ ipc, win, prefs: undefined, codex: { pauseAllActiveGoals: async () => 'paused-all', leases: new Map() } });
  assert.equal(await g.request('update'), true);
  assert.equal(win.shown, 1);
  assert.equal(win.focused, 1);
  assert.deepEqual(wc.sent, [
    [
      'exitGate:confirm',
      { reason: 'update', text: '1 turn and 1 goal will stop. Goals are paused, not lost.', turns: 1, background: 0, goals: 1 },
    ],
  ]);
  assert.equal(ipc.listenerCount('exitGate:confirm:reply'), 0);
});

test('a window that closes before answering keeps the app open', async () => {
  const { ipc, wc, win } = fakeWindow(() => setImmediate(() => wc.emit('destroyed')));
  const g = gate({ ipc, win, prefs: { confirmClose: 'always' } });
  assert.equal(await g.request(), false);
  assert.equal(ipc.listenerCount('exitGate:confirm:reply'), 0);
  assert.equal(wc.listenerCount('destroyed'), 0);
});

test('askWindow times out to null when given a limit', async () => {
  const { ipc, wc } = fakeWindow(() => {});
  assert.equal(await askWindow(ipc, wc, 'ch', {}, 5), null);
  assert.equal(ipc.listenerCount('ch:reply'), 0);
});

test('without a window, a native dialog asks: Quit or Restart Now, detail only when something stops', async () => {
  const shown: any[] = [];
  let response = 1;
  const dialog = { showMessageBox: async (o: any) => (shown.push(o), { response }) };
  assert.equal(
    await gate({ dialog, prefs: { confirmClose: 'always' }, override: { sessions: () => ({ all: () => [], get: () => null }) } }).request(
      'quit',
    ),
    false,
  );
  assert.equal(shown[0].message, 'Quit MoPilot?');
  assert.deepEqual(shown[0].buttons, ['Quit', 'Cancel']);
  assert.equal(shown[0].detail, undefined);
  response = 0;
  const leased: any[] = [];
  const codex = { leases: new Map(), leased: (id: string, m: string, p: any) => (leased.push([id, m, p]), Promise.reject(new Error('x'))) };
  assert.equal(await gate({ dialog, prefs: { confirmClose: 'always' }, codex }).request('update'), true);
  assert.equal(shown[1].message, 'Restart to update?');
  assert.deepEqual(shown[1].buttons, ['Restart Now', 'Cancel']);
  assert.match(shown[1].detail, /will stop/);
  assert.deepEqual(leased, [['run', 'thread/goal/set', { status: 'paused' }]]);
});

test('lookups that throw count as unknown harness and no loops; a Claude without scheduled is 0', async () => {
  let throwRef = true;
  const g = gate({
    prefs: { confirmClose: 'never' },
    claude: {},
    override: {
      controller: () => ({
        ref: (id: string) => {
          if (throwRef) throw new Error('no chat');
          return { kind: 'claude', key: id };
        },
      }),
    },
  });
  const s = await g.collect();
  assert.deepEqual(s.goals, [{ chatId: 'run', kind: null, objective: '' }]);
  assert.equal(s.background, 0);
  throwRef = false;
  // Claude goals with no claudeTurns wired, and no codex: pausing is a no-op
  assert.equal(await g.request(), true);
  const g2 = gate({ prefs: { confirmClose: 'never' }, claude: { scheduled: (key: string) => (key === 'run' ? 2 : undefined) } });
  assert.equal((await g2.collect()).background, 2);
  const g3 = gate({
    prefs: { confirmClose: 'never' },
    claude: {
      scheduled: () => {
        throw new Error('closed');
      },
    },
  });
  assert.equal((await g3.collect()).background, 0);
});

test('Codex goals with no Codex adapter pause nothing and still let the exit through', async () => {
  const g = gate({ prefs: { confirmClose: 'never' } });
  assert.equal(await g.request(), true);
});

test('Claude goals with an adapter-less claudeTurns pause nothing', async () => {
  const g = gate({
    prefs: { confirmClose: 'never' },
    claudeTurns: () => undefined,
    override: { controller: () => ({ ref: (id: string) => ({ kind: 'claude', key: id }) }) },
  });
  assert.equal(await g.request(), true);
});

test('answered confirmations release their destruction listeners without removing unrelated listeners', async () => {
  const { ipc, wc } = fakeWindow((id, ipc) => ipc.emit('ch:reply', {}, id, true));
  const unrelated = () => {};
  ipc.on('ch:reply', unrelated);
  wc.on('destroyed', unrelated);
  for (let i = 0; i < 3; i++) assert.equal(await askWindow(ipc, wc, 'ch', {}, 0), true);
  assert.deepEqual(ipc.listeners('ch:reply'), [unrelated]);
  assert.deepEqual(wc.listeners('destroyed'), [unrelated]);
});

test('confirmation timeouts release the window destruction listener', async () => {
  const { ipc, wc } = fakeWindow(() => {});
  assert.equal(await askWindow(ipc, wc, 'ch', {}, 5), null);
  assert.equal(ipc.listenerCount('ch:reply'), 0);
  assert.equal(wc.listenerCount('destroyed'), 0);
});

test('failed confirmation sends preserve the error and release both listeners', async () => {
  const failure = new Error('webContents destroyed');
  const { ipc, wc } = fakeWindow(() => {
    throw failure;
  });
  await assert.rejects(askWindow(ipc, wc, 'ch', {}, 20), (error) => error === failure);
  assert.equal(ipc.listenerCount('ch:reply'), 0);
  assert.equal(wc.listenerCount('destroyed'), 0);
});

test('a window whose page crashed, crashes while asking, or reloads is not waited on forever', async () => {
  const listeners = (wc: any) => ['destroyed', 'render-process-gone', 'did-start-loading'].map((e) => wc.listenerCount(e));
  // already crashed: send would do nothing, so it isn't relied on
  const crashed = fakeWindow(() => assert.fail('nothing is sent to a crashed page'));
  Object.assign(crashed.wc, { isCrashed: () => true });
  await assert.rejects(askWindow(crashed.ipc, crashed.wc, 'ch', {}, 0), /the window's page has crashed/);
  assert.deepEqual(listeners(crashed.wc), [0, 0, 0]);
  // its page goes while the question waits (no time limit)
  const gone = fakeWindow(() => setImmediate(() => gone.wc.emit('render-process-gone', {}, { reason: 'oom' })));
  await assert.rejects(askWindow(gone.ipc, gone.wc, 'ch', {}, 0), /the window's page stopped \(oom\)/);
  assert.deepEqual(listeners(gone.wc), [0, 0, 0]);
  assert.equal(gone.ipc.listenerCount('ch:reply'), 0);
  const unnamed = fakeWindow(() => setImmediate(() => unnamed.wc.emit('render-process-gone')));
  await assert.rejects(askWindow(unnamed.ipc, unnamed.wc, 'ch', {}, 0), /stopped \(gone\)/);
  // a reload: the new page never got the question
  const reload = fakeWindow(() => setImmediate(() => reload.wc.emit('did-start-loading')));
  await assert.rejects(askWindow(reload.ipc, reload.wc, 'ch', {}, 0), /reloaded/);
  assert.deepEqual(listeners(reload.wc), [0, 0, 0]);
  // so quitting asks with the native dialog instead
  const shown: any[] = [];
  const dialog = { showMessageBox: async (o: any) => (shown.push(o), { response: 0 }) };
  const w = fakeWindow(() => setImmediate(() => w.wc.emit('render-process-gone', {}, { reason: 'crashed' })));
  assert.equal(await gate({ ipc: w.ipc, win: w.win, dialog, prefs: { confirmClose: 'always' } }).request('quit'), true);
  assert.match(shown[0].detail, /The window couldn't ask: the window's page stopped \(crashed\)/);
});

test('a window that cannot show the confirmation hands it to a native dialog that says why', async () => {
  const shown: any[] = [];
  const dialog = { showMessageBox: async (o: any) => (shown.push(o), { response: 1 }) };
  const ipc = new EventEmitter();
  const wc = Object.assign(new EventEmitter(), {
    send: () => {
      throw new Error('Render frame was disposed');
    },
  });
  const win = { show() {}, focus() {}, webContents: wc };
  assert.equal(await gate({ ipc, win, dialog, prefs: { confirmClose: 'always' } }).request('quit'), false);
  assert.equal(shown[0].message, 'Quit MoPilot?');
  assert.equal(
    shown[0].detail,
    "1 turn and 1 goal will stop. Goals are paused, not lost. (The window couldn't ask: Render frame was disposed)",
  );
  const gone = {
    show: () => {
      throw new Error('Object has been destroyed');
    },
    focus() {},
    webContents: wc,
  };
  const empty = { sessions: () => ({ all: () => [], get: () => null }) };
  assert.equal(await gate({ ipc, win: gone, dialog, prefs: { confirmClose: 'always' }, override: empty }).request('update'), false);
  assert.equal(shown[1].message, 'Restart to update?');
  assert.equal(shown[1].detail, "(The window couldn't ask: Object has been destroyed)");
});

test('a native dialog that fails says so in an error box, and the quit goes ahead', async () => {
  const boxes: string[][] = [];
  const dialog = {
    showMessageBox: () => Promise.reject(new Error('no display')),
    showErrorBox: (title: string, body: string) => boxes.push([title, body]),
  };
  const empty = { sessions: () => ({ all: () => [], get: () => null }) };
  assert.equal(await gate({ dialog, prefs: { confirmClose: 'always' }, override: empty }).request('quit'), true);
  assert.equal(await gate({ dialog, prefs: { confirmClose: 'always' }, override: empty }).request('update'), true);
  assert.deepEqual(boxes, [
    ["Couldn't confirm quitting", "MoPilot couldn't ask before quitting (no display), so it goes ahead as you asked."],
    ["Couldn't confirm the restart", "MoPilot couldn't ask before restarting (no display), so it goes ahead as you asked."],
  ]);
});
