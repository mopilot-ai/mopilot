// Electron main browser-policy wiring unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadMain, flush, calls, peerMain } from './fixture';

export function registerBrowserPolicyCases() {
  test('site grants anchor to the chat and can ask without an "always" choice', async () => {
    const h = await peerMain();
    await flush();
    const grants = h.one('OriginGrants').opts;
    assert.equal(grants.anchor({ chatId: 'c' }), 'anchor-c');
    const [chatId, deps] = calls(h.mod('capabilities/anchor.cjs').chatAnchorOf)[0];
    assert.equal(chatId, 'c');
    assert.equal(deps.sessions, h.one('SessionStore'));
    assert.equal(deps.controller, h.one('ChatController'));
    h.one('ChatController').ref = () => ({ kind: 'claude' });
    const { signal } = new AbortController();
    await grants.ask({ chatId: 'c', origin: 'https://a', need: 'read', allowAlways: false, signal });
    assert.deepEqual(calls(h.inst.computerUse[0].broker.ask)[0][3], { signal });
    const card = calls(h.inst.computerUse[0].broker.ask)[0][2];
    assert.equal(card.allowAlways, false);
    assert.equal(card.harness, 'claude');
    assert.equal('risk' in card, false);
    // a site flagged as risky carries the risk to the card
    const risk = { level: 'high', category: 'banking' };
    await grants.ask({ chatId: 'c', origin: 'https://bank.test', need: 'write', risk });
    const risky = calls(h.inst.computerUse[0].broker.ask)[1][2];
    assert.deepEqual([risky.origin, risky.level, risky.risk, 'allowAlways' in risky], ['https://bank.test', 'write', risk, false]);
  });

  test('site risk: offline by default, the remote check behind its flag; a risky action asks with the "can\'t be undone" card', async () => {
    const h = await peerMain();
    await flush();
    const grants = h.one('OriginGrants').opts;
    assert.equal(grants.risk.remote, null, 'no endpoint, no remote lookup');
    const flags = h.mod('platform/flags.cjs').isEnabled;
    assert.equal(grants.risk.remoteEnabled(), true);
    assert.deepEqual(calls(flags).at(-1), ['shared.browser.siteRiskRemote']);
    h.one('ChatController').ref = () => ({ kind: 'codex' });
    const ask = h.inst.computerUse[0].broker.ask;
    ask.mock.mockImplementation(async () => ({ decision: 'allow' }));
    const risk = { level: 'high', category: 'banking' };
    // the call's signal goes to the card, which an aborted call withdraws (#1865)
    const { signal } = new AbortController();
    assert.equal(
      await grants.confirmAction({
        chatId: 'c',
        browser: 'iab',
        origin: 'https://bank.test',
        tool: 'click',
        summary: 'click e1',
        sensitive: null,
        risk,
        signal,
      }),
      true,
    );
    assert.deepEqual(calls(ask).at(-1), [
      'c',
      'computerConfirm',
      {
        harness: 'codex',
        // the card names its browser (each keeps its own site table)
        browser: 'iab',
        app: { bundleId: 'https://bank.test', name: 'https://bank.test' },
        verb: 'act on a high-risk site',
        summary: 'click e1',
        tool: 'click',
        risk,
      },
      { signal },
    ]);
    // a sensitive action anywhere names its own verb; anything but allow refuses
    ask.mock.mockImplementation(async () => ({ decision: 'deny' }));
    assert.equal(
      await grants.confirmAction({
        chatId: 'c',
        origin: 'https://a.test',
        tool: 'type',
        summary: 'type',
        sensitive: { verb: 'submit a payment' },
      }),
      false,
    );
    const card = calls(ask).at(-1)[2];
    assert.deepEqual([card.verb, 'risk' in card], ['submit a payment', false]);
    ask.mock.mockImplementation(async () => null);
    assert.equal(
      await grants.confirmAction({ chatId: 'c', origin: 'https://a.test', tool: 'type', summary: 'type', sensitive: null }),
      false,
    );
    // a site lowered to read only asks again once the turn ends, in both browsers' tables
    const [[onTurnEnd]] = calls(h.one('BrowserTabs').onTurnEnd);
    const [inApp, chrome] = h.inst.OriginGrants;
    inApp.turnEnded = mock.fn();
    chrome.turnEnded = mock.fn();
    onTurnEnd('c');
    assert.deepEqual(calls(inApp.turnEnded), [['c']]);
    assert.deepEqual(calls(chrome.turnEnded), [['c']]);
    // one table per browser: the in-app browser's keeps the old file, Your Chrome's has its own
    assert.deepEqual(
      h.inst.OriginGrants.map((g: any) => [g.opts.browser, path.basename(g.opts.file)]),
      [
        ['iab', 'browser-sites.json'],
        ['chrome', 'browser-sites-chrome.json'],
      ],
    );
    // Codex Browser Use blocks reach MoPilot's own tools in every chat, whatever its harness (#1319 G13)
    const blocks = h.one('CodexSiteBlocks');
    assert.equal(blocks.opts.browserUse, h.one('CodexBrowserUse'));
    assert.match(blocks.opts.store, /codex-browser-policy\.json$/);
    const reason = mock.fn(() => 'blocked by Codex');
    blocks.reason = reason;
    const hasThread = mock.fn(() => false);
    h.one('CodexToolInjection').hasThread = hasThread;
    for (const ref of [
      { kind: 'codex', id: 'cx-1' },
      { kind: 'claude', id: 's1' },
      { kind: 'acp', id: 'a1' },
      { kind: 'claude', id: null },
    ]) {
      h.one('ChatController').ref = () => ref;
      assert.equal(grants.external('https://x.test/'), 'blocked by Codex', ref.kind);
    }
    assert.deepEqual(calls(reason).at(-1), ['https://x.test/']);
    assert.equal(calls(hasThread).length, 0, "the chat's thread is not consulted");
    blocks.reason = () => undefined;
    assert.equal(grants.external('https://x.test/'), null);
  });

  test('site risk: an endpoint in the environment is the remote lookup', async () => {
    const h = await loadMain({ env: { MOPILOT_SITE_RISK_URL: 'https://risk.test/lookup' } });
    await h.ready();
    await flush();
    assert.equal(typeof h.one('OriginGrants').opts.risk.remote, 'function');
  });

  test("browser screenshots are sized for the chat's model; a chat's own partition is set up like the shared one", async () => {
    const h = await peerMain();
    await flush();
    h.one('ChatController').ref = () => ({ kind: 'claude' });
    h.one('ChatsStore').record = (id: string) => ({ id });
    assert.equal(h.one('BrowserTabs').opts.modelOf('c1'), 'claude:c1:prefs');
    h.one('ChatsStore').record = undefined;
    assert.equal(h.one('BrowserTabs').opts.modelOf('c1'), 'claude:-:prefs');
    // a pane tab that asks for its chat's own partition gets a session with downloads and sign-in set up
    const { browserPartition } = await import('../../../shared/browserStorage.mjs');
    const guest = h.wc({ type: 'webview' });
    h.app.emit('web-contents-created', {}, guest);
    const own = browserPartition('session', 'c1');
    const params: any = { partition: own };
    guest.emit('will-attach-webview', {}, {}, params);
    assert.equal(params.partition, own);
    const ses = h.partitions.get(own);
    assert.equal(ses.listenerCount('will-download'), 1);
    assert.equal(ses.listenerCount('select-webauthn-account'), 1, 'the passkey account picker');
    assert.equal(h.one('PanelBrowser').opts.panelSession().includes(ses), true);
    // the passkey picker hangs on the window showing a view tab, stands alone while it is parked, and keeps its usual parent for any other page
    const view = h.wc();
    const picker = ses.listeners('select-webauthn-account')[0];
    h.electron.webContents.fromFrame = () => view;
    h.one('BrowserWindows').owned = () => ({ root: view });
    h.electron.dialog.showMessageBox = mock.fn(async () => ({ response: 0 }));
    const pick = () =>
      picker({}, { frame: { isDestroyed: () => false }, relyingPartyId: 'a.test', accounts: [{ credentialId: 'k' }] }, () => {});
    const pane = h.one('PaneViews');
    pane.entryOf = mock.fn((wc: any) => (wc === view ? {} : null));
    pane.windowOf = mock.fn(() => h.windows[0]);
    await pick();
    assert.equal(calls(h.electron.dialog.showMessageBox).at(-1)[0], h.windows[0]);
    pane.windowOf = mock.fn(() => null);
    await pick();
    assert.equal(calls(h.electron.dialog.showMessageBox).at(-1).length, 1);
    pane.entryOf = mock.fn(() => null);
    await pick();
    assert.equal(calls(h.electron.dialog.showMessageBox).length, 3);
    // archiving the chat clears its own browser storage
    h.inst.computerUse[0].desktop = { forget: mock.fn(async () => {}) };
    h.inst.computerUse[0].visibility = { forget: mock.fn() };
    h.one('ChatsStore').args[1].onChange('c1', { meta: { archived: 1 } });
    await flush();
    assert.equal(calls(ses.clearStorageData).length, 1);
  });

  test('web permissions: every browser partition gets the policy; pages ask on their chat card or a native dialog', async () => {
    const h = await peerMain();
    await flush();
    const perms = h.one('WebPermissions');
    const installed = () => calls(perms.install).map(([ses]: any[]) => ses.name);
    assert.deepEqual(installed(), ['persist:browser'], 'the shared profile at ready');
    const { browserPartition } = await import('../../../shared/browserStorage.mjs');
    const guest = h.wc({ type: 'webview' });
    h.app.emit('web-contents-created', {}, guest);
    const own = browserPartition('session', 'c2');
    guest.emit('will-attach-webview', {}, {}, { partition: own });
    assert.deepEqual(installed(), ['persist:browser', own], "a chat's own partition when it is first used");
    const o = perms.opts;
    assert.match(o.file, /capabilities[/\\]browser-web-permissions\.json$/);
    // who drives a page and the note for the agent come from the browser host
    const tabs = h.one('BrowserTabs');
    tabs.driver = mock.fn(() => ({ chatId: 'c', tabId: 't', agent: false }));
    assert.deepEqual(o.driver('wc'), { chatId: 'c', tabId: 't', agent: false });
    tabs.driver = mock.fn(() => undefined);
    assert.equal(o.driver('wc'), null);
    // a user's view tab in a chat's pane: the user drives it for that chat, when the chat is known here
    const views = h.one('PaneViews');
    const sessions = h.one('SessionStore');
    views.chatOf = mock.fn((wc: any) => (wc === 'view' ? 'c9' : null));
    sessions.has = mock.fn((id: string) => id === 'c9');
    assert.deepEqual(o.driver('view'), { chatId: 'c9', tabId: '', agent: false });
    assert.equal(o.driver('wc'), null, 'not a view, or a pane of no chat');
    sessions.has = mock.fn(() => false);
    assert.equal(o.driver('view'), null, 'a chat main no longer has');
    o.note('c', 'permission_denied t');
    assert.deepEqual(calls(tabs.change).at(-1), ['c', 'permission_denied t']);
    // a chat's page asks on its card; a page of no chat on the native dialog
    h.one('ChatController').ref = () => ({ kind: 'acp:gemini' });
    await o.ask({ chatId: 'c', origin: 'https://meet.test', permissions: ['camera'], wc: 'wc' });
    assert.deepEqual(calls(h.inst.computerUse[0].broker.ask).at(-1), [
      'c',
      'browserPermission',
      { harness: 'acp:gemini', origin: 'https://meet.test', permissions: ['camera'] },
    ]);
    const req = { chatId: null, origin: 'https://meet.test', permissions: ['camera'], wc: 'wc' };
    assert.deepEqual(await o.ask(req), { native: req });
    const [dialogArg, windowOf] = calls(h.mod('capabilities/browser/webPermissions.cjs').dialogAsk)[0];
    assert.equal(dialogArg, h.electron.dialog);
    // the dialog's window: a view's (none while parked), else a <webview>'s host, else none
    const w = h.windows[0];
    views.entryOf = mock.fn((wc: any) => (wc === 'view' ? {} : null));
    views.windowOf = mock.fn(() => w);
    assert.equal(windowOf('view'), w);
    views.windowOf = mock.fn(() => null);
    assert.equal(windowOf('view'), null);
    assert.equal(windowOf(h.wc({ hostWebContents: w.webContents })), w);
    assert.equal(windowOf(h.wc()), null);
    assert.equal(windowOf(null), null);
  });
}
