// The app's windows after a stealth restart (electron/app/windows.cjs): restored without focus, kept there by the launch's own activate for a moment, and every window counted for focus and full screen.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWindows } = require('../electron/app/windows.cjs');
const { createZoom } = require('../electron/app/zoom.cjs');

let focused: any = null;
class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  static getAllWindows = () => FakeWindow.all;
  static getFocusedWindow = () => focused;
  static fromWebContents = () => null;
  calls: string[] = [];
  visible = false;
  full = false;
  destroyed = false;
  webContents: any = Object.assign(new EventEmitter(), {
    id: FakeWindow.all.length + 1,
    setWindowOpenHandler() {},
    send() {},
    isDestroyed: () => false,
  });
  constructor() {
    super();
    FakeWindow.all.push(this);
  }
  show() {
    this.calls.push('show');
    this.visible = true;
  }
  showInactive() {
    this.calls.push('showInactive');
    this.visible = true;
  }
  minimize() {
    this.calls.push('minimize');
  }
  focus() {
    this.calls.push('focus');
  }
  restore() {}
  isMinimized = () => false;
  isVisible = () => this.visible;
  isDestroyed = () => this.destroyed;
  isFullScreen = () => this.full;
  loadFile() {}
  loadURL() {}
  setBounds() {}
}

function windows() {
  FakeWindow.all = [];
  return createWindows({
    BrowserWindow: FakeWindow,
    webContents: { fromId: () => null },
    shell: {},
    nativeTheme: { shouldUseDarkColors: false },
    screen: {},
    APP_NAME: 'MoPilot',
    isDev: false,
    isWin: false,
    windowReadiness: { forget() {}, has: () => true, wait: async () => {} },
    live: {},
    zoom: createZoom({ prefs: () => ({}) }),
  });
}

test('a restored visible window shows immediately without a paint event or focus', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const w = windows();
    const win = w.createWindow(undefined, { restore: { visible: true, minimized: false } });
    assert.deepEqual(win.calls, ['showInactive']);
    mock.timers.tick(2500);
    assert.deepEqual(win.calls, ['showInactive']);
    // A hidden restore remains hidden even when paint arrives or time passes.
    const hidden = w.createWindow(undefined, { restore: { visible: false, minimized: false } });
    hidden.emit('ready-to-show');
    mock.timers.tick(2500);
    assert.deepEqual(hidden.calls, []);
  } finally {
    mock.timers.reset();
  }
});

test("the launch's own activate does not bring a restored window forward; a later one does", () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const w = windows();
    const win = w.createWindow(undefined, { restore: { visible: false, minimized: false } });
    assert.equal(w.showMainWindow(), win);
    assert.deepEqual(win.calls, [], 'stays as it was');
    mock.timers.tick(3000);
    w.showMainWindow();
    assert.deepEqual(win.calls, ['show', 'focus'], 'the user asking for it later gets it');
  } finally {
    mock.timers.reset();
  }
});

test('focus and full screen count every window the app has', () => {
  const w = windows();
  const a = w.createWindow();
  const popup = new FakeWindow();
  assert.equal(w.anyFocused(), false);
  focused = popup;
  assert.equal(w.anyFocused(), true, 'an in-app browser sign-in popup counts');
  focused = null;
  assert.equal(w.anyFullScreen(), false);
  popup.full = true;
  assert.equal(w.anyFullScreen(), true);
  popup.destroyed = true;
  assert.equal(w.anyFullScreen(), false, 'a window already gone does not');
  assert.ok(a);
});

test('an inactive window (an agent opening a session in its own window) shows behind, and the main window still comes forward', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const w = windows();
    const main = w.createWindow(undefined);
    const behind = w.createWindow('thread=kid', { inactive: true });
    assert.deepEqual(behind.calls, ['showInactive']);
    behind.emit('ready-to-show');
    assert.deepEqual(behind.calls, ['showInactive'], 'paint cannot show it again');
    // Each new inactive window is visible immediately too.
    const late = w.createWindow('thread=kid2', { inactive: true });
    assert.deepEqual(late.calls, ['showInactive']);
    mock.timers.tick(2500);
    assert.deepEqual(late.calls, ['showInactive']);
    // no settle window as after a restart: the user asking for the app gets it at once
    main.calls.length = 0;
    w.showMainWindow();
    assert.deepEqual(main.calls, ['show', 'focus']);
  } finally {
    mock.timers.reset();
  }
});
