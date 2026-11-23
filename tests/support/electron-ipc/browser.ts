// Electron IPC browser unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { calls, ready } from './fixture';

export function registerBrowserCases() {
  test('browser data, downloads, panel tabs and site permissions', async () => {
    const h = await ready();
    const ses = h.partitions.get('persist:browser');
    await h.invoke('browser:clearData');
    assert.deepEqual(
      [ses.clearStorageData.mock.callCount(), ses.clearCache.mock.callCount(), ses.clearHistory.mock.callCount()],
      [1, 1, 1],
    );
    ses.clearHistory = undefined;
    await h.invoke('browser:clearData');
    const panel = h.one('PanelBrowser');
    const guest = h.wc();
    assert.equal(await h.invoke('browser:attach', 'c', guest.id), true);
    assert.deepEqual(calls(panel.attach)[0].slice(0, 2), ['c', guest]);
    panel.attach = () => {
      throw new Error('not a panel guest');
    };
    assert.equal(await h.invoke('browser:attach', 'c', 999), false);
    const grants = h.one('OriginGrants');
    assert.deepEqual(await h.invoke('browser:sites'), ['site']);
    assert.deepEqual(await h.invoke('browser:setSite', 'https://a', undefined), ['site']);
    await h.invoke('browser:setSite', 'https://a', 'write');
    assert.deepEqual(calls(grants.set), [
      ['https://a', null],
      ['https://a', 'write'],
    ]);
    grants.list = () => undefined;
    assert.deepEqual(await h.invoke('browser:sites'), []);
    assert.deepEqual(await h.invoke('browser:setSite', 'x', 'read'), []);
    // the ways-forward strip: a refused site allowed for the rest of one chat
    const asked: any[] = [];
    grants.allowInChat = (...a: any[]) => (asked.push(a), 'allowed');
    assert.equal(await h.invoke('browser:allowSiteInChat', 'c1', 'https://a', 'read'), 'allowed');
    assert.deepEqual(asked, [['c1', 'https://a', 'read']]);
    grants.allowInChat = () => undefined;
    assert.equal(await h.invoke('browser:allowSiteInChat', 'c1', 'https://a', 'read'), false);
    // Your Chrome keeps its own table: a call naming it reaches the second one main made
    const chrome = h.inst.OriginGrants[1];
    chrome.list = () => ['chrome-site'];
    chrome.allowInChat = (...a: any[]) => (asked.push(['chrome', ...a]), 'allowed');
    assert.deepEqual(await h.invoke('browser:sites', 'chrome'), ['chrome-site']);
    assert.equal(await h.invoke('browser:allowSiteInChat', 'c1', 'https://m', 'write', 'chrome'), 'allowed');
    assert.deepEqual(asked.at(-1), ['chrome', 'c1', 'https://m', 'write']);
    // Settings → Browser → Site permissions: the sites allowed the camera, microphone, location or notifications for good
    const permsFile = path.join(h.userData, 'capabilities', 'browser-web-permissions.json');
    assert.deepEqual(await h.invoke('browser:webPermissions'), [permsFile]);
    assert.deepEqual(await h.invoke('browser:forgetWebPermission', 1), [permsFile, '1']);
  });

  test('browser popups: page state with the Touch ID setting, focus and close go to the browser windows', async () => {
    const h = await ready({
      before: (h: any) => {
        h.mods['electron/capabilities/browser/windows.cjs'] = {
          BrowserWindows: h.cls('BrowserWindows', () => ({ state: mock.fn(() => ['page']), restart: mock.fn(() => 'https://x') })),
        };
      },
    });
    const sender = h.wc();
    const state = await h.invokeFrom(sender, 'browser:pageState', 7);
    assert.deepEqual(state.pages, ['page']);
    assert.equal(state.restartUrl, 'https://x');
    assert.equal(typeof state.auth.touchId, 'boolean');
    const popups = h.one('BrowserWindows');
    await h.invokeFrom(sender, 'browser:focusPopup', 7);
    await h.invokeFrom(sender, 'browser:closePopup', 7);
    assert.deepEqual(calls(popups.state), [[7, sender]]);
    assert.deepEqual(calls(popups.focus), [[7, sender]]);
    assert.deepEqual(calls(popups.closePopup), [[7, sender]]);
  });

  test('Your Chrome: channel and profile, token, test, and the Claude in Chrome note', async () => {
    const h = await ready({ state: { prefs: { browserChannel: 'chrome', chromeProfileDir: '/prof' } } });
    const control = h.one('BrowserControl');
    const chrome = h.one('ChromeChannel');
    const tokens = h.one('ChromeTokens');
    assert.deepEqual(calls(control.configure)[0], ['chrome']);
    tokens.has = mock.fn(() => true);
    assert.deepEqual(await h.invoke('browser:chromeState'), {
      active: 'builtin',
      hasToken: true,
      extensionUrl: 'https://ext.example',
      waitingChats: 0,
    });
    assert.deepEqual(calls(tokens.has), [['/prof']]);
    // the same profile keeps the running instances; another one lets them go (a chat working in Chrome keeps its own until its turn ends)
    await h.invoke('browser:configure', { channel: 'chrome', profileDir: ' /prof ' });
    assert.equal(chrome.restartAll.mock.callCount(), 0);
    await h.invoke('browser:configure', null);
    assert.equal(chrome.restartAll.mock.callCount(), 1);
    // Use Claude in Chrome: main saves it before it answers (only a real true turns it on)
    const saved = () => calls(h.mod('platform/chats.cjs').patchPrefs).at(-1)?.[1].claudeInChrome;
    assert.equal(await h.invoke('browser:claudeInChrome', true), true);
    assert.equal(saved(), true);
    assert.equal(await h.invoke('browser:claudeInChrome', 'yes'), false);
    assert.equal(saved(), false);
    assert.deepEqual(calls(control.configure).at(-1), ['builtin']);
    control.active = null;
    tokens.has = () => false;
    assert.deepEqual(await h.invoke('browser:chromeState'), {
      active: null,
      hasToken: false,
      extensionUrl: 'https://ext.example',
      waitingChats: 0,
    });
    tokens.set = mock.fn(() => true);
    assert.equal(await h.invoke('browser:setChromeToken', 'tok'), true);
    assert.deepEqual(calls(tokens.set), [['', 'tok']]);
    assert.equal(chrome.restartAll.mock.callCount(), 2);
    tokens.set = () => undefined;
    assert.equal(await h.invoke('browser:setChromeToken', 'tok'), false);
    assert.deepEqual(await h.invoke('browser:testChrome'), { ok: false, message: 'Not ready' });
    chrome.test = () => ({ ok: true });
    assert.deepEqual(await h.invoke('browser:testChrome'), { ok: true });
    // the note
    const ctl = h.one('ChatController');
    ctl.ref = (id: string) => ({ kind: id === 'cl' ? 'claude' : id === 'ac' ? 'acp:kimi' : 'codex' });
    assert.equal(await h.invoke('browser:claudeInChromeNote', 'co'), false);
    // a basic harness never ran Claude in Chrome either
    assert.equal(await h.invoke('browser:claudeInChromeNote', 'ac'), false);
    assert.equal(await h.invoke('browser:claudeInChromeNote', 'cl'), true);
    assert.equal(await h.invoke('browser:claudeInChromeNote'), true);
    assert.equal(await h.invoke('browser:dismissClaudeInChromeNote'), true);
    assert.equal(await h.invoke('browser:claudeInChromeNote', 'cl'), false);
  });

  test('browser tools: grants ask through Sage cards; panel tabs, Chrome processes and the tool cache', async () => {
    const h = await ready({ state: { prefs: { chromeProfileDir: 7 } } });
    const grants = h.one('OriginGrants').opts;
    assert.equal(grants.file, path.join(h.userData, 'capabilities', 'browser-sites.json'));
    h.one('ChatController').ref = () => ({ kind: 'codex' });
    await grants.ask({ chatId: 'c', origin: 'https://a', need: 'write' });
    const [chatId, kind, card] = calls(h.inst.computerUse[0].broker.ask)[0];
    assert.deepEqual(
      [chatId, kind, card.harness, card.origin, card.level, card.levels.length],
      ['c', 'browserOrigin', 'codex', 'https://a', 'write', 2],
    );
    const panel = h.one('PanelBrowser').opts;
    assert.deepEqual(panel.appContents(), [h.windows[0].webContents]);
    assert.deepEqual(
      panel.panelSession().map((s: any) => s === h.partitions.get('persist:browser')),
      [true],
      'the shared profile, before any chat has its own',
    );
    // open a tab: the focused window unless it is Quick Chat, else the main window, else nowhere
    const w = h.windows[0];
    assert.equal(panel.open('c1'), undefined);
    assert.deepEqual(w.webContents.on_('app:command'), [['open-agent-browser-tab', 'c1']]);
    await h.invoke('window:open');
    const w2 = h.windows[1];
    h.ui.focused = w2;
    panel.open('c2');
    assert.deepEqual(w2.webContents.on_('app:command'), [['open-agent-browser-tab', 'c2']]);
    await h.invoke('window:mini');
    h.ui.focused = h.windows[2];
    panel.open('c3');
    assert.deepEqual(w.webContents.on_('app:command').at(-1), ['open-agent-browser-tab', 'c3']);
    h.ui.focused = null;
    w.close();
    w2.close();
    assert.equal(panel.open('c4'), false);
    // Chrome processes
    const chrome = h.one('ChromeChannel').opts;
    chrome.fork('/m.js', ['a'], { o: 1 });
    assert.deepEqual(calls(h.electron.utilityProcess.fork), [['/m.js', ['a'], { o: 1 }]]);
    assert.match(chrome.pinnedExtension, /^\d+\.\d+/);
    assert.equal(chrome.extensionVersion(), '1.0');
    assert.deepEqual(calls(h.mod('capabilities/browser/chromeMigration.cjs').installedExtensionVersion), [[{ profileDir: null }]]);
    const tokens = h.one('ChromeTokens');
    tokens.get = mock.fn(() => 'tok');
    const spec = chrome.spec();
    assert.equal(spec.spec.outputDir, path.join(h.userData, 'capabilities', 'playwright-output'));
    assert.ok(fs.existsSync(spec.spec.outputDir));
    assert.equal(spec.spec.token, 'tok');
    assert.equal(spec.spec.profileDir, null);
    await h.invoke('browser:configure', { channel: 'chrome', profileDir: '/p2' });
    assert.equal(chrome.extensionVersion(), '1.0');
    assert.deepEqual(calls(h.mod('capabilities/browser/chromeMigration.cjs').installedExtensionVersion).at(-1), [{ profileDir: '/p2' }]);
    assert.equal(chrome.spec().spec.profileDir, '/p2');
    // a chat's Your Chrome instance stays while its turn runs; Chrome waiting for the user's approval shows in the chat
    const sessions = h.one('SessionStore');
    sessions.running = mock.fn((id: string) => id === 'busy');
    assert.equal(chrome.busy('busy'), true);
    assert.equal(chrome.busy('idle'), false);
    sessions.patch = mock.fn();
    chrome.onApproval('c1', true);
    assert.deepEqual(calls(sessions.patch).at(-1), ['c1', { chromeApproval: true }]);
    // /new on any harness lets the chat's Your Chrome instance go, and retires its Claude CLIs
    const channel = h.one('ChromeChannel');
    h.claude.retireChat.mock.mockImplementation(() => 2);
    // and lets go of its basic-harness session
    h.one('AcpHost').retireChat.mock.mockImplementation(() => 1);
    assert.deepEqual(await h.invoke('session:release', 'c1'), { claude: 2, acp: 1 });
    assert.deepEqual(calls(h.one('AcpHost').retireChat).at(-1), ['c1']);
    // a clear passes that on: the new chat takes over the link of the chat it replaced
    assert.deepEqual(calls(h.claude.retireChat).at(-1), ['c1', { cleared: true }]);
    assert.deepEqual(calls(channel.release).at(-1), ['c1']);
    assert.match(h.one('BrowserControl').opts.cache.cache, /playwright-mcp-.*-tools\.json$/);
    assert.equal(h.one('ChromeTokens').opts.safeStorage, h.electron.safeStorage);
  });
}
