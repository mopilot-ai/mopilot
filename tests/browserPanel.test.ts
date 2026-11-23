// The built-in browser channel: the CDP target check, site permissions, the approvals broker and the
// sage_browser_* tools over a fake panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertCdpTarget, formatAxTree, PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');
const { OriginGrants, originOf, decide } = require('../electron/capabilities/browser/origins.cjs');
const { panelBrowserTools } = require('../electron/capabilities/browser/tools.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

/** A webContents as far as assertCdpTarget looks. */
function fakeWc(o: Record<string, any> = {}) {
  const wc: any = new EventEmitter();
  Object.assign(
    wc,
    {
      id: o.id ?? Math.floor(Math.random() * 1e6),
      destroyed: false,
      type: 'webview',
      session: o.session,
      prefs: {},
      hostWebContents: o.host ?? null,
      url: 'about:blank',
    },
    o,
  );
  wc.isDestroyed = () => wc.destroyed;
  wc.getType = () => wc.type;
  wc.getLastWebPreferences = () => wc.prefs;
  wc.getURL = () => wc.url;
  wc.getTitle = () => '';
  wc.isLoading = () => false;
  return wc;
}

function world() {
  const panelSession = { name: 'persist:browser' };
  const ui = fakeWc({ type: 'window', session: { name: 'default' } });
  const guest = fakeWc({ session: panelSession, host: ui });
  return { panelSession, ui, guest, appContents: [ui] };
}

test('assertCdpTarget accepts a panel guest', () => {
  const { guest, appContents, panelSession, ui } = world();
  assert.doesNotThrow(() => assertCdpTarget(guest, { appContents, panelSession, host: ui }));
});

test("assertCdpTarget refuses the app UI's own webContents", () => {
  const { ui, appContents, panelSession } = world();
  assert.throws(() => assertCdpTarget(ui, { appContents, panelSession }), /own window/);
  // even dressed up as a webview in the right partition
  const disguised = fakeWc({ id: ui.id, session: panelSession, host: ui });
  assert.throws(() => assertCdpTarget(disguised, { appContents, panelSession }), /own window/);
});

test('assertCdpTarget refuses other partitions, preloads, Node, strangers and dead tabs', () => {
  const { ui, appContents, panelSession } = world();
  const check = (wc: any, host?: any) => () => assertCdpTarget(wc, { appContents, panelSession, host });
  assert.throws(check(fakeWc({ session: { name: 'default' }, host: ui })), /partition/);
  assert.throws(check(fakeWc({ session: panelSession, host: ui, prefs: { preload: '/x/preload.js' } })), /preload/);
  assert.throws(check(fakeWc({ session: panelSession, host: ui, prefs: { nodeIntegration: true } })), /Node/);
  assert.throws(check(fakeWc({ session: panelSession, host: fakeWc({ type: 'window' }) })), /does not belong/);
  assert.throws(check(fakeWc({ session: panelSession, host: ui, type: 'backgroundPage' })), /not a browser tab/);
  assert.throws(check(fakeWc({ session: panelSession, host: ui, destroyed: true })), /gone/);
  assert.throws(check(null), /gone/);
  // a guest of one window reported by another
  assert.throws(check(fakeWc({ session: panelSession, host: ui }), fakeWc({ type: 'window' })), /another window/);
});

test('PanelBrowser keeps only checked tabs, and opens one when a chat has none', async () => {
  const { ui, guest, appContents, panelSession } = world();
  const opened: string[] = [];
  const panel = new PanelBrowser({
    appContents: () => appContents,
    panelSession: () => panelSession,
    open: (chatId: string) => {
      opened.push(chatId);
      setImmediate(() => panel.attach(chatId, guest, ui));
    },
    attachMs: 1000,
  });
  assert.throws(() => panel.attach('c1', ui, ui), /own window/);
  assert.equal(panel.tabs.size, 0);
  const t = await panel.tab('c1');
  assert.equal(t.backend.identity, guest);
  assert.deepEqual(opened, ['c1']);
  await panel.tab('c1');
  assert.deepEqual(opened, ['c1'], 'an open tab is reused');
  guest.emit('destroyed');
  assert.equal(panel.tabs.size, 0);
});

test('PanelBrowser gives up when no tab arrives', async () => {
  const { appContents, panelSession } = world();
  const panel = new PanelBrowser({ appContents: () => appContents, panelSession: () => panelSession, open: () => {}, attachMs: 20 });
  await assert.rejects(panel.tab('c1'), /didn't open/);
  const none = new PanelBrowser({ appContents: () => appContents, panelSession: () => panelSession, open: () => false });
  await assert.rejects(none.tab('c1'), /no MoPilot window/);
});

test('formatAxTree indents roles and names and gives interactive nodes refs', () => {
  const nodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Hello' }, childIds: ['2', '3', '5'] },
    { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Welcome  home' }, childIds: ['6'] },
    { nodeId: '6', parentId: '2', role: { value: 'StaticText' }, name: { value: 'Welcome home' }, childIds: [] },
    { nodeId: '3', parentId: '1', role: { value: 'generic' }, childIds: ['4'] },
    { nodeId: '4', parentId: '3', role: { value: 'link' }, name: { value: 'Next' }, backendDOMNodeId: 42, childIds: [] },
    {
      nodeId: '5',
      parentId: '1',
      role: { value: 'textbox' },
      name: { value: 'Search' },
      value: { value: 'cats' },
      backendDOMNodeId: 43,
      childIds: [],
    },
  ];
  const { text, refs } = formatAxTree(nodes);
  assert.equal(
    text,
    ['- RootWebArea "Hello"', '  - heading "Welcome home"', '  - link "Next" [ref=e1]', '  - textbox "Search" value="cats" [ref=e2]'].join(
      '\n',
    ),
  );
  assert.deepEqual(
    [...refs],
    [
      ['e1', 42],
      ['e2', 43],
    ],
  );
  assert.match(formatAxTree(nodes, { max: 30 }).text, /cut short/);
});

test('originOf keeps http(s) origins only', () => {
  assert.equal(originOf('https://Example.com:443/a?b#c'), 'https://example.com');
  assert.equal(originOf('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,hi', 'not a url'])
    assert.equal(originOf(bad), null, bad);
});

test('decide: a write grant covers reading, a read grant refuses writing', () => {
  assert.equal(decide('write', 'read'), 'ok');
  assert.equal(decide('write', 'write'), 'ok');
  assert.equal(decide('read', 'read'), 'ok');
  assert.equal(decide('read', 'write'), 'readOnly');
  assert.equal(decide(null, 'read'), 'ask');
  assert.equal(decide(null, 'read', true), 'denied');
});

test('OriginGrants: card scopes (once, chat, always), one card per origin at a time, denials per chat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-'));
  const file = path.join(dir, 'browser-sites.json');
  const asked: any[] = [];
  let answer: any = { decision: 'allow', scope: 'always', level: 'read' };
  const g = new OriginGrants({ file, ask: async ({ signal: _signal, ...q }: any) => (asked.push(q), answer) });
  const ctx = { chatId: 'c1', segmentId: 's1' };
  await g.require('about:blank', 'read', ctx);
  assert.equal(asked.length, 0, 'a blank page needs nothing');
  await assert.rejects(g.require('file:///etc/hosts', 'read', ctx), (e: any) => e.code === 'blocked');
  await assert.rejects(g.require('ftp://files.test/x', 'read', ctx), (e: any) => e.code === 'bad_url');

  // two calls at once share one card; "always" is remembered for the site in every chat
  await Promise.all([g.require('http://a.test/x', 'read', ctx), g.require('http://a.test/y', 'read', ctx)]);
  assert.deepEqual(asked, [{ chatId: 'c1', segmentId: 's1', browser: 'iab', origin: 'http://a.test', need: 'read' }]);
  await g.require('http://a.test/z', 'read', { chatId: 'c2', segmentId: 's2' });
  assert.equal(asked.length, 1);
  await assert.rejects(g.require('http://a.test/form', 'write', ctx), (e: any) => e.code === 'read_only');
  assert.equal(asked.length, 2, 'a write on a site allowed for reading asks (CM-P25), here answered Read only again');

  // "once": this call only, asked again next time, nothing stored
  answer = { decision: 'allow', scope: 'once', level: 'write' };
  await g.require('http://o.test/', 'write', ctx);
  await g.require('http://o.test/', 'read', ctx);
  assert.equal(asked.length, 4);
  assert.equal(g.get('http://o.test'), null);

  // "chat": the rest of this chat, not saved, not for other chats
  answer = { decision: 'allow', scope: 'chat', level: 'write' };
  await g.require('http://t.test/', 'write', ctx);
  await g.require('http://t.test/', 'write', ctx);
  assert.equal(asked.length, 5);
  assert.equal(g.get('http://t.test'), null);
  await g.require('http://t.test/', 'read', { chatId: 'c2', segmentId: 's2' });
  assert.equal(asked.length, 6, 'another chat asks again');
  g.forget('c1');
  await g.require('http://t.test/', 'read', ctx);
  assert.equal(asked.length, 7, 'a finished chat is forgotten');

  // a denial holds for the chat
  answer = { decision: 'deny' };
  await assert.rejects(g.require('http://b.test/', 'read', ctx), (e: any) => e.code === 'denied');
  await assert.rejects(g.require('http://b.test/', 'read', ctx), (e: any) => e.code === 'denied');
  assert.equal(asked.length, 8);
  answer = null;
  await assert.rejects(g.require('http://n.test/', 'read', ctx), (e: any) => e.code === 'unanswered');
  answer = { decision: 'allow', scope: 'always', level: 'write' };
  await g.require('http://b.test/', 'write', { chatId: 'c3', segmentId: 's3' });

  const again = new OriginGrants({ file, ask: async () => null });
  assert.deepEqual(again.list(), [
    { origin: 'http://a.test', level: 'read' },
    { origin: 'http://b.test', level: 'write' },
  ]);
  assert.equal(again.set('http://a.test', 'write'), true);
  assert.equal(again.set('nonsense', 'write'), false);
  assert.equal(again.set('http://a.test', 'admin'), false);
  again.set('http://b.test', null);
  assert.deepEqual(new OriginGrants({ file, ask: async () => null }).list(), [{ origin: 'http://a.test', level: 'write' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sage_browser_* tools check the site permission for the page they touch', async () => {
  let page = 'about:blank';
  const calls: string[] = [];
  const wc = { getURL: () => page, isDestroyed: () => false };
  const panel = {
    tab: async () => ({ backend: wc, refs: new Map() }),
    url: async () => page,
    navigate: async (_c: string, url: string) => (
      calls.push(`nav ${url}`), (page = url === 'http://a.test/go' ? 'http://b.test/landed' : url), { url: page, title: 'T' }
    ),
    snapshot: async () => (calls.push('snapshot'), 'tree'),
    click: async () => calls.push('click'),
    type: async () => calls.push('type'),
    screenshot: async () => ({ type: 'image', data: 'AA==', mimeType: 'image/png' }),
  };
  const grants: Record<string, string | null> = { 'http://a.test': 'read', 'http://b.test': null };
  const g = new OriginGrants({
    ask: async (q: any) => (grants[q.origin] ? { decision: 'allow', scope: 'always', level: grants[q.origin] } : { decision: 'deny' }),
  });
  let on = true;
  const r = new Registry();
  for (const t of panelBrowserTools({ panel, grants: g, enabled: () => on })) r.register(t);
  assert.deepEqual(
    r.list().map((t: any) => [t.name, t.policy]),
    [
      ['sage_browser_navigate', 'observe'],
      ['sage_browser_snapshot', 'observe'],
      ['sage_browser_click', 'act'],
      ['sage_browser_type', 'act'],
      ['sage_browser_screenshot', 'observe'],
    ],
  );
  const call = (tool: string, args: any = {}) => r.invoke('c1', 's1', tool, args);

  const nav = await call('sage_browser_navigate', { url: 'http://a.test/' });
  assert.equal(nav.ok, true);
  assert.equal(nav.content[0].text, 'Opened http://a.test/ (T)');
  assert.equal((await call('sage_browser_snapshot')).content[0].text, 'tree');
  assert.equal((await call('sage_browser_screenshot')).content[0].type, 'image');
  // the act tools run without the generic approval hook (there is none), but read only refuses them
  const click = await call('sage_browser_click', { ref: 'e1' });
  assert.equal(click.error.code, 'read_only');
  // a redirect to a site the user denies leaves a blank page
  const redirected = await call('sage_browser_navigate', { url: 'http://a.test/go' });
  assert.equal(redirected.error.code, 'denied');
  assert.equal(page, 'about:blank');
  // leaving the page can fail too (the tab closed): the caller still gets the permission error
  const navigate = panel.navigate;
  panel.navigate = async (c: string, url: string) => {
    if (url === 'about:blank') throw new Error('tab closed');
    return navigate(c, url);
  };
  const closed = await call('sage_browser_navigate', { url: 'http://a.test/go' });
  assert.equal(closed.error.code, 'denied');
  assert.equal(page, 'http://b.test/landed');
  panel.navigate = navigate;
  assert.equal((await call('sage_browser_navigate', { url: 'javascript:alert(1)' })).error.code, 'bad_url');
  assert.ok(!calls.includes('click'));

  on = false;
  assert.equal((await call('sage_browser_snapshot')).error.code, 'disabled');
});

const { browserWorld, contents } = require('./helpers/browser.cjs');
function driven() {
  const w = browserWorld();
  const panel = new PanelBrowser({ ...w, open: () => false });
  panel.attach('chat', w.root, w.host);
  return { ...w, panel };
}
const settleMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

test('CDP refuses unregistered or unsandboxed popups even when a debugger is already attached', async () => {
  const w = driven();
  const popup = w.popup();
  const check = (wc: any) => assertCdpTarget(wc, { appContents: [w.host], panelSession: w.session, popupRoot: w.root });
  check(popup.webContents);
  for (const prefs of [
    { sandbox: false, contextIsolation: true },
    { sandbox: true, contextIsolation: false },
    { sandbox: true, contextIsolation: true, webviewTag: true },
    { sandbox: false, contextIsolation: true, nodeIntegrationInSubFrames: true },
  ])
    assert.throws(() => check(contents({ session: w.session, type: 'window', prefs })), /sandboxed|Node/);
  // preloads in a sandboxed page's frames (the page dialogs) give it no Node
  check(
    contents({ session: w.session, type: 'window', prefs: { sandbox: true, contextIsolation: true, nodeIntegrationInSubFrames: true } }),
  );
  assert.throws(() => check(contents({ session: w.session, type: 'webview' })), /registered browser popup/);
  assert.throws(() => w.panel.attach('', w.root, w.host), /no chat/);
  assert.throws(() => w.panel.attach('other', popup.webContents, w.host), /not a browser tab/);
  assert.throws(() => w.panel.registerPopup(popup.webContents, w.popup().webContents), /not a browser tab/);
  w.root.attached = true;
  w.root.session = {};
  await assert.rejects(w.panel.send('chat', 'Runtime.evaluate'), /partition/);
});

test('CDP supports guests with missing preference metadata while requiring a real app owner/session', () => {
  const w = driven();
  w.root.getLastWebPreferences = () => null;
  assertCdpTarget(w.root, { appContents: [null, w.host], panelSession: w.session });
  w.root.getLastWebPreferences = undefined;
  assertCdpTarget(w.root, { appContents: [w.host], panelSession: w.session });
  assert.throws(() => assertCdpTarget(w.root, { appContents: [w.host], panelSession: null }), /partition/);
});

test('CDP reads text, accessibility refs and screenshots; grants keep the original ref map shared', async () => {
  const w = driven();
  const entry = await w.panel.tab('chat');
  const authorized = { ...entry, expectedUrl: w.root.url };
  assert.match(await w.panel.snapshot('chat', 'accessibility', authorized), /Continue.*ref=e1/);
  assert.equal(entry.refs.get('e1'), 10);
  assert.match(await w.panel.snapshot('chat', 'text'), /Page text/);
  assert.deepEqual(await w.panel.screenshot('chat'), { type: 'image', data: 'AA==', mimeType: 'image/png' });
  assert.equal(await w.panel.url('chat'), w.root.url);
  await w.panel.type('chat', { ref: 'e2' }, 'Ada');
  assert.ok(w.root.calls.some(([method, args]: any) => method === 'Input.insertText' && args.text === 'Ada'));
  w.root.command = (method: string) => (method === 'Runtime.evaluate' ? { result: { value: 'x'.repeat(40_001) } } : {});
  assert.match(await w.panel.snapshot('chat', 'text'), /cut short/);
  w.root.command = () => ({});
  assert.equal((await w.panel.snapshot('chat', 'text')).split('\n\n')[1], '');
  assert.equal(await w.panel.snapshot('chat'), `URL: ${w.root.url}\nTitle: Task\n\n`);
});

test('CDP pins all input commands to the approved page even if that action opens a popup', async () => {
  const w = driven();
  const entry = await w.panel.tab('chat');
  await w.panel.snapshot('chat');
  const popup = w.popup();
  const base = w.root.debugger.sendCommand;
  w.root.debugger.sendCommand = async (method: string, args: any) => {
    const result = await base(method, args);
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mousePressed') w.panel.registerPopup(w.root, popup.webContents);
    return result;
  };
  await w.panel.click('chat', { ref: 'e1' }, { ...entry, expectedUrl: w.root.url });
  assert.ok(w.root.calls.some(([method, args]: any) => method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased'));
  assert.equal(popup.webContents.calls.length, 0);
  assert.equal((await w.panel.tab('chat')).backend.identity, popup.webContents);
  await assert.rejects(w.panel.click('chat', { ref: 'e1' }), /new snapshot/);
});

test('CDP clears refs on navigation and popup target changes; submitting a popup may close it', async () => {
  const w = driven();
  const entry = await w.panel.tab('chat');
  for (const event of ['did-start-loading', 'did-navigate', 'did-navigate-in-page']) {
    await w.panel.snapshot('chat');
    w.root.emit(event);
    assert.equal(entry.refs.size, 0);
  }
  const popup = w.popup();
  w.panel.registerPopup(w.root, popup.webContents);
  await w.panel.snapshot('chat');
  const current = await w.panel.tab('chat');
  popup.webContents.command = (method: string, args: any) => {
    if (method === 'Input.dispatchKeyEvent' && args.type === 'keyUp') popup.close();
    return {};
  };
  await w.panel.type('chat', { ref: 'e2' }, 'Ada', true);
  assert.equal((await w.panel.tab('chat')).backend.identity, w.root);
  assert.equal(current.backend.identity.destroyed, true);
  await assert.rejects(w.panel.type('chat', { ref: 'e2' }, 'wrong'), /new snapshot/);
});

test('CDP selector actions handle missing targets and changed approved URLs', async () => {
  const w = driven();
  await w.panel.click('chat', { selector: '#button' });
  await w.panel.type('chat', { selector: '#field' }, 'Value', true);
  assert.ok(w.root.calls.some(([method, args]: any) => method === 'Input.dispatchKeyEvent' && args.type === 'keyDown'));
  await assert.rejects(w.panel.click('chat', {}), /ref or selector/);
  w.root.command = (method: string) => (method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : { nodeId: 0 });
  await assert.rejects(w.panel.click('chat', { selector: '#missing' }), /Nothing matches/);
  const entry = await w.panel.tab('chat');
  await assert.rejects(w.panel.send('chat', 'Runtime.evaluate', {}, { ...entry, expectedUrl: 'https://old.test/' }), /page changed/i);
});

test('CDP refuses a snapshot or screenshot that finishes on a different page', async () => {
  for (const method of ['text', 'accessibility', 'screenshot']) {
    const w = driven();
    const base = w.root.debugger.sendCommand;
    w.root.debugger.sendCommand = async (name: string, args: any) => {
      const r = await base(name, args);
      w.root.url = 'https://other.test/';
      return r;
    };
    await assert.rejects(method === 'screenshot' ? w.panel.screenshot('chat') : w.panel.snapshot('chat', method), /page changed/i);
  }
});

test('CDP reports navigation failures, closes, slow loads and successful completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const scenario of ['error', 'load-failure', 'cancelled', 'subframe', 'closed', 'timeout', 'timeout-stopped', 'loaded']) {
    const w = driven();
    w.root.command = () => {
      if (scenario === 'error') return { errorText: 'ERR_NAME_NOT_RESOLVED' };
      if (scenario === 'load-failure') w.root.emit('did-fail-load', {}, -105, '', '', true);
      if (scenario === 'cancelled') w.root.emit('did-fail-load', {}, -3, '', '', true);
      if (scenario === 'subframe') w.root.emit('did-fail-load', {}, -105, 'frame error', '', false);
      if (scenario === 'closed') w.root.destroy();
      if (scenario === 'loaded') w.root.emit('did-stop-loading');
      w.root.loading = scenario === 'timeout';
      return { loaderId: 'load' };
    };
    const navigation = w.panel.navigate('chat', 'https://task.test/new');
    const expected = ['error', 'load-failure', 'closed', 'timeout'].includes(scenario);
    const outcome = expected ? assert.rejects(navigation, /Couldn't|closed|loading/) : navigation;
    await settleMicrotasks();
    t.mock.timers.tick(20_000);
    await outcome;
    assert.equal(w.root.listenerCount('did-stop-loading'), 0);
  }
  const w = driven();
  w.root.command = () => undefined;
  assert.equal((await w.panel.navigate('chat', 'https://task.test/new')).url, w.root.url);
  t.mock.timers.tick(20_000);
});

test('CDP settles a load started by input and follows a new guest after the previous one exits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = driven();
  w.panel.attach('chat', w.root, w.host);
  w.root.loading = true;
  const clicked = w.panel.click('chat', { selector: '#button' });
  await settleMicrotasks();
  t.mock.timers.tick(150);
  await settleMicrotasks();
  for (const e of ['did-navigate', 'did-stop-loading']) w.root.emit(e);
  await clicked;
  w.root.destroy();
  const newer = contents({ session: w.session, hostWebContents: w.host });
  w.panel.o.open = (id: string) => {
    w.panel.attach(id, newer, w.host);
  };
  assert.equal((await w.panel.tab('chat')).backend.identity, newer);
  w.panel.attach('chat', (w.root = contents({ session: w.session, hostWebContents: w.host })), w.host);
  newer.destroy();
  assert.equal((await w.panel.tab('chat')).backend.identity, w.root);
  t.mock.timers.tick(15_000);
});

test('accessibility formatting handles empty, unnamed, ignored and truncated trees', () => {
  assert.equal(formatAxTree([]).text, '');
  assert.equal(formatAxTree([{ nodeId: 'x', parentId: 'missing' }]).text, '- ');
  assert.equal(formatAxTree([{ nodeId: 'x', name: { value: null }, value: { value: 12 } }]).text, '-  value="12"');
  assert.equal(formatAxTree([{ nodeId: 'x', ignored: true }]).text, '');
  assert.equal(formatAxTree([{ nodeId: 'x', role: { value: 'StaticText' } }]).text, '');
  assert.equal(formatAxTree([{ nodeId: 'x', role: { value: 'button' } }]).refs.size, 0);
  assert.match(formatAxTree([{ nodeId: 'x', role: { value: 'button' }, childIds: ['missing'] }], { max: 1 }).text, /cut short/);
});

test('browser tools pass authorized targets, reject stale pages/popups, and respect a channel change during approval', async () => {
  const w = driven();
  const acts: any[] = [];
  const tools = panelBrowserTools({
    panel: w.panel,
    grants: { require: async () => {}, act: async (url: string, _ctx: any, a: any) => void acts.push([url, a]) },
  });
  const call = (name: string, args: any = {}) =>
    tools.find((tool: any) => tool.name === `sage_browser_${name}`).handler(args, { chatId: 'chat' });
  assert.match(await call('snapshot'), /ref=e1/);
  assert.match(await call('snapshot', { mode: 'text' }), /Page text/);
  assert.equal(await call('click', { ref: 'e1' }), 'Clicked e1');
  assert.equal(await call('type', { selector: '#field', text: 'Ada', submit: true }), 'Typed into #field');
  await call('type', { ref: 'e2', text: 'Ada' });
  // clicks and typing go through the per-action check (a high-risk site asks each time); reads don't
  assert.deepEqual(
    acts.map(([, a]) => a),
    [
      { tool: 'click', summary: 'click e1', sensitive: null },
      { tool: 'type', summary: 'type into #field and press Enter', sensitive: null },
      { tool: 'type', summary: 'type into e2', sensitive: null },
    ],
  );
  assert.equal((await call('screenshot')).type, 'image');
  assert.match(await call('navigate', { url: 'https://task.test/next' }), /Opened/);
  w.root.title = '';
  assert.equal(await call('navigate', { url: 'https://task.test/next' }), 'Opened https://task.test/next');
  for (const scenario of ['url', 'destroyed', 'popup', 'disabled']) {
    const current = driven();
    let enabled = true;
    const defs = panelBrowserTools({
      panel: current.panel,
      enabled: () => enabled,
      grants: {
        require: async () => {
          if (scenario === 'url') current.root.url = 'https://other.test/';
          if (scenario === 'destroyed') current.root.destroy();
          if (scenario === 'popup') current.panel.registerPopup(current.root, current.popup().webContents);
          if (scenario === 'disabled') enabled = false;
        },
      },
    });
    await assert.rejects(defs.find((d: any) => d.name === 'sage_browser_snapshot').handler({}, { chatId: 'chat' }), /changed|turned off/);
    assert.equal(current.root.calls.length, 0);
  }
});

test('click selectors and unnamed child text preserve usable refs without inventing labels', async () => {
  const w = driven();
  const tools = panelBrowserTools({ panel: w.panel, grants: { require: async () => {}, act: async () => {} } });
  assert.equal(await tools[2].handler({ selector: '#button' }, { chatId: 'chat' }), 'Clicked #button');
  assert.match(
    formatAxTree([
      { nodeId: 'r', role: { value: 'generic' }, childIds: ['t'] },
      { nodeId: 't', parentId: 'r', role: { value: 'StaticText' }, name: { value: 'child text' } },
    ]).text,
    /child text/,
  );
});
