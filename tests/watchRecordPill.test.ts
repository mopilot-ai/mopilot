// electron/capabilities/watchRecordPill.cjs and watchRecordService.cjs: the recording pill (a capsule with Done and Discard, a clock set by script, left out of
// capture) and the wiring in main (the computer:record* channels, the window that started a recording, the app quitting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RecordPill, pillHtml, updateScript, DONE_URL, DISCARD_URL, SIZE } = require('../electron/capabilities/watchRecordPill.cjs');
const { setupWatchRecord } = require('../electron/capabilities/watchRecordService.cjs');

const MAIL = { bundleId: 'com.apple.mail', name: 'Mail' };

/** The computer-use helper as the recorder uses it: requests it was sent, and events it can emit. */
function fakeHelper() {
  const h: any = Object.assign(new EventEmitter(), {
    calls: [] as string[],
    call: async (method: string) => {
      h.calls.push(method);
      return { ok: true };
    },
  });
  return h;
}

/** Electron's modules as far as the pill uses them. */
function fakeElectron(o: { showFails?: boolean; scriptFails?: boolean } = {}) {
  const log: any[] = [];
  let nav: any = null;
  const win: any = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    setAlwaysOnTop: (...a: any[]) => log.push(['top', ...a]),
    setVisibleOnAllWorkspaces: () => {},
    setContentProtection: (v: boolean) => log.push(['protect', v]),
    setBounds: (b: any) => log.push(['bounds', b]),
    showInactive: () => {
      if (o.showFails) throw new Error('no window server');
      log.push(['show']);
    },
    hide: () => log.push(['hide']),
    destroy: () => (win.destroyed = true),
    loadURL: async (u: string) => log.push(['load', decodeURIComponent(u.replace('data:text/html;charset=utf-8,', ''))]),
    webContents: {
      on: (_e: string, f: any) => (nav = f),
      setWindowOpenHandler: (f: any) => log.push(['open', f().action]),
      executeJavaScript: async (script: string) => {
        log.push(['script', script]);
        if (o.scriptFails) throw new Error('no page');
      },
    },
  };
  const made: any[] = [];
  const electron = {
    BrowserWindow: class {
      constructor(opts: any) {
        made.push(opts);
        return win;
      }
    },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 25, width: 1000, height: 800 } }) },
  };
  return { electron, win, log, made, click: (url: string) => nav({ preventDefault: () => log.push(['prevented']) }, url) };
}

test('RecordPill: a capsule at the top of the work area, excluded from capture; Done and Discard are links; the clock is set by script', async () => {
  const f = fakeElectron();
  const out: string[] = [];
  const notes: string[] = [];
  const pill = new RecordPill({
    electron: f.electron,
    onDone: () => out.push('done'),
    onDiscard: () => out.push('discard'),
    note: (w: string) => notes.push(w),
  });
  assert.equal(pill.available, true);
  pill.update('0:01'); // not shown yet
  pill.show();
  assert.deepEqual(f.log.find((l) => l[0] === 'bounds')[1], { x: Math.round((1000 - SIZE.width) / 2), y: 37, ...SIZE });
  assert.equal(f.made[0].focusable, false);
  assert.deepEqual(
    f.log.filter((l) => l[0] === 'protect'),
    [['protect', true]],
  );
  assert.match(f.log.find((l) => l[0] === 'load')[1], new RegExp(`href="${DONE_URL}"`));
  pill.update('0:12', '5 s left');
  assert.equal(f.log.filter((l) => l[0] === 'script').pop()[1], updateScript('0:12', '5 s left'));
  f.click(DONE_URL);
  f.click(DISCARD_URL);
  f.click('https://elsewhere.invalid/');
  assert.deepEqual(out, ['done', 'discard']);
  // shown again: the same window
  pill.show();
  assert.equal(f.made.length, 1);
  pill.hide();
  f.click(DONE_URL);
  assert.deepEqual(out, ['done', 'discard'], 'a click on a hidden pill is nothing');
  assert.equal(f.log.filter((l) => l[0] === 'hide').length, 1);
  pill.update('0:13');
  assert.equal(f.log.filter((l) => l[0] === 'script').length, 1);
  pill.dispose();
  pill.dispose();
  assert.deepEqual(notes, []);
  assert.match(pillHtml(), /default-src 'none'/);
});

test('RecordPill: a failing window is reported or survived', async () => {
  const f = fakeElectron({ showFails: true, scriptFails: true });
  const notes: string[] = [];
  const pill = new RecordPill({ electron: f.electron, onDone: () => {}, onDiscard: () => {}, note: (w: string) => notes.push(w) });
  assert.throws(() => pill.show(), /no window server/);
  assert.equal(pill.up, false);
  const g = fakeElectron({ scriptFails: true });
  const p = new RecordPill({ electron: g.electron, onDone: () => {}, onDiscard: () => {}, note: (w: string) => notes.push(w) });
  p.show();
  p.update('0:01');
  await new Promise((r) => setImmediate(r));
  g.win.hide = () => {
    throw new Error('gone');
  };
  g.win.destroy = () => {
    throw new Error('gone');
  };
  p.hide();
  p.dispose();
  assert.deepEqual(notes, ['update the recording pill', 'hide the recording pill', 'close the recording pill']);
  assert.equal(new RecordPill({ electron: null, onDone: () => {}, onDiscard: () => {}, note: () => {} }).available, false);
  const destroyed = fakeElectron();
  const d = new RecordPill({ electron: destroyed.electron, onDone: () => {}, onDiscard: () => {}, note: () => {} });
  d.show();
  destroyed.win.destroyed = true;
  d.update('0:01');
  d.hide();
  d.show();
  assert.equal(destroyed.made.length, 2, 'a destroyed window is made again');
});

test('RecordPill: a page that cannot load is noted', async () => {
  const f = fakeElectron();
  f.win.loadURL = async () => {
    throw new Error('no load');
  };
  const notes: string[] = [];
  new RecordPill({ electron: f.electron, onDone: () => {}, onDiscard: () => {}, note: (w: string) => notes.push(w) }).show();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(notes, ['load the recording pill']);
});

test('service: start for a chat, the state, Discard, the recording broadcast to the windows, and the app quitting', async () => {
  const f = fakeElectron();
  const handlers = new Map<string, (...a: any[]) => any>();
  const ipcMain: any = { handle: (c: string, fn: any) => handlers.set(c, fn) };
  const sent: any[] = [];
  const helper = fakeHelper();
  const service = setupWatchRecord({
    ipcMain,
    electron: f.electron,
    helper,
    broadcast: (c: string, p: any) => sent.push([c, p]),
    note: () => {},
  });
  const call = (c: string, ...a: any[]) => handlers.get(c)!({}, ...a);
  assert.deepEqual(await call('computer:recordStart', ''), { ok: false, error: 'No chat to record for' });
  assert.deepEqual(await call('computer:recordStart', 7), { ok: false, error: 'No chat to record for' });
  assert.deepEqual(await call('computer:recordStart', 'c1'), { ok: true });
  assert.equal((await call('computer:recordState')).chatId, 'c1');
  assert.equal(sent[0][0], 'computer:recordChanged');
  helper.emit('record', { t: 5, kind: 'key', app: MAIL, text: 'a' });
  // the pill's Done goes to the recorder
  f.click(DONE_URL);
  await new Promise((r) => setImmediate(r));
  const done = sent.find((s) => s[0] === 'computer:recordDone')[1];
  assert.equal(done.chatId, 'c1');
  assert.equal(done.steps, 1);
  // Discard from a window, and from the pill
  await call('computer:recordStart', 'c2');
  await call('computer:recordDiscard');
  assert.equal((await call('computer:recordState')).recording, false);
  await call('computer:recordStart', 'c3');
  f.click(DISCARD_URL);
  await new Promise((r) => setImmediate(r));
  assert.equal((await call('computer:recordState')).recording, false);
  // quitting
  await call('computer:recordStart', 'c4');
  await service.dispose();
  assert.equal((await call('computer:recordState')).recording, false);
  assert.equal(f.win.destroyed, true);
  // without computer use there is nothing to record with
  const handlers2 = new Map<string, (...a: any[]) => any>();
  setupWatchRecord({
    ipcMain: { handle: (c: string, fn: any) => handlers2.set(c, fn) },
    electron: null,
    helper: fakeHelper(),
    broadcast: () => {},
    note: () => {},
  });
  assert.deepEqual(await handlers2.get('computer:recordStart')!({}, 'c1'), {
    ok: false,
    error: 'Recording is not available in this session',
  });
});

test('service: the recording goes to the window that started it alone; a window that is gone leaves it to all', async () => {
  const f = fakeElectron();
  const handlers = new Map<string, (...a: any[]) => any>();
  const sent: any[] = [];
  const helper = fakeHelper();
  setupWatchRecord({
    ipcMain: { handle: (c: string, fn: any) => handlers.set(c, fn) },
    electron: f.electron,
    helper,
    broadcast: (c: string, p: any) => sent.push(['all', c, p.chatId]),
    note: () => {},
  });
  const mine: any = { destroyed: false, isDestroyed: () => mine.destroyed, send: (c: string, p: any) => sent.push(['mine', c, p.chatId]) };
  await handlers.get('computer:recordStart')!({ sender: mine }, 'c1');
  helper.emit('record', { t: 1, kind: 'key', app: MAIL, text: 'a' });
  f.click(DONE_URL);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    sent.filter((s) => s[1] === 'computer:recordDone'),
    [['mine', 'computer:recordDone', 'c1']],
  );
  await handlers.get('computer:recordStart')!({ sender: mine }, 'c2');
  mine.destroyed = true;
  helper.emit('record', { t: 1, kind: 'key', app: MAIL, text: 'a' });
  f.click(DONE_URL);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.filter((s) => s[1] === 'computer:recordDone').pop(), ['all', 'computer:recordDone', 'c2']);
});
