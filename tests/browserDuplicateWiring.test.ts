// Actual browser IPC and bridge wiring enforces the native page/chat authority for guests and views.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, FakeWC } from './support/browser-view-fixture.ts';
const require = createRequire(import.meta.url);
for (const path of ['browserData', 'browserImport', 'browserLogins'])
  mock.module(`../electron/app/ipc/${path}.cjs`, { namedExports: { register: () => {} } });
mock.module('../electron/capabilities/browser/userFill.cjs', { namedExports: { touchIdConfirm: () => () => true } });
mock.module('../electron/capabilities/nativeAvailability.cjs', { namedExports: { vendorChromeProfile: () => '' } });
mock.module('../electron/capabilities/browser/openSite.cjs', { namedExports: { openSiteForRoute: () => {} } });
mock.module('../electron/capabilities/browser/userChrome.cjs', { namedExports: { openInChrome: () => {} } });
const { register } = require('../electron/app/ipc/browser.cjs');
const bridge = require('../electron/bridge/browser.cjs');

function wiring() {
  const h = setup();
  const guest = new FakeWC({}, h.sessions.get('persist:browser'));
  // Create once to configure the fake panel session used by the real target guard.
  const entry = h.views.create({ url: 'about:blank' });
  guest.session = entry.wc.session;
  (guest as any).hostWebContents = h.sender;
  guest.getType = () => 'webview';
  const all = new Map([
    [guest.id, guest],
    [entry.id, entry.wc],
  ]);
  const handlers = new Map<string, Function>();
  let driver: any = undefined;
  const live: any = {
    paneViews: h.views,
    browserTabs: { driver: () => driver },
    controller: { chatOf: (id: string) => (id === 'native' ? 'chat' : id) },
  };
  register(
    { handle: (channel: string, fn: Function) => handlers.set(channel, fn) },
    {
      live,
      webContents: { fromId: (id: number) => all.get(id) ?? h.views.entryOf(id)?.wc, getAllWebContents: () => [...all.values()] },
      panelSessions: () => [entry.wc.session],
      app: { getPath: () => '/unused' },
      systemPreferences: {},
      registerAnnotateCapture: () => {},
    },
  );
  const call = (name: string, ...args: any[]) => handlers.get(`browser:${name}`)!({ sender: h.sender }, ...args);
  return {
    ...h,
    entry,
    guest,
    live,
    call,
    driver: (value: any) => {
      driver = value;
    },
  };
}

test('the production IPC admits owned guests and bound views, rejects foreign views and follows native stable chat ownership', () => {
  const h = wiring();
  assert.equal(h.call('bindPane', 'guest', h.guest.id, 'native'), true);
  assert.throws(() => h.call('bindPane', 'view', h.entry.id, 'native'), /another window/);
  h.views.bind('view', h.sender, { chat: 'chat' });
  // Bind the already-created entry directly, as an adopted popup would.
  h.views.name(h.entry, 'view');
  h.entry.binders.add(h.sender);
  h.entry.chat = 'chat';
  assert.equal(h.call('bindPane', 'view', h.entry.id, 'native'), true);
  assert.throws(() => h.call('bindPane', 'foreign', h.entry.id, 'other'), /no longer available/);
  h.entry.chat = null;
  assert.throws(() => h.call('bindPane', 'claimed-view', h.entry.id, 'other'));
  assert.throws(() => h.call('captureHistory', 'view', 'copy'));
  h.driver({ chatId: 'native' });
  assert.equal(h.call('bindPane', 'guest', h.guest.id, 'chat'), true);
  h.driver({ chatId: 'other' });
  assert.throws(() => h.call('captureHistory', 'guest', 'new'), /no longer available/);
  h.driver(undefined);
  h.live.browserTabs = undefined;
  h.live.paneViews = undefined;
  const other = new FakeWC();
  (other as any).hostWebContents = h.sender;
  h.call('stopLoading', h.guest.id);
  assert.deepEqual(h.guest.calls, ['stop']);
  assert.throws(() => h.call('stopLoading', 999), /gone/);
});

test('the bridge forwards every new operation with exact argument counts', () => {
  for (const [method, count] of [
    ['bindPane', 3],
    ['captureHistory', 2],
    ['restoreHistory', 2],
    ['discardHistory', 1],
    ['stopLoading', 1],
  ] as const)
    assert.deepEqual(bridge[method], { kind: 'invoke', channel: `browser:${method}`, params: count });
});

test('production capture reserves a fresh view in the source session before its first load and refuses existing pane names', async () => {
  const h = wiring();
  h.call('bindPane', 'guest', h.guest.id, 'native');
  Object.assign(h.guest.navigationHistory, { getAllEntries: () => [{ url: 'https://a.test/', title: 'A' }], getActiveIndex: () => 0 });
  const snapshot = h.call('captureHistory', 'guest', 'new-copy');
  const entry = h.views.panes.get('new-copy');
  assert.ok(entry);
  assert.equal(entry.chat, 'chat');
  assert.equal(entry.wc.session, h.guest.session);
  assert.deepEqual(entry.wc.calls, []);
  assert.ok(entry.binders.has(h.sender));
  // Electron 44: the history is written at once; the promise is the page's load, still running here
  let restored: any = { entries: [{ url: '' }], index: 0 };
  Object.assign(entry.wc.navigationHistory, {
    length: () => restored.entries.length,
    getActiveIndex: () => restored.index,
    getEntryAtIndex: (i: number) => restored.entries[i],
    restore: (state: any) => {
      restored = state;
      return new Promise(() => {});
    },
  });
  assert.equal(await h.call('restoreHistory', snapshot.token, 'new-copy'), true);
  assert.equal(restored.entries[0].url, 'https://a.test/');
  assert.equal(entry.wc.destroyed, false);
  const untouched = h.views.bind('occupied', h.sender, { url: 'about:blank' });
  assert.throws(() => h.call('captureHistory', 'guest', 'occupied'), /already exists/);
  assert.equal(h.views.entryOf(untouched.id).wc.destroyed, false);
  h.views.closed.add('closed');
  assert.throws(() => h.call('captureHistory', 'guest', 'closed'), /already exists/);
  h.views.bind = () => null;
  assert.throws(() => h.call('captureHistory', 'guest', 'refused'), /Could not create/);
  assert.equal(h.views.panes.has('refused'), false);
  h.live.paneViews = null;
  assert.throws(() => h.call('captureHistory', 'guest', 'uninitialized'), /not available yet/);
});
