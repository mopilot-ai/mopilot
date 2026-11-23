// The window tools (electron/capabilities/tools/windowTools.cjs): only "self" or a session the caller started, only in
// a window showing the caller (else nothing changes and the model is told why), one request at a time per window, a
// result only for what the window reported, and a new window opened behind the current one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerWindowTools, NOT_ON_SCREEN } = require('../electron/capabilities/tools/windowTools.cjs');

/** A window main can ask: what it was sent, and how its page answers (by default at once, with `answer`). */
function fakeWindow(
  id: number,
  ipcMain: EventEmitter,
  o: { focused?: boolean; answer?: (req: any) => any; hold?: boolean; crashed?: boolean } = {},
) {
  const sent: any[] = [];
  const pending: (() => void)[] = [];
  const wc: any = Object.assign(new EventEmitter(), {
    id,
    isCrashed: () => !!o.crashed,
    send: (channel: string, rid: number, req: any) => {
      sent.push([channel, req]);
      const reply = () => ipcMain.emit(`${channel}:reply`, {}, rid, o.answer ? o.answer(req) : { outcome: 'opened' });
      if (o.hold) pending.push(reply);
      else queueMicrotask(reply);
    },
  });
  return { win: { webContents: wc, isDestroyed: () => false, isFocused: () => !!o.focused }, wc, sent, release: () => pending.shift()?.() };
}

function setup(over: Record<string, any> = {}) {
  const ipcMain = new EventEmitter();
  const viewedBy = new Map<number, any>();
  // a window's view as app:viewing records it (electron/session/viewing.cjs parseView)
  const show = (id: number, visible: string[]) => viewedBy.set(id, { visible, primary: visible[0] ?? null, focused: visible[0] ?? null });
  const wins: any[] = [];
  const created: any[] = [];
  // top started kid, kid started grandkid; other is another family's chat
  const parents: Record<string, string> = { kid: 'top', grandkid: 'kid' };
  const journal: any = {
    child: (id: string) => (parents[id] ? { parentId: parents[id], name: id === 'kid' ? 'kid-handle' : id } : undefined),
    childrenOf: (p: string) => Object.keys(parents).filter((c) => parents[c] === p),
  };
  const r = new Registry();
  r.setApprover(async () => true);
  const dispose = registerWindowTools(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    journal: () => (over.noJournal ? null : journal),
    viewedBy,
    windows: () => wins,
    createWindow: (hash: string, opts: any) => created.push([hash, opts]),
    ipcMain,
    replyMs: over.replyMs ?? 1000,
  });
  const call = async (tool: string, args: any, chat = 'top') => {
    const res = await r.invoke(chat, 'seg', tool, args);
    return res.ok ? JSON.parse(res.content[0].text) : { error: res.error };
  };
  return { r, ipcMain, viewedBy, show, wins, created, call, dispose };
}

test('the tools: names, policies, and who may be named', async () => {
  const t = setup();
  assert.deepEqual(
    t.r.list().map((x: any) => [x.name, x.policy]),
    [
      ['open_session_in', 'act'],
      ['close_split', 'act'],
      ['get_window_layout', 'observe'],
      ['set_sidebar_collapsed', 'act'],
    ],
  );
  const w = fakeWindow(1, t.ipcMain, {
    answer: (req) => ({ outcome: req.chatId === 'kid' || req.chatId === 'grandkid' || req.chatId === 'top' ? 'opened' : 'x' }),
  });
  t.wins.push(w.win);
  t.show(1, ['top']);
  // self, a child by id or by name, a grandchild
  for (const id of ['self', 'kid', 'kid-handle', 'grandkid', 'top'])
    assert.equal((await t.call('open_session_in', { session_id: id, target: 'split' })).outcome, 'opened', id);
  assert.deepEqual(
    w.sent.map(([ch, req]) => [ch, req.op, req.caller, req.chatId]),
    [
      ['window:layout', 'split', 'top', 'top'],
      ['window:layout', 'split', 'top', 'kid'],
      ['window:layout', 'split', 'top', 'kid'],
      ['window:layout', 'split', 'top', 'grandkid'],
      ['window:layout', 'split', 'top', 'top'],
    ],
  );
  // another family's chat, the caller's own parent, or an unknown name: refused, with how the user opens it
  for (const id of ['other', 'nope']) {
    const out = await t.call('open_session_in', { session_id: id, target: 'split' });
    assert.equal(out.error.code, 'not_linked');
    assert.match(out.error.message, /Open in → Split view/);
  }
  t.show(1, ['kid']);
  assert.equal((await t.call('open_session_in', { session_id: 'top', target: 'split' }, 'kid')).error.code, 'not_linked', 'its parent');
  assert.equal((await t.call('open_session_in', { session_id: 'kid', target: 'nowhere' })).error.code, 'bad_target');
  // the caller is the segment's owner, never an argument
  assert.equal((await t.r.invoke('top', 'other-seg', 'open_session_in', { session_id: 'self', target: 'split' })).error.code, 'no_owner');
  // linked sessions unavailable: only "self" is known
  const u = setup({ noJournal: true });
  assert.equal((await u.call('open_session_in', { session_id: 'kid', target: 'split' })).error.code, 'not_linked');
  t.dispose();
  assert.equal(t.r.list().length, 0);
});

test('only where the caller is on screen: otherwise nothing changes and the model is told not to retry', async () => {
  const t = setup();
  const w = fakeWindow(1, t.ipcMain);
  t.wins.push(w.win);
  t.show(1, ['someone-else']);
  for (const [tool, args] of [
    ['open_session_in', { session_id: 'kid', target: 'split' }],
    ['open_session_in', { session_id: 'kid', target: 'window' }],
    ['close_split', {}],
  ] as const) {
    const out = await t.call(tool, args);
    assert.deepEqual(out, { changed: false, outcome: 'not_on_screen', said: NOT_ON_SCREEN });
  }
  assert.deepEqual(await t.call('get_window_layout', {}), { on_screen: false, said: 'This session is not on screen in any window.' });
  assert.deepEqual(w.sent, []);
  assert.deepEqual(t.created, []);
});

test('the focused window showing the caller is asked; its outcome is the result, with what to do next', async () => {
  const t = setup();
  const back = fakeWindow(1, t.ipcMain, { answer: () => ({ outcome: 'opened' }) });
  const front = fakeWindow(2, t.ipcMain, {
    focused: true,
    answer: (req) =>
      req.op === 'layout'
        ? { outcome: 'layout', layout: { main: { session_id: 'top' }, panes: [], focused: 'main' } }
        : { outcome: 'full' },
  });
  t.wins.push(back.win, front.win);
  t.show(1, ['top']);
  t.show(2, ['top']);
  const out = await t.call('open_session_in', { session_id: 'kid', target: 'split' });
  assert.deepEqual(out, { changed: false, outcome: 'full', said: out.said, session_id: 'kid' });
  assert.match(out.said, /close_split/);
  assert.equal(back.sent.length, 0);
  assert.deepEqual(await t.call('get_window_layout', {}), {
    on_screen: true,
    main: { session_id: 'top' },
    panes: [],
    focused: 'main',
    windows_showing_this_session: 2,
  });
  // focus and close go to the window as asked; close names a pane or leaves it to the window
  await t.call('open_session_in', { session_id: 'kid', target: 'focus' });
  await t.call('close_split', { session_id: 'kid' });
  await t.call('close_split', {});
  assert.deepEqual(
    front.sent.slice(-3).map(([, req]) => [req.op, req.chatId]),
    [
      ['focus', 'kid'],
      ['close', 'kid'],
      ['close', null],
    ],
  );
  // an outcome main has no words for still comes back as itself
  const odd = setup();
  const ow = fakeWindow(1, odd.ipcMain, { answer: () => ({ outcome: 'invalid' }) });
  odd.wins.push(ow.win);
  odd.show(1, ['top']);
  assert.deepEqual(await odd.call('close_split', {}), { changed: false, outcome: 'invalid', said: '' });
});

test('a window that doesn’t answer, answers nonsense or stops never reads as a change', async () => {
  for (const [answer, code] of [
    [() => null, 'no_reply'],
    [() => ({ nope: true }), 'no_reply'],
    [() => 'opened', 'no_reply'],
  ] as const) {
    const t = setup();
    const w = fakeWindow(1, t.ipcMain, { answer });
    t.wins.push(w.win);
    t.show(1, ['top']);
    assert.equal((await t.call('open_session_in', { session_id: 'kid', target: 'split' })).error.code, code);
  }
  // no answer in time
  const slow = setup({ replyMs: 20 });
  const sw = fakeWindow(1, slow.ipcMain, { hold: true });
  slow.wins.push(sw.win);
  slow.show(1, ['top']);
  assert.equal((await slow.call('open_session_in', { session_id: 'kid', target: 'split' })).error.code, 'no_reply');
  // its page crashed: askWindow rejects, and the result says so without the raw error
  const gone = setup();
  const gw = fakeWindow(1, gone.ipcMain, { crashed: true });
  gone.wins.push(gw.win);
  gone.show(1, ['top']);
  const out = await gone.call('open_session_in', { session_id: 'kid', target: 'split' });
  assert.equal(out.error.code, 'window_gone');
  assert.match(out.error.message, /Tell the user/);
});

test('requests to one window go one at a time, in order: each reply belongs to its own call', async () => {
  const t = setup();
  const w = fakeWindow(1, t.ipcMain, { hold: true, answer: (req) => ({ outcome: req.chatId === 'kid' ? 'opened' : 'visible' }) });
  t.wins.push(w.win);
  t.show(1, ['top']);
  const first = t.call('open_session_in', { session_id: 'kid', target: 'split' });
  const second = t.call('open_session_in', { session_id: 'grandkid', target: 'split' });
  await new Promise((r) => setImmediate(r));
  assert.equal(w.sent.length, 1, 'the second waits for the first');
  w.release();
  assert.equal((await first).outcome, 'opened');
  await new Promise((r) => setImmediate(r));
  assert.equal(w.sent.length, 2);
  w.release();
  assert.equal((await second).outcome, 'visible');
  // a failed request doesn't hold the next one
  const f = setup({ replyMs: 10 });
  const fw = fakeWindow(1, f.ipcMain, { hold: true });
  f.wins.push(fw.win);
  f.show(1, ['top']);
  assert.equal((await f.call('close_split', {})).error.code, 'no_reply');
  const next = f.call('close_split', {});
  await new Promise((r) => setImmediate(r));
  fw.release();
  fw.release();
  assert.equal((await next).outcome, 'opened');
});

test('target "window": a window of its own behind the current one, unless a window shows it already', async () => {
  const t = setup();
  const w = fakeWindow(1, t.ipcMain);
  t.wins.push(w.win);
  t.show(1, ['top']);
  assert.equal((await t.call('open_session_in', { session_id: 'acp:kimi:x/1', target: 'window' })).error?.code, 'not_linked');
  const opened = await t.call('open_session_in', { session_id: 'kid', target: 'window' });
  assert.deepEqual(opened, { changed: true, outcome: 'window', said: opened.said, session_id: 'kid' });
  assert.deepEqual(t.created, [['thread=kid', { inactive: true }]]);
  // shown already (here, in a split pane): nothing opens
  t.show(1, ['top', 'kid']);
  assert.equal((await t.call('open_session_in', { session_id: 'kid', target: 'window' })).outcome, 'visible');
  assert.equal(t.created.length, 1);
  assert.deepEqual(w.sent, [], 'a new window needs nothing from this one');
});

test('set_sidebar_collapsed asks the window showing the caller and says only what it reports', async () => {
  const t = setup();
  assert.deepEqual(await t.call('set_sidebar_collapsed', { collapsed: true }), {
    changed: false,
    outcome: 'not_on_screen',
    said: NOT_ON_SCREEN,
  });
  const w = fakeWindow(1, t.ipcMain, { answer: (req) => ({ outcome: req.collapsed ? 'collapsed' : 'unchanged' }) });
  t.wins.push(w.win);
  t.show(1, ['top']);
  const hid = await t.call('set_sidebar_collapsed', { collapsed: true });
  assert.deepEqual([hid.changed, hid.outcome, hid.said], [true, 'collapsed', 'Collapsed the sidebar.']);
  const same = await t.call('set_sidebar_collapsed', { collapsed: false });
  assert.deepEqual([same.changed, same.outcome], [false, 'unchanged']);
  assert.deepEqual(w.sent, [
    ['window:layout', { op: 'sidebar', caller: 'top', chatId: null, collapsed: true }],
    ['window:layout', { op: 'sidebar', caller: 'top', chatId: null, collapsed: false }],
  ]);
  const shown = fakeWindow(2, t.ipcMain, { focused: true, answer: () => ({ outcome: 'expanded' }) });
  t.wins.push(shown.win);
  t.show(2, ['top']);
  assert.equal((await t.call('set_sidebar_collapsed', { collapsed: false })).said, 'Showed the sidebar.');
});
