// Electron main browser-views wiring unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { flush, calls, peerMain } from './fixture';

export function registerBrowserViewsCases() {
  test('pane tabs as views: agents open tabs with no window, popups become tabs, closing and selecting go through main', async () => {
    const h = await peerMain();
    await flush();
    const flags = h.mod('platform/flags.cjs').isEnabled;
    flags.mock.mockImplementation(() => true);
    const views = h.one('PaneViews');
    const tabs = h.one('BrowserTabs');
    const panel = h.one('PanelBrowser');
    const o = tabs.opts;
    const w = h.windows[0];
    // what main gives the views: partitions, app windows only, agents' tabs by key, the page policy
    assert.equal(views.opts.session('persist:browser'), h.partitions.get('persist:browser'));
    assert.equal(views.opts.partition('anything'), 'persist:browser');
    assert.equal(views.opts.windowOf(w.webContents), w);
    assert.equal(views.opts.windowOf(h.wc()), null);
    assert.equal(views.opts.windowOf(h.wc({ destroyed: true })), null);
    assert.equal(views.opts.windowOf(null), null);
    const agentWc = h.wc();
    tabs.byKey = mock.fn(() => ({ wc: agentWc }));
    assert.equal(views.opts.agentView('c', 'k'), agentWc);
    tabs.byKey = mock.fn(() => null);
    assert.equal(views.opts.agentView('c', null), null);
    // the agent cursor glides only on a page the user sees: a view in a shown window, a <webview> in front
    const seen = (tab: any) => o.cursor.shown(tab);
    const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
    const { entryOf, windowOf } = views;
    views.entryOf = mock.fn(() => ({}));
    views.windowOf = mock.fn(() => win);
    assert.equal(seen({ wc: agentWc }), true);
    views.windowOf = mock.fn(() => null);
    assert.equal(seen({ wc: agentWc }), false, 'a parked view (a hidden pane, no window)');
    views.entryOf = mock.fn(() => null);
    assert.equal(seen({ wc: agentWc, layer: 'front' }), false, 'a <webview> with no host window');
    Object.assign(views, { entryOf, windowOf });
    const bw = h.one('BrowserWindows');
    for (const state of [{}, { prefs: {} }, { prefs: { keybindings: { pin: null } } }]) {
      h.writeState(state);
      assert.deepEqual(bw.opts.shortcutBindings(), state.prefs?.keybindings ?? {});
    }
    const page = h.wc();
    views.opts.onCreated(page);
    assert.deepEqual(calls(bw.register), [[page]]);
    assert.equal(typeof bw.opts.broadcast, 'function');
    // an agent's tab: a view in the chat's partition, kept when windows go; none with views off
    const spawned = o.spawn('c');
    assert.equal(spawned.id, 77);
    assert.deepEqual(calls(views.create).at(-1), [{ partition: 'persist:browser', url: 'about:blank', history: null }]);
    flags.mock.mockImplementation((k: string) => k !== 'shared.browser.viewTabs');
    assert.equal(o.spawn('c'), null);
    flags.mock.mockImplementation(() => true);
    // a duplicate's view gets the copied history instead of a page (views.cjs writes it first, #1362)
    const copy = { entries: [{ url: 'https://a.test/', title: 'A' }], index: 0 };
    o.spawn('c', copy);
    assert.deepEqual(calls(views.create).at(-1), [{ partition: 'persist:browser', url: 'about:blank', history: copy }]);
    // sage_browser_* with no tab: the chat's original tab as a view, attached at once, shown in a window
    tabs.current = () => null;
    tabs.attach = mock.fn();
    panel.attach = mock.fn();
    assert.equal(panel.opts.open('c'), undefined);
    assert.deepEqual(calls(tabs.attach).at(-1), ['c', null, spawned, null]);
    assert.deepEqual(calls(panel.attach).at(-1), ['c', spawned, null]);
    assert.deepEqual(w.webContents.on_('app:command').at(-1), ['open-agent-browser-tab', 'c']);
    // close: main closes the view and every window drops the pane tab; select opens or fronts the pane tab
    await h.invoke('window:open');
    const w2 = h.windows[1];
    views.close = mock.fn(() => true);
    o.close({ kind: 'tab', chatId: 'c', id: 't1', wc: agentWc });
    o.close({ kind: 'tab', chatId: 'c', id: 't0', wc: agentWc, legacy: true });
    for (const win of [w, w2])
      assert.deepEqual(win.webContents.on_('app:command').slice(-2), [
        ['close-agent-browser-tab', { chatId: 'c', tabKey: 't1' }],
        ['close-agent-browser-tab', { chatId: 'c', tabKey: null }],
      ]);
    views.entryOf = mock.fn(() => ({}));
    views.windowOf = mock.fn(() => w2);
    o.select({ kind: 'tab', chatId: 'c', id: 't1', wc: agentWc });
    assert.deepEqual(w2.webContents.on_('app:command').at(-1), ['open-agent-browser-tab', { chatId: 'c', tabKey: 't1', focus: true }]);
    // an automatic select says so, for the pane to keep a closed pane closed on a tab the user saw
    o.select({ kind: 'tab', chatId: 'c', id: 't1', wc: agentWc }, { auto: true });
    assert.deepEqual(w2.webContents.on_('app:command').at(-1), [
      'open-agent-browser-tab',
      { chatId: 'c', tabKey: 't1', focus: true, auto: true },
    ]);
    // with no window showing it: the focused window, else the main one; none at all is fine
    views.windowOf = mock.fn(() => null);
    h.ui.focused = w2;
    o.select({ kind: 'tab', chatId: 'c', id: 't2', wc: agentWc, legacy: true });
    assert.deepEqual(w2.webContents.on_('app:command').at(-1), ['open-agent-browser-tab', { chatId: 'c', tabKey: null, focus: true }]);
    h.ui.focused = null;
    w.close();
    w2.close();
    o.select({ kind: 'tab', chatId: 'c', id: 't3', wc: agentWc });
    // a popup of a view tab: the popup's own webContents wrapped, an agent tab of the chat or a user's pane tab
    await h.invoke('window:open');
    const w3 = h.windows.at(-1);
    const opener = h.wc({ session: 'opener-session' });
    const popupWc = h.wc();
    views.entryOf = mock.fn((x: any) => (x === opener ? { keep: true } : null));
    tabs.adoptPopup = mock.fn(() => ({ chatId: 'c', id: 'tab_pop' }));
    panel.registerPopup = mock.fn(() => {
      throw new Error('not followed');
    });
    const openTab = bw.opts.openTab;
    assert.equal(openTab(opener, { webContents: popupWc }, 'https://idp.test/'), popupWc);
    assert.equal(calls(views.adopt).at(-1)[0], popupWc);
    assert.equal(views.adopt.mock.calls.at(-1).result.keep, true);
    assert.deepEqual(calls(tabs.adoptPopup).at(-1), [opener, popupWc, { asTab: true }]);
    assert.deepEqual(w3.webContents.on_('app:command').at(-1), ['open-agent-browser-tab', { chatId: 'c', tabKey: 'tab_pop', focus: true }]);
    tabs.adoptPopup = mock.fn(() => null);
    panel.registerPopup = mock.fn();
    views.name = mock.fn();
    const made = openTab(h.wc(), {}, 'https://b.test/');
    assert.equal(made.id, 77);
    assert.deepEqual(calls(views.create).at(-1), [{ session: null, url: 'https://b.test/' }]);
    const [cmd, req] = w3.webContents.on_('app:command').at(-1);
    assert.equal(cmd, 'open-browser-view');
    assert.match(req.paneId, /^browser-[0-9a-f-]{36}$/);
    assert.deepEqual({ ...req, paneId: 0 }, { paneId: 0, url: 'https://b.test/', title: 'https://b.test/', opener: undefined });
    assert.equal(calls(views.name).at(-1)[1], req.paneId);
    assert.equal(openTab(h.wc(), null, 'https://c.test/').id, 77);
    // a user's tab names its pane tab, so the popup joins the opener's chat rather than the one on screen
    const userTab = h.wc();
    views.entryOf = mock.fn((x: any) => (x === userTab ? { keep: false, panes: new Set(['browser-o']) } : null));
    openTab(userTab, {}, 'https://d.test/');
    const [, named] = w3.webContents.on_('app:command').at(-1);
    assert.equal(named.opener, 'browser-o');
  });

  test('pane tabs as views: no <webview> may attach; the parking window goes when the last window closes where that quits', async () => {
    const h = await peerMain();
    await flush();
    const flags = h.mod('platform/flags.cjs').isEnabled;
    flags.mock.mockImplementation(() => true);
    const guest = h.wc({ type: 'webview' });
    h.app.emit('web-contents-created', {}, guest);
    const ev = { preventDefault: mock.fn() };
    const prefs: any = { preload: '/p.js' };
    guest.emit('will-attach-webview', ev, prefs, { partition: 'persist:browser' });
    assert.equal(calls(ev.preventDefault).length, 1);
    assert.equal(prefs.preload, '/p.js', 'refused before any admission');
    const views = h.one('PaneViews');
    views.dropPark = mock.fn();
    views.shutdown = mock.fn();
    h.app.emit('before-quit', { defaultPrevented: true, preventDefault: mock.fn() });
    assert.equal(calls(views.shutdown).length, 0, 'a canceled quit preserves browser pages');
    h.app.emit('before-quit', { defaultPrevented: false, preventDefault: mock.fn() });
    assert.equal(calls(views.shutdown).length, 1, 'a confirmed quit releases pages before windows close');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const closing = (p: string) => {
      Object.defineProperty(process, 'platform', { value: p });
      const win = new EventEmitter();
      h.app.emit('browser-window-created', {}, win);
      win.emit('closed');
      Object.defineProperty(process, 'platform', platform);
    };
    closing('darwin');
    closing('linux');
    assert.equal(calls(views.dropPark).length, 0, 'an app window is still open');
    h.windows[0].close();
    closing('linux');
    assert.equal(calls(views.dropPark).length, 1);
    // the pane's view IPC sees main's views
    const [, live] = calls(h.mod('capabilities/browser/views.cjs').registerViewIpc)[0];
    assert.equal(live(), views);
  });
}
