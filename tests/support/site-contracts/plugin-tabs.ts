// Site-permission contract unit cases for plugin-tabs.
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { autoAttachParams, BrowserTabs, controlHandoff, usesInAppBrowser, S, CHAT, fakeTab, iab, iabTab, fs, os, path } from './fixture.ts';

export function registerPluginTabs() {
  test('CM-P10: a download the plugin starts is reported back to it until it finishes', async () => {
    const k = await iabTab();
    await k.cdp(k.tab, 'Runtime.evaluate');
    const host = new BrowserTabs({
      appContents: () => [],
      panelSession: () => null,
      open: () => false,
      downloadsDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p10-')),
    });
    const off = host.onDownload((c: any) => k.b.downloaded(c));
    // the real host's download: a tab of the chat an agent holds
    const tab = k.tab;
    tab.held = true;
    tab.downloads = [];
    host.chats.set(CHAT, { tabs: new Map([[tab.id, tab]]), changes: [] });
    const item: any = Object.assign(new EventEmitter(), {
      getFilename: () => 'report.pdf',
      getURL: () => 'https://shop.test/report.pdf',
      getTotalBytes: () => 0,
    });
    host.download(item, tab.wc);
    item.emit('updated');
    item.emit('done', {}, 'completed');
    const changes = k.notes.filter(([m]: any) => m === 'onDownloadChange').map(([, p]: any) => p);
    assert.deepEqual(
      changes.map((c: any) => c.status),
      ['started', 'in_progress', 'complete'],
    );
    assert.equal(changes[0].session_id, S);
    assert.equal(changes[0].tabId, k.b.idOf(tab));
    assert.equal(changes[0].url, 'https://shop.test/report.pdf');
    // a tab the plugin doesn't control is not reported; cancelled and failed downloads say so
    const other = fakeTab('tab_x');
    k.b.downloaded({ tab: other, id: 'x', url: '', filename: '', status: 'started' });
    const item2: any = Object.assign(new EventEmitter(), { getFilename: () => 'a.zip', getURL: () => 'https://shop.test/a.zip' });
    host.download(item2, tab.wc);
    item2.emit('done', {}, 'cancelled');
    const item3: any = Object.assign(new EventEmitter(), { getFilename: () => 'b.zip' });
    host.download(item3, tab.wc);
    item3.emit('done', {}, 'interrupted');
    const statuses = k.notes.filter(([m]: any) => m === 'onDownloadChange').map(([, p]: any) => p.status);
    assert.deepEqual(statuses.slice(-4), ['started', 'canceled', 'started', 'failed']);
    // a listener that throws doesn't stop the download
    host.onDownload(() => {
      throw new Error('x');
    });
    const item4: any = Object.assign(new EventEmitter(), { getFilename: () => 'c.zip' });
    assert.ok(host.download(item4, tab.wc));
    off();
  });

  test('CM-P11: the turn’s result tab is the one the plugin acted on last', async () => {
    const k = iab();
    await k.call('createTab');
    await k.call('createTab');
    const [first, second] = k.host.tabs;
    await k.cdp(first, 'Input.insertText', { text: 'a' });
    await k.cdp(second, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    assert.ok(second.used > first.used, 'the later action counts');
    // a viewport change is no action on the page
    const before = second.used;
    await k.cdp(second, 'Emulation.clearDeviceMetricsOverride');
    assert.equal(second.used, before);
  });

  test('CM-P12: a hand-off in the in-app browser shows as the in-app browser, not Chrome', () => {
    const item = (code: string, result = 'ok') => ({
      id: 'i1',
      type: 'mcpToolCall',
      server: 'cua_repl',
      tool: 'js',
      arguments: { code, title: 'Sign in needed' },
      status: 'completed',
      result: { content: [{ type: 'text', text: result }] },
    });
    assert.equal(controlHandoff(item('const b = await agent.browsers.get("iab"); await tab.markHandoff();'))?.where, 'app');
    assert.equal(controlHandoff(item('const b = await agent.browsers.get("chrome"); await tab.markHandoff();'))?.where, 'chrome');
    assert.equal(controlHandoff(item('await agent.browsers.get("iab")', 'user_took_over'))?.where, 'app');
    assert.equal(usesInAppBrowser('// iab\nconst x = 1'), false, 'a comment is not the backend');
  });
}

export function registerCrashedTab() {
  test('CM-P23: on a crashed tab the plugin hears that it crashed and to reload, and a reload or navigation still goes', async () => {
    const k = await iabTab();
    k.tab.rendererGone = () => true;
    // a read or an action gets the crash and the way back, not the debugger's bare "Target crashed"; nothing is sent
    await assert.rejects(
      k.cdp(k.tab, 'Runtime.evaluate', { expression: '1' }),
      /crashed \(its renderer is gone\)\. Reload it with Page\.reload/,
    );
    await assert.rejects(k.cdp(k.tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }), /crashed/);
    assert.deepEqual(k.tab.sent, []);
    // a reload and a navigation go on (the browser runs them, renderer or not)
    await k.cdp(k.tab, 'Page.reload');
    await k.cdp(k.tab, 'Page.navigate', { url: 'https://example.com/' });
    assert.deepEqual(
      k.tab.sent.map(([m]: any[]) => m),
      // the reload first reads the history: a form result is never resubmitted
      ['Page.getNavigationHistory', 'Page.reload', 'Page.navigate'],
    );
    // once the renderer is back, commands reach the page again
    k.tab.rendererGone = () => false;
    await k.cdp(k.tab, 'Runtime.evaluate', { expression: '1' });
    assert.ok(k.tab.sent.some(([m]: any[]) => m === 'Runtime.evaluate'));
  });
}

export function registerCrashedMidCommand() {
  test('CM-P23b: a page that crashes while a command runs (a navigation still loading) tells the plugin to reload, not "Target crashed" (#1561)', async () => {
    const k = await iabTab();
    const send = k.tab.send;
    // the renderer goes while the navigation loads: the debugger answers only "Target crashed"
    k.tab.send = async () => {
      k.tab.rendererGone = () => true;
      throw new Error('Target crashed');
    };
    await assert.rejects(
      k.cdp(k.tab, 'Page.navigate', { url: 'https://example.com/' }),
      /crashed \(its renderer is gone\)\. Reload it with Page\.reload/,
    );
    // the shared sender's own "crashed" (an error coded page_crashed) gets the plugin's CDP-worded note too
    k.tab.rendererGone = () => false;
    k.tab.send = async () => {
      k.tab.rendererGone = () => true;
      throw Object.assign(new Error('This page crashed. Reload it before continuing.'), { code: 'page_crashed' });
    };
    await assert.rejects(k.cdp(k.tab, 'Runtime.evaluate', { expression: '1' }), /Reload it with Page\.reload/);
    // an error with its own reason (the tab closed) is passed on as it was, even with the renderer gone
    const closed = Object.assign(new Error('Tab 1 was closed.'), { code: 'tab_closed' });
    k.tab.rendererGone = () => false;
    k.tab.send = async () => {
      k.tab.rendererGone = () => true;
      throw closed;
    };
    await assert.rejects(k.cdp(k.tab, 'Runtime.evaluate', { expression: '1' }), (e: unknown) => e === closed);
    // a failure with the renderer still there is passed on as it was (the same error)
    k.tab.rendererGone = () => false;
    const own = new Error('Cannot find context with specified id');
    k.tab.send = async () => {
      throw own;
    };
    await assert.rejects(k.cdp(k.tab, 'Runtime.evaluate', { expression: '1' }), (e: unknown) => e === own);
    k.tab.send = send;
  });
}

export function registerViewport() {
  test('CM-P17: viewport changes stay on the plugin’s tabs, visibility can’t hide the pane, and stale turn ends change nothing', async () => {
    const k = await iabTab();
    // no tab held yet: nothing to size
    await assert.rejects(
      k.call('executeUnhandledCommand', { type: 'browser_viewport_set', width: 400, height: 800 }),
      /attach a tab first/,
    );
    assert.equal(k.b.viewport, null, 'a refused size is not kept for later tabs');
    await k.cdp(k.tab, 'Runtime.evaluate');
    await k.call('executeUnhandledCommand', { type: 'browser_viewport_set', width: 400, height: 800 });
    assert.deepEqual(k.tab.sent.at(-1), [
      'Emulation.setDeviceMetricsOverride',
      { width: 400, height: 800, deviceScaleFactor: 0, mobile: false },
      '',
    ]);
    await assert.rejects(k.call('executeUnhandledCommand', { type: 'browser_viewport_set', width: 0, height: 1 }), /positive integer/);
    // a tab the plugin attaches later gets it too
    await k.call('createTab');
    const later = k.host.tabs[1];
    await k.cdp(later, 'Runtime.evaluate');
    assert.equal(later.sent[0][0], 'Emulation.setDeviceMetricsOverride');
    // a tab whose device the user picked keeps it
    await k.call('createTab');
    const device = k.host.tabs[2];
    device.emulated = { device: 'Pixel' };
    await k.cdp(device, 'Runtime.evaluate');
    assert.deepEqual(
      device.sent.map(([m]: any) => m),
      ['Runtime.evaluate'],
    );
    // reset: back to the pane's own size; a device the user picked stays
    later.emulated = { device: 'iPhone' };
    await k.call('executeUnhandledCommand', { type: 'browser_viewport_reset' });
    assert.equal(k.tab.sent.at(-1)[0], 'Emulation.clearDeviceMetricsOverride');
    assert.equal(later.sent.at(-1)[0], 'Runtime.evaluate', 'the user’s device emulation is left alone');
    await k.call('executeUnhandledCommand', { type: 'browser_viewport_set', width: 500, height: 500 });
    await k.call('executeUnhandledCommand', { type: 'browser_viewport_reset' });
    assert.equal(k.tab.sent.at(-1)[0], 'Emulation.clearDeviceMetricsOverride');
    // visibility: the plugin may show its tab, never hide the pane
    k.tab.layer = 'front';
    await assert.rejects(k.call('executeUnhandledCommand', { type: 'browser_visibility_set', visible: false }), /can't be hidden/);
    assert.deepEqual(await k.call('executeUnhandledCommand', { type: 'browser_visibility_set', visible: true }), {});
    // a fresh chat (cua.createBrowserTab sets visibility before tabs.new): shown or not, it applies to the tab opened next
    const empty = iab();
    assert.deepEqual(await empty.call('executeUnhandledCommand', { type: 'browser_visibility_set', visible: true }), {});
    assert.deepEqual(await empty.call('executeUnhandledCommand', { type: 'browser_visibility_set', visible: false }), {});
    // auto-attach keeps MoPilot's flat sessions on
    await k.cdp(k.tab, 'Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: true, flatten: false, filter: [] });
    assert.deepEqual(k.tab.sent.at(-1)[1], { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [] });
    assert.deepEqual(autoAttachParams({}), { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    // a turnEnded for an older turn is stale; a cached request doesn't move the turn
    await k.b.handle('getTabs', { session_id: S, turn_id: 'turn-2' });
    await k.b.handle('getTabs', { session_id: S, turn_id: 'turn-1', session_context: 'cached' });
    await k.b.handle('turnEnded', { session_id: S, turn_id: 'turn-1' });
    assert.equal(k.b.held.size, 3, 'still held');
    await k.b.handle('turnEnded', { session_id: S, turn_id: 'turn-2' });
    assert.equal(k.b.held.size, 0);
  });

  test('CM-P17b: a mark lasts for its turn and the user’s turn after it, then lapses', async () => {
    const host = new BrowserTabs({ appContents: () => [], panelSession: () => null, open: () => false, close: () => {}, select: () => {} });
    const t = fakeTab('tab_1');
    t.created = false;
    t.detach = () => {};
    host.chats.set(CHAT, { tabs: new Map([[t.id, t]]), selected: t.id, changes: [], revealed: null, revealOff: false, orphans: new Map() });
    host.mark(CHAT, t.id, 'handoff');
    await host.turnEnded(CHAT);
    assert.equal(t.mark, 'handoff', 'kept through the user’s turn');
    await host.turnEnded(CHAT);
    assert.equal(t.mark, null, 'lapsed at the next turn’s end');
    host.forget(CHAT);
    assert.equal(host.turnsEnded.has(CHAT), false);
  });

  test('CM-P17c: a popup whose opener the user took over, a sign-in there, and an open dialog stop the plugin’s writes', async () => {
    const k = await iabTab();
    const popup = fakeTab('popup_1');
    popup.kind = 'popup';
    popup.root = k.tab;
    k.host.tabs.push(popup);
    k.tab.takenOver = true;
    await assert.rejects(k.cdp(popup, 'Input.insertText', { text: 'x' }), (e: any) => e.code === 'taken_over');
    await assert.rejects(k.cdp(popup, 'Page.navigate', { url: 'https://shop.test/b' }), (e: any) => e.code === 'taken_over');
    k.tab.takenOver = false;
    k.tab.signin = { reason: 'x' };
    await assert.rejects(k.cdp(popup, 'Runtime.evaluate'), (e: any) => e.code === 'signin_pending');
    k.tab.signin = null;
    // an open dialog: input waits for the answer; accepting a sensitive one asks
    k.tab.dialog = { type: 'confirm', message: 'Delete this project?' };
    await assert.rejects(k.cdp(k.tab, 'Input.insertText', { text: 'x' }), /dialog is open/);
    await k.cdp(k.tab, 'Page.handleJavaScriptDialog', { accept: true });
    assert.equal(k.confirmed.at(-1).sensitive.verb, 'delete something');
    // dismissing is a read: no card
    const before = k.confirmed.length;
    await k.cdp(k.tab, 'Page.handleJavaScriptDialog', { accept: false });
    assert.equal(k.confirmed.length, before);
  });
}
