// Pane tabs as main-owned WebContentsViews (electron/capabilities/browser/views.cjs), with fake views and
// windows: creation in a partition, parking, showing and reparenting, binding, the pane's events and toolbar,
// closing and release; and the view branches of assertCdpTarget, Annotate and the popup window policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWC, FakeView, FakeWindow, setup } from './support/browser-view-fixture.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerViewIpc, isViewTab, scaleBounds, HARDENED, PARKED, CLOSED_MAX } = require('../electron/capabilities/browser/views.cjs');
const { assertCdpTarget } = require('../electron/capabilities/browser/cdp.cjs');
const { isPaneTab } = require('../electron/capabilities/browser/annotate.cjs');
const { BrowserWindows } = require('../electron/capabilities/browser/windows.cjs');

test('scaleBounds: CSS pixels times the window zoom, whole and non-negative; nothing for an empty or bad rect', () => {
  assert.deepEqual(scaleBounds({ x: 10.4, y: -3, width: 100, height: 50.5 }, 2), { x: 21, y: 0, width: 200, height: 101 });
  assert.deepEqual(scaleBounds({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(scaleBounds({ x: 1, y: 2, width: 3, height: 4 }, 0), { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(scaleBounds({ x: 0, y: 0, width: 0, height: 10 }), null);
  assert.equal(scaleBounds({ x: 0, y: 0, width: '5', height: 10 }), null);
  assert.equal(scaleBounds(null), null);
});

test('create: a hardened view in the asked partition, parked at the default size, loading its url, with the page policy installed', async () => {
  const { views, sessions, created } = setup();
  const e = views.create({ partition: 'mopilot-chat-a-12345678', url: 'https://a.test/' });
  assert.ok(isViewTab(e.wc));
  assert.equal(isViewTab(new FakeWC()), false);
  assert.equal(isViewTab(null), false);
  assert.deepEqual(
    { ...e.wc.prefs, session: undefined },
    { ...HARDENED, enableBlinkFeatures: 'WebMCP', backgroundThrottling: false, session: undefined },
  );
  assert.equal(e.wc.prefs.session, sessions.get('mopilot-chat-a-12345678'));
  assert.deepEqual(e.wc.calls, [['load', 'https://a.test/']]);
  assert.deepEqual(created, [e.wc]);
  const park = views.park;
  assert.equal(park.opts.show, false);
  assert.equal(park.opts.focusable, false);
  assert.deepEqual(park.contentView.children, [e.view]);
  assert.deepEqual(e.view.bounds, { x: 0, y: 0, width: PARKED.width, height: PARKED.height });
  assert.deepEqual(park.size, [PARKED.width, PARKED.height]);
  // no url: nothing loads; a session given (a popup's opener's) is used as is; a failed load is left to did-fail-load
  const blank = views.create();
  assert.deepEqual(blank.wc.calls, []);
  assert.equal(blank.wc.prefs.session, sessions.get('persist:browser'));
  const own = { own: true };
  const failing = new FakeWC();
  failing.loadResult = Promise.reject(new Error('ERR'));
  const withSession = views.create({ session: own });
  assert.equal(withSession.wc.prefs.session, own);
  views.o.WebContentsView = class extends FakeView {
    constructor(o: any) {
      super({ ...o, webContents: failing });
    }
  };
  views.create({ url: 'https://fail.test/' });
  await new Promise((r) => setImmediate(r));
  assert.equal(views.entryOf(failing.id)?.wc, failing);
});

test('adopt: a popup webContents becomes a view tab; entryOf matches only the same webContents', () => {
  const { views } = setup();
  const popup = new FakeWC({ sandbox: true });
  const e = views.adopt(popup);
  assert.equal(e.wc, popup);
  assert.ok(isViewTab(popup));
  assert.equal(views.entryOf(popup), e);
  assert.equal(views.entryOf(popup.id), e);
  assert.equal(views.entryOf({ id: popup.id }), null);
  assert.equal(views.entryOf(undefined), null);
});

test('show: a window takes the view at the scaled rect, another window reparents it, null parks it, unknowns are refused', () => {
  const other = new FakeWindow();
  const sender2 = new FakeWC();
  const { views, win, sender } = setup({ windowOf: (s: any) => (s === sender2 ? other : null) });
  const e = views.create();
  assert.equal(views.show(e.id, sender, { x: 10, y: 20, width: 400, height: 300 }), true);
  assert.equal(e.view.parent, win);
  assert.deepEqual(e.view.bounds, { x: 13, y: 25, width: 500, height: 375 });
  assert.equal(views.windowOf(e.wc), win);
  // the same window again: only the bounds change
  views.show(e.id, sender, { x: 0, y: 0, width: 400, height: 300 });
  assert.equal(win.contentView.children.length, 1);
  // another window's pane shows it: reparented, no reload
  views.show(e.id, sender2, { x: 0, y: 0, width: 800, height: 700 });
  assert.equal(e.view.parent, other);
  assert.equal(win.contentView.children.length, 0);
  // no reload; the page's zoom follows the width each window shows it at (pageZoom.cjs)
  assert.deepEqual(e.wc.calls, [
    ['zoom', 0.7],
    ['zoom', 0.8],
  ]);
  // the first window hiding it does nothing: it isn't there
  assert.equal(views.show(e.id, sender, null), true);
  assert.equal(e.view.parent, other);
  // the window showing it hides it: parked at its size, and the parking window grows to fit
  views.show(e.id, sender2, null);
  assert.equal(e.view.parent, views.park);
  assert.deepEqual(e.view.bounds, { x: 0, y: 0, width: 800, height: 700 });
  assert.equal(views.windowOf(e.wc), null);
  views.show(e.id, sender2, { x: 0, y: 0, width: 2000, height: 1500 });
  views.show(e.id, sender2, { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(views.park.size, [2000, 1500]);
  assert.equal(views.show(999999, sender, { x: 0, y: 0, width: 1, height: 1 }), false);
  assert.equal(views.show(e.id, new FakeWC(), { x: 0, y: 0, width: 1, height: 1 }), false);
  win.destroyed = true;
  assert.equal(views.show(e.id, sender, { x: 0, y: 0, width: 1, height: 1 }), false);
});

test('a window that closes parks the views it shows; windowOf ignores a destroyed window', () => {
  const { views, win, sender } = setup();
  const a = views.create();
  const b = views.create();
  views.show(a.id, sender, { x: 0, y: 0, width: 10, height: 10 });
  views.show(b.id, sender, { x: 0, y: 0, width: 10, height: 10 });
  win.destroyed = true;
  assert.equal(views.windowOf(a.wc), null);
  win.destroyed = false;
  win.emit('closed');
  assert.equal(a.view.parent, views.park);
  assert.equal(b.view.parent, views.park);
});

test('bind: by pane id, else an agent tab, else a new view for a web address; closed panes and bad requests', () => {
  const agentWc: any = { current: null };
  const { views, sender } = setup({
    agentView: (chatId: string, tabKey: string | null) => (chatId === 'c1' && tabKey === 'tab_1' ? agentWc.current : null),
  });
  assert.equal(views.bind('', sender), null);
  assert.equal(views.bind('p1', new FakeWC(), { url: 'https://a.test/' }), null, 'only an app window binds');
  assert.equal(views.bind('p1', sender, { url: 'file:///etc/passwd' }), null);
  const first = views.bind('p1', sender, { url: 'https://a.test/', partition: 'mopilot-chat-x-12345678' });
  const e = views.entryOf(first.id);
  assert.deepEqual(first.state, {
    url: 'https://a.test/',
    title: '',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoom: 1,
    zoomAuto: true,
  });
  assert.equal(e.keep, false);
  // a user's tab knows no chat until a chat's pane binds it; a pane of no chat leaves what it knew
  assert.equal(views.chatOf(e.wc), null);
  assert.equal(views.bind('p1', sender, { url: 'https://other.test/', chat: 'chat-a' }).id, first.id, 'the pane id names the view');
  assert.equal(views.chatOf(e.wc), 'chat-a');
  assert.equal(e.keep, false, 'a chat pane does not keep a user tab');
  views.bind('p1', sender, { chat: '' });
  views.bind('p1', sender, { chat: 5 as any });
  assert.equal(views.chatOf(e.wc), 'chat-a');
  assert.equal(views.chatOf(new FakeWC()), null, 'not a view');
  // an agent's tab, found by chat and key; the view then stays when its windows go, and belongs to the agent's chat
  const agent = views.create();
  agentWc.current = agent.wc;
  assert.equal(views.bind('p2', sender, { chatId: 'c1', chat: 'other', tabKey: 'tab_1' }).id, agent.id);
  assert.equal(agent.keep, true);
  assert.equal(views.chatOf(agent.wc), 'c1');
  // no agent view for the key: a new one (about:blank is allowed)
  const fresh = views.bind('p3', sender, { chatId: 'c1', tabKey: 7 as any, url: 'about:blank' });
  assert.notEqual(fresh.id, agent.id);
  // no agentView lookup at all
  const plain = setup();
  assert.ok(plain.views.bind('p9', plain.sender, { chatId: 'c1', url: 'about:blank' }));
  // a closed pane's tab is dropped instead of reopened
  views.close('p1');
  assert.deepEqual(views.bind('p1', sender, { url: 'https://a.test/' }), { closed: true });
});

test('events: binders get page events with the state, failed loads, Annotate console signals, and closed', () => {
  const { views, sender } = setup();
  const r = views.bind('p1', sender, { url: 'https://a.test/' });
  const e = views.entryOf(r.id);
  const other = Object.assign(new FakeWC(), { destroyed: false });
  e.binders.add(other);
  other.destroyed = true;
  e.wc.title = 'A';
  e.wc.history.back = true;
  e.wc.emit('page-title-updated');
  e.wc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://x.test/', true);
  e.wc.emit('console-message', { message: 'mopilot-annotate:abc:{}' });
  e.wc.emit('console-message', { message: 'page log' });
  e.wc.emit('console-message', undefined);
  assert.deepEqual(
    sender.sent.map(([ch, p]: any) => [ch, p.type, p.detail]),
    [
      ['browser:viewEvent', 'page-title-updated', null],
      [
        'browser:viewEvent',
        'did-fail-load',
        { errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED', validatedURL: 'https://x.test/', isMainFrame: true },
      ],
      ['browser:viewEvent', 'console-message', { message: 'mopilot-annotate:abc:{}' }],
    ],
  );
  assert.equal(sender.sent[0][1].state.title, 'A');
  assert.equal(sender.sent[0][1].state.canGoBack, true);
  assert.equal(other.sent.length, 0);
  e.wc.close();
  assert.deepEqual(sender.sent.at(-1), ['browser:viewEvent', { id: r.id, type: 'closed', state: null, detail: null }]);
});

test('nav: the toolbar drives the page; loads only web addresses; a gone view or another sender throws', async () => {
  const { views, sender } = setup();
  const e = views.create();
  assert.equal(views.nav(e.id, sender, 'back'), undefined);
  views.nav(e.id, sender, 'forward');
  views.nav(e.id, sender, 'reload');
  views.nav(e.id, sender, 'reloadIgnoringCache');
  views.nav(e.id, sender, 'stop');
  assert.equal(await views.nav(e.id, sender, 'load', 'https://b.test/'), undefined);
  assert.deepEqual(e.wc.calls, ['back', 'forward', 'reload', 'reloadIgnoringCache', 'stop', ['load', 'https://b.test/']]);
  assert.throws(() => views.nav(e.id, sender, 'load', 'javascript:alert(1)'), /http and https/);
  assert.throws(() => views.nav(e.id, sender, 'load', 'about:srcdoc'), /http and https/);
  assert.throws(() => views.nav(e.id, sender, 'print'), /Unknown browser action/);
  assert.throws(() => views.nav(4242, sender, 'reload'), /no longer available/);
  assert.throws(() => views.nav(e.id, new FakeWC(), 'reload'), /no longer available/);
});

test('nav: a blank tab loads about:blank again, so a crashed page with no web address can recover (#3988)', async () => {
  const { views, sender } = setup();
  const e = views.create({ url: 'about:blank' });
  e.wc.calls.length = 0;
  assert.equal(await views.nav(e.id, sender, 'load', 'about:blank'), undefined);
  assert.deepEqual(e.wc.calls, [['load', 'about:blank']]);
});

test('find: the find bar’s search runs in the page and its results reach the binders; stop-find ends it', () => {
  const { views, sender } = setup();
  const r = views.bind('p1', sender, { url: 'https://a.test/' });
  const e = views.entryOf(r.id);
  const asked: unknown[] = [];
  Object.assign(e.wc, {
    findInPage: (text: string, options: unknown) => (asked.push([text, options]), 11),
    stopFindInPage: (action: string) => asked.push(action),
  });
  assert.equal(views.nav(r.id, sender, 'find', { text: 'cat', forward: false, findNext: true }), 11);
  views.nav(r.id, sender, 'find', { text: 'cat' });
  assert.equal(views.nav(r.id, sender, 'stop-find'), undefined);
  assert.deepEqual(asked, [['cat', { forward: false, findNext: true }], ['cat', { forward: true, findNext: false }], 'clearSelection']);
  for (const bad of [undefined, { text: '' }, { text: 7 }, { text: 'x'.repeat(1001) }])
    assert.throws(() => views.nav(r.id, sender, 'find', bad), /Nothing to find/);
  sender.sent.length = 0;
  e.wc.emit('found-in-page', {}, { requestId: 11, activeMatchOrdinal: 2, matches: 3, finalUpdate: true, selectionArea: {} });
  e.wc.emit('found-in-page', {}, undefined);
  assert.deepEqual(
    sender.sent.map(([, p]: any) => p.detail),
    [{ result: { requestId: 11, activeMatchOrdinal: 2, matches: 3, finalUpdate: true, selectionArea: {} } }, { result: undefined }],
  );
});

test('close: by pane id, entry or webContents; the parking window goes with the last view; closed ids are bounded', () => {
  const { views, win, sender } = setup();
  const a = views.create();
  const b = views.create();
  views.name(a, 'pa');
  views.show(b.id, sender, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(views.close('nope'), false);
  assert.equal(views.close('pa'), true);
  assert.equal(views.close(a), false, 'already gone');
  assert.equal(views.panes.has('pa'), false);
  // a pane id another view took over since stays with it
  const c = views.create();
  views.name(c, 'pc');
  views.name(b, 'pc');
  views.close(c.wc);
  assert.equal(views.panes.get('pc'), b);
  const park = views.park;
  views.close(b);
  assert.equal(win.contentView.children.length, 0);
  assert.equal(views.park, null);
  assert.equal(park.destroyed, true);
  // a destroyed window or parking window is left alone
  const d = views.create();
  views.show(d.id, sender, { x: 0, y: 0, width: 10, height: 10 });
  win.destroyed = true;
  d.wc.close();
  const e2 = views.create();
  views.park.destroyed = true;
  e2.wc.close();
  // a destroyed event for an entry already gone is ignored
  const f = views.create();
  views.entries.delete(f.id);
  f.wc.close();
  for (let i = 0; i < CLOSED_MAX + 5; i++) {
    const g = views.create();
    views.name(g, `g${i}`);
    views.close(g);
  }
  assert.equal(views.closed.size, CLOSED_MAX);
  assert.equal(views.closed.has('g0'), false);
});

test('dropPark: parked views leave the parking window, which goes; a later view parks in a new one', () => {
  const { views, sender } = setup();
  const a = views.create();
  const b = views.create();
  views.show(b.id, sender, { x: 0, y: 0, width: 10, height: 10 });
  const park = views.park;
  views.dropPark();
  assert.equal(park.destroyed, true);
  assert.equal(a.view.parent, null);
  assert.ok(b.view.parent);
  views.dropPark();
  views.park = park;
  views.dropPark();
  views.create();
  assert.notEqual(views.park, park);
});

test('release: a window that goes or reloads closes the user views only it bound; agent views and shared ones stay', () => {
  const sender2 = new FakeWC();
  const { views, sender } = setup({ windowOf: (s: any) => (s === sender2 ? new FakeWindow() : null) });
  const user = views.entryOf(views.bind('u', sender, { url: 'https://u.test/' }).id);
  const shared = views.entryOf(views.bind('s', sender, { url: 'https://s.test/' }).id);
  views.bind('s', sender2, {});
  const agent = views.create();
  views.bind('a', sender, { chatId: 'c', url: 'about:blank' });
  views.name(agent, 'a2');
  agent.binders.add(sender);
  agent.keep = true;
  const unbound = views.create();
  sender.emit('did-navigate');
  assert.equal(user.wc.destroyed, true);
  assert.equal(shared.wc.destroyed, false);
  assert.equal(agent.wc.destroyed, false);
  assert.equal(unbound.wc.destroyed, false);
  // binding again after a reload listens once
  views.bind('s', sender, {});
  sender2.emit('destroyed');
  sender.emit('destroyed');
  assert.equal(shared.wc.destroyed, true);
});

test('registerViewIpc: bind, bounds, nav and close reach the views; without them, safe answers', async () => {
  const handlers = new Map<string, Function>();
  const ipc = { handle: (ch: string, fn: Function) => handlers.set(ch, fn) };
  const { views, sender } = setup();
  let current: any = views;
  registerViewIpc(ipc, () => current);
  const e = { sender };
  const r = handlers.get('browser:viewBind')!(e, 'p', { url: 'https://a.test/' });
  assert.ok(r.id);
  assert.equal(handlers.get('browser:viewBind')!(e, 'q', 'bad'), null);
  assert.equal(handlers.get('browser:viewBounds')!(e, r.id, { x: 0, y: 0, width: 5, height: 5 }), true);
  assert.equal(handlers.get('browser:viewBounds')!(e, r.id), true);
  assert.equal(await handlers.get('browser:viewNav')!(e, r.id, 'load', 'https://b.test/'), undefined);
  assert.equal(handlers.get('browser:viewClose')!(e, 'p'), true);
  assert.equal(handlers.get('browser:viewClose')!(e, 5), false);
  current = null;
  assert.equal(handlers.get('browser:viewBind')!(e, 'p', {}), null);
  assert.equal(handlers.get('browser:viewBounds')!(e, 1, null), false);
  assert.throws(() => handlers.get('browser:viewNav')!(e, 1, 'reload'), /no longer available/);
  assert.equal(handlers.get('browser:viewClose')!(e, 'p'), false);
});

test('assertCdpTarget: a view tab in a panel session passes without a host window; its prefs still count', () => {
  const ses = { s: 1 };
  const { views } = setup();
  const e = views.create({ session: ses });
  e.wc.session = ses;
  const appContents = [new FakeWC()];
  assert.doesNotThrow(() => assertCdpTarget(e.wc, { appContents, panelSession: [ses], host: new FakeWC() }));
  // a view's popup registered with a root also passes as a view
  assert.doesNotThrow(() => assertCdpTarget(e.wc, { appContents, panelSession: ses, popupRoot: e.wc }));
  // unsandboxed, its frames' preloads would have Node
  e.wc.prefs = { ...HARDENED, sandbox: false };
  assert.throws(() => assertCdpTarget(e.wc, { appContents, panelSession: ses }), /Node integration/);
  e.wc.prefs = { ...HARDENED, sandbox: false, nodeIntegrationInSubFrames: false };
  assert.throws(() => assertCdpTarget(e.wc, { appContents, panelSession: ses }), /not a sandboxed browser page/);
  e.wc.prefs = { ...HARDENED, webviewTag: true };
  assert.throws(() => assertCdpTarget(e.wc, { appContents, panelSession: ses }), /not a sandboxed browser page/);
  e.wc.prefs = { ...HARDENED, preload: '/x.js' };
  assert.throws(() => assertCdpTarget(e.wc, { appContents, panelSession: ses }), /preload/);
  e.wc.prefs = { ...HARDENED };
  assert.throws(() => assertCdpTarget(e.wc, { appContents, panelSession: { other: 1 } }), /partition/);
  assert.throws(() => assertCdpTarget(e.wc, { appContents: [e.wc], panelSession: ses }), /own window/);
});

test('Annotate: a view tab is a pane tab for any app window, in a pane session; guests still need their host', () => {
  const ses = { s: 1 };
  const { views } = setup();
  const e = views.create({ session: ses });
  e.wc.session = ses;
  assert.equal(isPaneTab(e.wc, { sender: new FakeWC(), panelSession: ses }), true);
  assert.equal(isPaneTab(e.wc, { sender: null, panelSession: [{}] }), false);
  const host = new FakeWC();
  const guest: any = Object.assign(new FakeWC(), { session: ses, hostWebContents: host, getType: () => 'webview' });
  assert.equal(isPaneTab(guest, { sender: host, panelSession: ses }), true);
  assert.equal(isPaneTab(guest, { sender: new FakeWC(), panelSession: ses }), false);
  e.wc.close();
  assert.equal(isPaneTab(e.wc, { sender: host, panelSession: ses }), false);
  assert.equal(isPaneTab(null, { sender: host, panelSession: ses }), false);
});

test('popup policy: a view tab opens popups as tabs through createWindow; notices of a view go to every window', () => {
  const ses = { s: 1 };
  const { views } = setup();
  const root = views.create({ session: ses });
  root.wc.session = ses;
  const broadcast: any[] = [];
  const opened: any[] = [];
  let handler: any = null;
  root.wc.setWindowOpenHandler = (fn: any) => (handler = fn);
  const bw = new BrowserWindows({
    BrowserWindow: { fromWebContents: () => null },
    appContents: () => [],
    panelSession: () => ses,
    openTab: (opener: any, options: any, url: string) => (opened.push([opener, options, url]), options.webContents),
    broadcast: (ch: string, p: any) => broadcast.push([ch, p]),
  });
  bw.register(root.wc);
  const popupWc = new FakeWC();
  const r = handler({ url: 'https://idp.test/auth' });
  assert.equal(r.action, 'allow');
  // a popup opened as a tab outlives its opener, as in Chrome: closing the tab it came from leaves it open (#1777)
  assert.equal(r.outlivesOpener, true);
  assert.equal(r.createWindow({ webContents: popupWc }), popupWc);
  assert.deepEqual(opened, [[root.wc, { webContents: popupWc }, 'https://idp.test/auth']]);
  assert.deepEqual(handler({ url: 'file:///x' }), { action: 'deny' });
  // notices: no host window, so every window gets them (a popup to a local file is a blocked address)
  assert.equal(broadcast[0][0], 'browser:event');
  assert.deepEqual([broadcast[0][1].kind, broadcast[0][1].reason], ['blocked', 'address']);
  root.wc.emit('did-start-loading');
  assert.equal(broadcast[1][1].kind, 'loading');
  root.wc.emit('destroyed');
  // without openTab (views off) a view's popups stay native windows, and without broadcast notices are dropped
  const plain = views.create({ session: ses });
  plain.wc.session = ses;
  let h2: any = null;
  plain.wc.setWindowOpenHandler = (fn: any) => (h2 = fn);
  const bw2 = new BrowserWindows({ BrowserWindow: { fromWebContents: () => null }, appContents: () => [], panelSession: () => ses });
  bw2.register(plain.wc);
  assert.equal(h2({ url: 'https://a.test/' }).overrideBrowserWindowOptions.width, 560);
  plain.wc.emit('did-start-loading');
  plain.wc.emit('destroyed');
});

test('shutdown closes shown and parked pages without recreating a parking window when the app window closes', () => {
  const { views, win, sender } = setup();
  const bound = views.bind('shown', sender, { url: 'about:blank' });
  const shown = views.entryOf(bound.id);
  const parked = views.create();
  views.show(shown.id, sender, { x: 0, y: 0, width: 800, height: 600 });
  const park = views.park;
  views.shutdown();
  assert.equal(shown.wc.destroyed, true);
  assert.equal(parked.wc.destroyed, true);
  assert.equal(park.destroyed, true);
  assert.equal(views.entries.size, 0);
  assert.equal(views.panes.size, 0);
  win.emit('closed');
  assert.equal(views.park, null);
  views.shutdown();
});

test('native popup cleanup of a windowless view restores surviving pages without dereferencing a guest host', () => {
  const { browserWorld } = require('./helpers/browser.cjs');
  const w = browserWorld();
  const { views } = setup();
  const root = views.create({ session: w.session });
  root.wc.session = w.session;
  let open: any;
  root.wc.setWindowOpenHandler = (handler: any) => (open = handler);
  let rootFocus = 0;
  root.wc.focus = () => rootFocus++;
  const manager = new BrowserWindows({
    ...w,
    BrowserWindow: {
      fromWebContents: (wc: any) => {
        assert.ok(wc, 'native window lookup requires actual contents');
        return w.wins.get(wc);
      },
    },
    appContents: () => [],
    panelSession: () => w.session,
  });
  manager.register(root.wc);
  assert.equal(open({ url: 'https://task.test/popup' }).overrideBrowserWindowOptions.parent, null);
  const first = w.popup();
  const second = w.popup();
  root.wc.emit('did-create-window', first);
  first.webContents.emit('did-create-window', second);
  assert.equal(manager.pages.size, 3);
  assert.doesNotThrow(() => second.close());
  assert.equal(first.focused, 2, 'the surviving native popup regains focus');
  assert.doesNotThrow(() => first.close());
  assert.equal(rootFocus, 1, 'the windowless view remains usable after the last popup closes');
  assert.equal(manager.pages.size, 1);
  root.wc.close();
  assert.equal(manager.pages.size, 0);
});
