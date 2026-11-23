// How main wires what the built-in browser remembers and imports: tabs in the shared profile record their visits (views, popups and legacy
// guests), chat-only partitions do not, Clear browsing data empties history, the agent's search tools get the stores, and the IPC is live.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';

const require = createRequire(import.meta.url);

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);

async function ready(flagsOn = true) {
  const h = await loadMain({
    before: (h) => {
      h.mods['electron/capabilities/browser/hostTools.cjs'] = { registerBrowserTools: mock.fn(), inAppBrowserEnabled: mock.fn(() => true) };
    },
  });
  await h.ready();
  await flush();
  h.mod('platform/flags.cjs').isEnabled.mock.mockImplementation(() => flagsOn);
  return h;
}
const shared = (h: any) => h.electron.session.fromPartition('persist:browser');
const visit = (wc: any, url: string) => wc.emit('did-navigate', {}, url, 200);

test("a pane view in the shared profile records its visits; a chat's own partition does not", async () => {
  const h = await ready();
  const views = h.one('PaneViews');
  const page = h.wc();
  page.session = shared(h);
  views.opts.onCreated(page);
  visit(page, 'https://docs.test/a');
  page.getURL = () => 'https://docs.test/a';
  page.emit('page-title-updated', {}, 'Docs home');
  const private_ = h.wc();
  private_.session = h.electron.session.fromPartition('mopilot-chat-c1-00000000');
  views.opts.onCreated(private_);
  visit(private_, 'https://secret.test/');
  const found = await h.invoke('browser:suggest', 'docs');
  assert.deepEqual(found, [{ kind: 'history', url: 'https://docs.test/a', title: 'Docs home' }]);
  assert.deepEqual(await h.invoke('browser:suggest', 'secret'), []);
});

test('a legacy <webview> guest in the shared profile records its visits too', async () => {
  const h = await ready();
  const host = h.wc({ type: 'webview' });
  h.app.emit('web-contents-created', {}, host);
  const guest = h.wc();
  guest.session = shared(h);
  host.emit('did-attach-webview', {}, guest);
  visit(guest, 'https://legacy.test/');
  assert.equal((await h.invoke('browser:suggest', 'legacy')).length, 1);
});

test('bookmarks: the star toggles, every window hears of it, and Clear browsing data empties history but not bookmarks', async () => {
  const h = await ready();
  assert.equal(await h.invoke('browser:bookmarked', 'https://a.test/'), false);
  assert.deepEqual(await h.invoke('browser:toggleBookmark', { url: 'https://a.test/', title: 'A' }), { bookmarked: true, ok: true });
  assert.equal(await h.invoke('browser:bookmarked', 'https://a.test/'), true);
  assert.equal(h.windows[0].webContents.on_('browser:bookmarksChanged').length, 1);
  const [b] = await h.invoke('browser:bookmarks');
  assert.equal(b.title, 'A');
  const views = h.one('PaneViews');
  const page = h.wc();
  page.session = shared(h);
  views.opts.onCreated(page);
  visit(page, 'https://history.test/');
  await h.invoke('browser:clearData');
  assert.deepEqual(await h.invoke('browser:suggest', 'history'), []);
  assert.equal((await h.invoke('browser:suggest', 'a.test'))[0].kind, 'bookmark');
  await h.invoke('browser:removeHistory', 'https://history.test/');
  assert.equal(await h.invoke('browser:removeBookmark', b.id), true);
});

test("the agent's search tools are given the history and bookmark stores", async () => {
  const h = await ready();
  const [, options] = calls(h.mod('capabilities/browser/hostTools.cjs').registerBrowserTools)[0];
  options.memory.history().record({ url: 'https://seen.test/', title: 'Seen' });
  assert.equal(options.memory.history().search({ query: 'seen' })[0].title, 'Seen');
  assert.deepEqual(options.memory.bookmarks().list(), []);
});

test('import IPC: sources and imported data are served, Full Disk Access opens System Settings, and the switch turns it off', async () => {
  const h = await ready();
  const sources = await h.invoke('browser:import:sources');
  assert.deepEqual(
    sources.map((s: any) => s.id),
    ['chrome', 'edge', 'brave', 'chromium', 'vivaldi', 'arc', 'safari'],
  );
  assert.deepEqual(Object.keys(await h.invoke('browser:import:imported')).sort(), ['bookmarks', 'cookies', 'history', 'last', 'passwords']);
  assert.equal((await h.invoke('browser:import:start', { source: 'chrome', profile: 'Default', kinds: { history: true } })).ok, false);
  await h.invoke('browser:import:openFullDiskAccess');
  assert.match(calls(h.electron.shell.openExternal)[0][0], /^x-apple\.systempreferences:/);
  shared(h).cookies = { flushStore: mock.fn(async () => {}), remove: mock.fn(async () => {}) };
  assert.equal(await h.invoke('browser:import:removeCookies'), 0);
  assert.equal(shared(h).cookies.flushStore.mock.callCount(), 1);
  h.mod('platform/flags.cjs').isEnabled.mock.mockImplementation(() => false);
  assert.deepEqual(await h.invoke('browser:import:sources'), []);
});

test('the key button IPC: one login store with the agent tools, fills only pane tabs, and Touch ID is asked where the Mac has it', async () => {
  const h = await ready();
  const [, options] = calls(h.mod('capabilities/browser/hostTools.cjs').registerBrowserTools)[0];
  assert.ok(options.credentials, 'the credential sheet is wired');
  assert.deepEqual(await h.invoke('browser:logins', 'https://a.test/'), []);
  const appWindow = h.windows[0].webContents;
  assert.equal(await h.invoke('browser:fillLogin', appWindow.id, 'x'), 'not_found');
  const sp = h.electron.systemPreferences;
  sp.canPromptTouchID.mock.mockImplementation(() => true);
  const page = h.wc();
  page.session = shared(h);
  page.getURL = () => 'https://a.test/';
  page.isLoadingMainFrame = () => false;
  assert.equal(await h.invoke('browser:fillLogin', page.id, 'missing'), 'not_found');
});

test("Safari's passwords file: main asks with an open panel on the asking window (or none), and the Trash takes it", async () => {
  const h = await ready();
  const { dialog, shell } = h.electron;
  // a sender that is no window (the panel then has no parent)
  assert.equal(await h.invokeFrom(h.wc(), 'browser:import:choosePasswordFile'), null, 'a cancelled panel');
  assert.equal(dialog.showOpenDialog.mock.calls.at(-1).arguments.length, 1);
  dialog.showOpenDialog.mock.mockImplementation(async () => ({ canceled: false, filePaths: ['/Users/me/Passwords.csv'] }));
  assert.deepEqual(await h.invokeFrom(h.windows[0].webContents, 'browser:import:choosePasswordFile'), { name: 'Passwords.csv' });
  const [win, opts] = dialog.showOpenDialog.mock.calls.at(-1).arguments;
  assert.equal(win, h.windows[0]);
  assert.deepEqual(opts.filters, [{ name: 'Passwords (CSV)', extensions: ['csv'] }]);
  dialog.showOpenDialog.mock.mockImplementation(async () => ({ canceled: false, filePaths: [] }));
  assert.equal(await h.invoke('browser:import:choosePasswordFile'), null, 'a panel that returned no file');
  shell.trashItem = mock.fn(async () => undefined);
  assert.deepEqual(await h.invoke('browser:import:trashPasswordFile'), { ok: true });
  assert.deepEqual(shell.trashItem.mock.calls[0].arguments, ['/Users/me/Passwords.csv']);
});

test('the in-page login help is on every pane view: a sign-in there is offered to every window, and the answer goes back to main', async () => {
  const h = await ready();
  Object.assign(h.electron.safeStorage, {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  });
  const scripts: string[] = [];
  const page = h.wc({
    getURL: () => 'https://a.test/login',
    executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
      scripts.push(code);
      return code.includes('.take()') ? { origin: 'https://a.test', username: 'ann', password: 'pw' } : undefined;
    },
  });
  page.session = shared(h);
  h.one('PaneViews').opts.onCreated(page);
  page.emit('dom-ready');
  await flush();
  const prefix = scripts[0].match(/"(mopilot-login:[^"]+:)"/)![1];
  page.emit('console-message', { message: `${prefix}submitted` });
  await flush();
  page.emit('did-navigate', {}, 'https://a.test/home', 200);
  const [[{ offerId, ...heard }]] = h.windows[0].webContents.on_('browser:loginAssist');
  assert.deepEqual(heard, { pageId: page.id, kind: 'offer', host: 'a.test', username: 'ann', update: false });
  // the answer names the offer its bar showed
  assert.equal(await h.invoke('browser:answerLoginOffer', page.id, 'dismiss', 'another'), 'gone');
  assert.equal(await h.invoke('browser:answerLoginOffer', page.id, 'dismiss', offerId), 'dismissed');
  assert.equal(await h.invoke('browser:answerLoginOffer', page.id, 'save', offerId), 'gone');
  // while an agent drives the page, its sign-in is not taken or offered
  const { BrowserTabs } = require('../electron/capabilities/browser/host.cjs');
  const driver = mock.method(BrowserTabs.prototype, 'driver', () => ({ chatId: 'c', tabId: 't', agent: true }));
  page.emit('console-message', { message: `${prefix}submitted` });
  await flush();
  driver.mock.restore();
  page.emit('did-navigate', {}, 'https://a.test/home', 200);
  // the offer, and the bar closing after the answer: nothing more
  assert.equal(h.windows[0].webContents.on_('browser:loginAssist').length, 2);
  assert.equal(scripts.filter((c) => c.includes('.take()')).length, 1);
});
