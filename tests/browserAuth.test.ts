// The built-in browser's passkeys (electron/capabilities/browser/auth.cjs): Touch ID only in a correctly signed
// package, read without blocking main, and the account chooser's parent window, defaults and cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { browserWorld } = require('./helpers/browser.cjs');
const { BrowserWindows } = require('../electron/capabilities/browser/windows.cjs');
const { PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');
const { configureBrowserAuth } = require('../electron/capabilities/browser/auth.cjs');
const childProcess = require('node:child_process');

function managed() {
  const w = browserWorld();
  const panel = new PanelBrowser({ ...w, open: () => false });
  panel.attach('chat', w.root, w.host);
  const manager = new BrowserWindows({ ...w, onPopup: (opener: any, popup: any) => panel.registerPopup(opener, popup) });
  manager.register(w.root);
  return { ...w, panel, manager };
}

function authWorld(extra: any = {}) {
  const w = managed();
  const session = new EventEmitter();
  const app = { isPackaged: false, configureWebAuthn: (...args: any[]) => configured.push(args), ...extra.app };
  const configured: any[] = [];
  const dialogs: any[] = [];
  let response = 0;
  const dialog = {
    showMessageBox: async (...args: any[]) => {
      dialogs.push(args);
      return { response };
    },
  };
  const frame = { isDestroyed: () => false };
  const options = {
    app,
    session,
    dialog,
    BrowserWindow: w.BrowserWindow,
    webContents: { fromFrame: () => w.root },
    browserWindows: w.manager,
    resourcesPath: '/App/Contents/Resources',
    ...extra,
  };
  const state = configureBrowserAuth(options);
  const select = session.listeners('select-webauthn-account')[0] as Function;
  const details = {
    frame,
    relyingPartyId: 'task.test',
    accounts: [
      { credentialId: 'key-1', displayName: 'Account 1' },
      { credentialId: 'key-2', name: 'Account 2' },
    ],
  };
  return {
    ...w,
    state,
    options,
    frame,
    details,
    select,
    dialogs,
    configured,
    setResponse: (v: number) => {
      response = v;
    },
  };
}

test('WebAuthn enables Touch ID only in supported, packaged, correctly signed apps, read off the event loop', async (t) => {
  let answer: (cb: Function) => void = (cb) => cb(null, 'AB12CD34EF.ai.mopilot.code.webauthn\n');
  const command = t.mock.method(childProcess, 'execFile', (_file: string, _args: string[], _o: any, cb: Function) => {
    setImmediate(() => answer(cb));
  });
  const sync = t.mock.method(childProcess, 'execFileSync', () => {
    throw new Error('main must not wait for plutil');
  });
  let n = 0;
  // each case its own package, so each reads its own Info.plist
  const world = (extra: any) => authWorld({ resourcesPath: `/Touch${n++}.app/Contents/Resources`, ...extra });
  const w = world({ app: { isPackaged: true, configureWebAuthn: t.mock.fn() }, platform: 'darwin' });
  // until plutil answers, a passkey takes the normal path
  assert.equal(w.state.touchId, false);
  assert.deepEqual(Object.keys(w.state), ['touchId'], 'what windows are sent stays plain');
  await w.state.ready;
  assert.equal(w.state.touchId, true);
  assert.match(command.mock.calls[0].arguments[1].at(-1), /Touch0\.app\/Contents\/Info\.plist$/);
  assert.deepEqual(w.options.app.configureWebAuthn.mock.calls[0].arguments, [
    { touchID: { keychainAccessGroup: 'AB12CD34EF.ai.mopilot.code.webauthn', promptReason: 'sign in to $1' } },
  ]);
  // a chat's own browser session in the same package asks nothing again
  const again = authWorld({
    resourcesPath: '/Touch0.app/Contents/Resources',
    app: { isPackaged: true, configureWebAuthn() {} },
    platform: 'darwin',
  });
  await again.state.ready;
  assert.equal(again.state.touchId, true);
  assert.equal(command.mock.callCount(), 1);
  for (const extra of [{ platform: 'win32' }, { app: { isPackaged: true }, platform: 'darwin' }]) {
    const off = world(extra);
    await off.state.ready;
    assert.equal(off.state.touchId, false);
  }
  answer = (cb) => cb(null, 'WRONG.group');
  const wrong = world({ app: { isPackaged: true, configureWebAuthn() {} }, platform: 'darwin' });
  await wrong.state.ready;
  assert.equal(wrong.state.touchId, false);
  answer = (cb) => cb(new Error('unsigned'));
  const unsigned = world({ app: { isPackaged: true, configureWebAuthn() {} }, platform: 'darwin' });
  await unsigned.state.ready;
  assert.equal(unsigned.state.touchId, false);
  assert.equal(sync.mock.callCount(), 0);
});

test('WebAuthn account chooser returns the selected credential, cancels by default and cleans listeners', async () => {
  const w = authWorld();
  const results: any[] = [];
  await w.select({}, w.details, (value: any) => results.push(value));
  assert.deepEqual(results, ['key-1']);
  assert.equal(w.dialogs[0][0], w.parent);
  const config = w.dialogs[0][1];
  assert.deepEqual(config.buttons, ['Account 1', 'Account 2', 'Cancel']);
  assert.equal(config.defaultId, config.cancelId);
  assert.equal(w.root.listenerCount('did-start-navigation'), 1);
  w.setResponse(2);
  await w.select({}, w.details, (value: any) => results.push(value));
  assert.equal(results.at(-1), undefined);
  w.details.accounts = [{ credentialId: 'anonymous' }] as any;
  w.setResponse(0);
  w.wins.delete(w.host);
  await w.select({}, w.details, (value: any) => results.push(value));
  assert.equal(w.dialogs.at(-1).length, 1);
  assert.deepEqual(w.dialogs.at(-1)[0].buttons, ['Saved account', 'Cancel']);
  assert.equal(results.at(-1), 'anonymous');
});

test('WebAuthn chooser hangs on the window showing a view tab, and stands alone while the view is parked', async () => {
  const shownWindow = { id: 'app-window' };
  for (const [viewWindow, expected] of [
    [() => shownWindow, shownWindow],
    [() => null, undefined],
  ] as const) {
    const w = authWorld({ viewWindow });
    await w.select({}, w.details, () => {});
    assert.equal(w.dialogs[0].length, expected ? 2 : 1);
    if (expected) assert.equal(w.dialogs[0][0], expected);
  }
  const other = authWorld({ viewWindow: () => undefined });
  await other.select({}, other.details, () => {});
  assert.equal(other.dialogs[0][0], other.parent);
});

test('WebAuthn cancels missing/unowned frames, empty accounts, failed dialogs and destroyed frames', async () => {
  for (const scenario of ['no-frame', 'foreign', 'empty', 'dialog-error', 'frame-gone', 'callback-error']) {
    const w = authWorld();
    if (scenario === 'no-frame') w.details.frame = null as any;
    if (scenario === 'foreign') w.options.webContents.fromFrame = () => null;
    if (scenario === 'empty') w.details.accounts = [];
    if (scenario === 'dialog-error')
      w.options.dialog.showMessageBox = async () => {
        throw new Error('cancelled');
      };
    if (scenario === 'frame-gone') w.frame.isDestroyed = () => true;
    let calls = 0;
    await w.select({}, w.details, (value: any) => {
      calls++;
      if (scenario === 'callback-error') throw new Error('closed');
      assert.equal(value, undefined);
    });
    assert.equal(calls, 1, scenario);
  }
});

test('WebAuthn popup dialog cancels on main-frame navigation or destruction, including legacy events', async () => {
  for (const scenario of ['navigation', 'legacy-navigation', 'destroyed', 'subframe']) {
    const w = authWorld();
    const popup = w.popup();
    w.root.emit('did-create-window', popup);
    w.options.webContents.fromFrame = () => popup.webContents;
    w.options.dialog.showMessageBox = async (...args: any[]) => {
      assert.equal(args[0], popup);
      if (scenario === 'destroyed') popup.close();
      else if (scenario === 'legacy-navigation') popup.webContents.emit('did-start-navigation', {}, 'https://task.test/new', false, true);
      else popup.webContents.emit('did-start-navigation', { isMainFrame: scenario !== 'subframe' });
      assert.equal(args[1].signal.aborted, scenario !== 'subframe');
      return { response: 0 };
    };
    let selected: any;
    await w.select({}, w.details, (value: any) => {
      selected = value;
    });
    assert.equal(selected, scenario === 'subframe' ? 'key-1' : undefined);
  }
});
