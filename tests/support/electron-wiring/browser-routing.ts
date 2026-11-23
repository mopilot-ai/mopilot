// Electron main browser-routing wiring unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { flush, calls, peerMain } from './fixture';

export function registerBrowserRoutingCases() {
  test("sage_browser_* opens on the chat's current agent tab when it has one", async () => {
    const h = await peerMain();
    await flush();
    const panel = h.one('PanelBrowser');
    const tabs = h.one('BrowserTabs');
    const wc = h.wc();
    const owner = h.windows[0].webContents;
    tabs.current = () => ({ kind: 'tab', wc, owner });
    panel.attach = mock.fn();
    assert.equal(panel.opts.open('c'), undefined);
    assert.deepEqual(calls(panel.attach), [['c', wc, owner]]);
    assert.deepEqual(owner.on_('app:command'), []);
    // a tab it cannot drive, or a popup, opens a new pane tab instead
    panel.attach = () => {
      throw new Error('not a guest');
    };
    panel.opts.open('c');
    tabs.current = () => ({ kind: 'popup', wc });
    panel.opts.open('d');
    assert.deepEqual(owner.on_('app:command'), [
      ['open-agent-browser-tab', 'c'],
      ['open-agent-browser-tab', 'd'],
    ]);
  });

  test('agent browser tabs open, close and select in the window that owns them', async () => {
    const h = await peerMain();
    await flush();
    const o = h.one('BrowserTabs').opts;
    const w = h.windows[0];
    assert.deepEqual(o.appContents(), [w.webContents]);
    assert.deepEqual(
      o.panelSession().map((s: any) => s === h.partitions.get('persist:browser')),
      [true],
      'the shared profile, before any chat has its own',
    );
    // open: the owner's window, else the focused one (never Quick Chat), else the main window
    await h.invoke('window:open');
    const w2 = h.windows[1];
    o.open('c', { tabKey: 'k', focus: true, owner: w2.webContents });
    assert.deepEqual(w2.webContents.on_('app:command'), [['open-agent-browser-tab', { chatId: 'c', tabKey: 'k', focus: true }]]);
    // a duplicate names its source, which the pane puts it beside (#1362)
    o.open('c', { tabKey: 'k2', focus: false, owner: h.wc(), after: 'k' });
    assert.deepEqual(w.webContents.on_('app:command').at(-1), [
      'open-agent-browser-tab',
      { chatId: 'c', tabKey: 'k2', focus: false, after: 'k' },
    ]);
    h.ui.focused = w2;
    o.open('c', { tabKey: 'k3', owner: h.wc({ destroyed: true }) });
    assert.deepEqual(w2.webContents.on_('app:command').at(-1), ['open-agent-browser-tab', { chatId: 'c', tabKey: 'k3', focus: undefined }]);
    h.ui.focused = null;
    w.close();
    w2.close();
    assert.equal(o.open('c', { tabKey: 'k4', owner: null }), false);
    // close and select: a popup through its own window, a pane tab through its owner while it is open
    await h.invoke('window:open');
    const popupWin = h.windows.at(-1);
    const popup = { kind: 'popup', wc: popupWin.webContents };
    o.select(popup);
    assert.deepEqual(popupWin.log.slice(-2), ['show', 'focus']);
    o.close(popup);
    assert.equal(popupWin.destroyed, true);
    assert.equal(o.close({ kind: 'popup', wc: h.wc() }), undefined);
    o.select({ kind: 'popup', wc: h.wc() });
    const owner = h.wc();
    o.close({ kind: 'tab', chatId: 'c', id: 't1', owner });
    o.close({ kind: 'tab', chatId: 'c', id: 't2', owner, legacy: true });
    o.select({ kind: 'tab', chatId: 'c', id: 't1', owner });
    o.select({ kind: 'tab', chatId: 'c', id: 't2', owner, legacy: true });
    o.select({ kind: 'tab', chatId: 'c', id: 't1', owner }, { auto: true });
    assert.deepEqual(owner.on_('app:command'), [
      ['close-agent-browser-tab', { chatId: 'c', tabKey: 't1' }],
      ['close-agent-browser-tab', { chatId: 'c', tabKey: null }],
      ['select-agent-browser-tab', { chatId: 'c', tabKey: 't1' }],
      ['select-agent-browser-tab', { chatId: 'c', tabKey: null }],
      ['select-agent-browser-tab', { chatId: 'c', tabKey: 't1', auto: true }],
    ]);
    const gone = h.wc({ destroyed: true });
    o.close({ kind: 'tab', chatId: 'c', id: 't', owner: gone });
    o.select({ kind: 'tab', chatId: 'c', id: 't', owner: gone });
    o.close({ kind: 'tab', chatId: 'c', id: 't', owner: null });
    o.select({ kind: 'tab', chatId: 'c', id: 't', owner: null });
    assert.deepEqual(gone.sent, []);
    // screenshots, and each chat's own downloads folder
    h.electron.nativeImage.createFromBuffer = mock.fn((buf: any) => ({ image: buf }));
    assert.deepEqual(o.images.fromBuffer('png'), { image: 'png' });
    const dir = path.join(h.userData, 'capabilities', 'browser-downloads');
    assert.equal(o.downloadsDir('a/b c'), path.join(dir, 'a_b_c'));
    assert.equal(o.downloadsDir(''), path.join(dir, 'chat'));
    // Stop in the browser pane stops the chat's turn
    const ctl = h.one('ChatController');
    assert.equal(await h.invoke('browser:stopAgent', 'c'), true);
    assert.deepEqual(calls(ctl.stopChat), [['c']]);
  });

  test('browser host tools follow the in-app browser switch, confirm each risky call and use per-chat folders', async () => {
    const h = await peerMain();
    await flush();
    const [registry, o] = calls(h.mod('capabilities/browser/hostTools.cjs').registerBrowserTools)[0];
    // they register on main's Registry through action memory's recorder (app/routines.cjs, G4), which passes it through
    h.one('Registry').probe = 'main-registry';
    assert.equal(registry.probe, 'main-registry');
    // the tools get the tabs of every Host (tabsByHost.cjs), which answer for this Mac's like the BrowserTabs behind them
    h.one('BrowserTabs').marker = 'this-mac';
    assert.equal(o.tabs.marker, 'this-mac');
    assert.equal(o.grants, h.one('OriginGrants'));
    assert.equal(o.enabled(), 'in-app');
    assert.deepEqual(calls(h.mod('capabilities/browser/hostTools.cjs').inAppBrowserEnabled)[0], [h.mod('platform/flags.cjs').isEnabled]);
    h.one('ChatController').ref = () => ({ kind: 'codex' });
    const broker = h.inst.computerUse[0].broker;
    broker.ask = mock.fn(async () => ({ decision: 'allow' }));
    assert.equal(await o.confirm({ chatId: 'c' }, { tool: 'JavaScript', origin: 'https://a', summary: 's' }), true);
    broker.ask = mock.fn(async () => null);
    assert.equal(await o.confirm({ chatId: 'c' }, { tool: 'upload', origin: 'https://a', summary: 's' }), false);
    const card = calls(broker.ask)[0];
    assert.deepEqual(
      [card[0], card[1], card[2].verb, card[2].app],
      ['c', 'computerConfirm', 'upload files', { bundleId: 'https://a', name: 'https://a' }],
    );
    // browser_request_credentials: the sheet's IPC and pushes, and a refusal in the user's own Chrome
    const w = h.windows[0];
    const pushes = w.webContents.on_('browser:credentialRequestsChanged').length;
    const sheet = o.credentials.ask({ chatId: 'c', tabId: 't1', origin: 'https://a', frameOrigin: '', reason: '', fields: [] });
    assert.equal(w.webContents.on_('browser:credentialRequestsChanged').length, pushes + 1);
    assert.equal((await h.invoke('browser:credentialRequests'))[0].canSave, false, 'no OS key in the harness: nothing is saved');
    assert.equal(await h.invoke('browser:credentialAnswer', sheet.id, { action: 'decline' }), true);
    assert.equal(await h.invoke('browser:credentialForget', 'none'), false);
    const control = h.one('BrowserControl');
    const inApp = h.one('BrowserTabs');
    // a chat working in an in-app tab this turn (the agent holds it); an older tab doesn't count
    inApp.current = (id: string) => (id === 'working' ? { id: 'tab-1', held: true } : id === 'c' ? { id: 'old', held: false } : null);
    control.drivesUserChrome = () => true;
    assert.equal(o.chromeRoute('c'), 'Your Chrome');
    assert.equal(o.chromeRoute('working'), null, 'a chat working in an in-app tab is not in Chrome, whatever the channel');
    control.drivesUserChrome = () => false;
    h.one('SessionStore').get = (id: string) => (id === 'linked' || id === 'working' ? { chromeLink: { connected: true } } : {});
    // the vendor that drives the chat's Chrome is the one its current segment's controller plan names
    const plans = h.one('ControllerPlans');
    // the plan reads which native Codex threads MoPilot serves Chrome to at each decision (#1319 G2), never once at startup
    const backends = plans.opts.inputs.planInputs.codex.chromeBackend();
    assert.ok(backends === undefined || backends === null || typeof backends.has === 'function');
    plans.current = (id: string) =>
      id === 'switched' ? { bu: 'codex-browser-plugin' } : id === 'c' ? { bu: null } : { bu: 'claude-in-chrome' };
    // Claude in Chrome is the route only while the chat runs on Claude Code (CM-B03)
    h.one('ChatController').ref = (id: string) =>
      id === 'switched' ? { kind: 'codex', id: 't', key: 't' } : { kind: 'claude', key: `claude:${id}` };
    assert.equal(o.chromeRoute('linked'), 'Claude in Chrome');
    assert.equal(o.chromeRoute('working'), null, 'nor with Claude in Chrome connected');
    assert.equal(o.chromeRoute('c'), null);
    // a link that dropped: the chat's browser is not Chrome now
    h.one('SessionStore').get = (id: string) => (id === 'linked' ? { chromeLink: { connected: false } } : {});
    assert.equal(o.chromeRoute('linked'), null);
    // a native Codex thread whose plugin drives Chrome
    assert.equal(o.chromeRoute('switched'), 'the Codex Browser plugin in your Chrome');
    // a Claude segment still linked whose plan says Your Chrome (its CLI runs none): not Claude in Chrome
    h.one('SessionStore').get = () => ({ chromeLink: { connected: true } });
    assert.equal(o.chromeRoute('c'), null);
    plans.current = () => null;
    assert.equal(o.chromeRoute('linked'), null, 'no plan (a chat whose segment cannot be read): no vendor');
    const dir = path.join(h.userData, 'capabilities');
    assert.deepEqual(o.folders('c'), {
      uploads: path.join(dir, 'browser-uploads', 'c'),
      downloads: path.join(dir, 'browser-downloads', 'c'),
    });
  });

  test('browser IPC: attaching tabs without a key, laying out guests, and popups the pane opens', async () => {
    const h = await peerMain();
    await flush();
    const tabs = h.one('BrowserTabs');
    const panel = h.one('PanelBrowser');
    const guest = h.wc();
    const sender = h.windows[0].webContents;
    assert.equal(await h.invokeFrom(sender, 'browser:attach', 'c', guest.id, 5), true);
    assert.equal(await h.invokeFrom(sender, 'browser:attach', 'c', guest.id, 'k'), true);
    assert.deepEqual(calls(tabs.attach), [
      ['c', null, guest, sender],
      ['c', 'k', guest, sender],
    ]);
    assert.deepEqual(calls(panel.attach), [['c', guest, sender]], "only a tab without a key is also sage_browser_*'s");
    tabs.layer = mock.fn(() => 1);
    assert.equal(await h.invokeFrom(sender, 'browser:layer', guest.id, { x: 1 }), true);
    assert.deepEqual(calls(tabs.layer), [[guest, { x: 1 }, sender]]);
    tabs.layer = () => {
      throw new Error('not a guest');
    };
    assert.equal(await h.invoke('browser:layer', 1, {}), false);
    // pop-up windows the pane's pages open
    const bw = h.one('BrowserWindows').opts;
    assert.deepEqual(bw.appContents(), [sender]);
    assert.deepEqual(
      bw.panelSession().map((s: any) => s === h.partitions.get('persist:browser')),
      [true],
      'the shared profile, before any chat has its own',
    );
    bw.onPopup('opener', 'popup');
    assert.deepEqual(calls(panel.registerPopup), [['opener', 'popup']]);
    assert.deepEqual(calls(tabs.adoptPopup), [['opener', 'popup']]);
    // an agent's download goes to its chat's folder
    const ses = h.partitions.get('persist:browser');
    tabs.download = mock.fn(() => '/chat/downloads/file.pdf');
    const item = Object.assign(new EventEmitter(), { getFilename: () => 'file.pdf', setSavePath: mock.fn() });
    ses.emit('will-download', {}, item, guest);
    assert.deepEqual(calls(item.setSavePath), [['/chat/downloads/file.pdf']]);
    assert.deepEqual(calls(tabs.download), [[item, guest]]);
    // an agent's destination failure is canceled at the same event boundary, never redirected to the user's folder
    tabs.download = () => {
      throw new Error('cannot inspect agent download folder');
    };
    const failed = Object.assign(new EventEmitter(), {
      getFilename: mock.fn(() => 'blocked.pdf'),
      setSavePath: mock.fn(),
      cancel: mock.fn(),
    });
    assert.doesNotThrow(() => ses.emit('will-download', {}, failed, guest));
    assert.equal(failed.cancel.mock.callCount(), 1);
    assert.equal(failed.setSavePath.mock.callCount(), 0);
    assert.equal(failed.getFilename.mock.callCount(), 0, 'no fallback into the user download folder');
  });

  test('continuing in Chrome commits the channel to prefs and announces it', async () => {
    const h = await peerMain();
    await flush();
    const w = h.windows[0];
    const { handoffOpts: o } = await h.invokeFrom(w.webContents, 'browser:continueInChrome', { url: 'https://a' });
    assert.equal(o.isEnabled(), true);
    assert.equal(o.getPrefs().channel, 'builtin');
    o.commitPrefs({ channel: 'chrome', profileDir: '/p' });
    assert.deepEqual(o.getPrefs(), { channel: 'chrome', profileDir: '/p' });
    const patchPrefs = h.mod('platform/chats.cjs').patchPrefs;
    assert.deepEqual(calls(patchPrefs).at(-1), [path.join(h.userData, 'ui-state.json'), { browserChannel: 'chrome' }]);
    assert.deepEqual(w.webContents.on_('prefs:changed').at(-1), [{ set: { browserChannel: 'chrome' }, unset: [] }]);
    const before = w.webContents.on_('browser:channelChanged').length;
    o.changed();
    assert.equal(w.webContents.on_('browser:channelChanged').length, before + 1);
    // the hand-off's route reads the channel that runs, not the preference: with MoPilot's extension serving
    // Chrome, a Chrome preference runs the built-in tools and never the relay's Your Chrome (control.cjs)
    const control = h.one('BrowserControl');
    for (const [drives, channel] of [
      [true, 'chrome'],
      [false, 'builtin'],
    ] as const) {
      control.drivesUserChrome = () => drives;
      assert.equal(o.route('c'), channel);
    }
    // the panel names its page; the ways-forward strip only its chat: the chat's current agent tab, if any
    const page = (r: any) => h.invokeFrom(w.webContents, 'browser:continueInChrome', r).then((x: any) => x.request);
    assert.deepEqual(await page({ webContentsId: 10, chatId: 'c', url: 'https://a' }), {
      webContentsId: 10,
      chatId: 'c',
      url: 'https://a',
    });
    const tabs = h.one('BrowserTabs');
    tabs.current = mock.fn((chatId: string) => (chatId === 'c' ? { wc: { id: 42 } } : null));
    assert.deepEqual(await page({ chatId: 'c', url: 'https://a' }), { webContentsId: 42, chatId: 'c', url: 'https://a' });
    assert.deepEqual(await page({ chatId: 'd', url: 'https://a' }), { webContentsId: undefined, chatId: 'd', url: 'https://a' });
    assert.deepEqual(await page({ chatId: 7, url: 'https://a' }), { webContentsId: undefined, chatId: 7, url: 'https://a' });
    assert.equal(await page(null), null);
    // Cancel goes to the same page check and the chats' Chrome instances
    const cancel = await h.invokeFrom(w.webContents, 'browser:cancelChromeHandoff', { webContentsId: 10, chatId: 'c' });
    assert.deepEqual(cancel.request, { webContentsId: 10, chatId: 'c' });
    assert.equal(cancel.sender, w.webContents);
    assert.equal(cancel.cancelOpts.browserWindows, o.browserWindows);
    assert.equal(cancel.cancelOpts.chromeChannel, o.chromeChannel);
  });
}
