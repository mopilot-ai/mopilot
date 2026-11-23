// The app windows are watched by their recovery (electron/app/windows.cjs → platform/windowRecovery.cjs): a main window and Quick Chat reload when their renderer is gone, a failed load is retried on the window's own page, and a load's rejection is noted rather than left unhandled (#4424).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWindows } = require('../electron/app/windows.cjs');
const { createZoom } = require('../electron/app/zoom.cjs');
const ignored = require('../electron/ignored.cjs');
const { ownsAppWindow, recentWindowProblems, clearWindowProblems } = require('../electron/platform/windowRecovery.cjs');

class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  static getAllWindows = () => FakeWindow.all;
  static getFocusedWindow = () => null;
  static fromWebContents = () => null;
  static fail: Error | null = null;
  loads: any[][] = [];
  destroyed = false;
  webContents: any = Object.assign(new EventEmitter(), {
    id: FakeWindow.all.length + 1,
    reloads: 0,
    setWindowOpenHandler() {},
    send() {},
    isDestroyed: () => false,
    reload() {
      this.reloads++;
    },
  });
  constructor() {
    super();
    FakeWindow.all.push(this);
  }
  show() {}
  showInactive() {}
  hide() {}
  focus() {}
  isVisible = () => false;
  isFocused = () => false;
  isMinimized = () => false;
  isDestroyed = () => this.destroyed;
  load(...a: any[]) {
    this.loads.push(a);
    return FakeWindow.fail ? Promise.reject(FakeWindow.fail) : Promise.resolve();
  }
  loadFile(...a: any[]) {
    return this.load('file', ...a);
  }
  loadURL(...a: any[]) {
    return this.load('url', ...a);
  }
}

/** The webContents each new window gave its right-click menus to (electron/app/contextMenu.cjs). */
let menuAttached: unknown[] = [];

function windows(isDev = false) {
  FakeWindow.all = [];
  menuAttached = [];
  FakeWindow.fail = null;
  clearWindowProblems();
  const live: any = { telemetry: { error() {} } };
  const w = createWindows({
    BrowserWindow: FakeWindow,
    webContents: { fromId: () => null },
    shell: {},
    nativeTheme: { shouldUseDarkColors: false },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    APP_NAME: 'MoPilot',
    isDev,
    isWin: false,
    windowReadiness: { forget() {}, has: () => true, wait: async () => {} },
    live,
    zoom: createZoom({ prefs: () => ({}) }),
    contextMenus: { attach: (wc: unknown) => menuAttached.push(wc) },
  });
  return w;
}

test('a main window and Quick Chat are both recovered when their renderer is gone', () => {
  const w = windows();
  const main = w.createWindow('thread=a');
  assert.equal(ownsAppWindow(main.webContents), true);
  main.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 5 });
  assert.equal(main.webContents.reloads, 1);

  w.toggleMini();
  const quick = FakeWindow.all.at(-1)!;
  assert.notEqual(quick, main);
  assert.deepEqual(quick.loads[0].slice(2), [{ hash: 'mini' }]);
  assert.equal(ownsAppWindow(quick.webContents), true);
  quick.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
  assert.equal(quick.webContents.reloads, 1);
  assert.deepEqual(
    recentWindowProblems().map((p: any) => p.window),
    ['app window', 'Quick Chat'],
  );
  // both kinds of window get the right-click menus
  assert.deepEqual(menuAttached, [main.webContents, quick.webContents]);
});

test("a failed load is tried again on the window's own page, and a load's rejection is noted", async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const w = windows();
    FakeWindow.fail = new Error('ERR_FILE_NOT_FOUND');
    const main = w.createWindow('thread=b');
    await new Promise((r) => setImmediate(r));
    assert.ok(ignored.recentIgnored().some((e: any) => e.context === 'load an app window' && e.message === 'ERR_FILE_NOT_FOUND'));
    main.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
    FakeWindow.fail = null;
    mock.timers.tick(1_000);
    assert.equal(main.loads.length, 2);
    assert.equal(main.loads[1][0], 'file');
    assert.deepEqual(main.loads[1][2], { hash: 'thread=b' });

    // a window opened on no chat loads the page with no hash, again on a retry
    const plain = w.createWindow();
    assert.equal(plain.loads[0][2], undefined);
    plain.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
    mock.timers.tick(1_000);
    assert.equal(plain.loads[1][2], undefined);
  } finally {
    mock.timers.reset();
  }
});

test('in development the dev server page is loaded, with and without a hash', () => {
  const before = process.env.VITE_DEV_SERVER_URL;
  process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173/';
  try {
    const w = windows(true);
    assert.deepEqual(w.createWindow('thread=c').loads[0], ['url', 'http://localhost:5173/#thread=c']);
    assert.deepEqual(w.createWindow().loads[0], ['url', 'http://localhost:5173/']);
  } finally {
    if (before === undefined) delete process.env.VITE_DEV_SERVER_URL;
    else process.env.VITE_DEV_SERVER_URL = before;
  }
});
