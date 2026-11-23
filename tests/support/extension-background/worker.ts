// Extension worker unit cases using shared fake Chrome, socket, timer, and page fixtures.
import {
  test,
  assert,
  fakeChromeApi,
  until,
  protocol,
  readPairing,
  RECONNECT_ALARM,
  tick,
  SECRET,
  FakeWs,
  handshake,
  background,
  ask,
} from './fixture.ts';

export function registerWorker() {
  test('the service worker: Chrome’s events reach the sessions, the badge follows the status, the alarm and startup reconnect', async () => {
    const code = protocol.pairingCode(47615, SECRET);
    const { chrome, bg, warn } = await background({ pairing: code });
    assert.equal(FakeWs.all.length, 1);
    assert.deepEqual(await readPairing(chrome), { port: 47615, secret: SECRET });
    await handshake(FakeWs.all[0]);
    // connected: no badge (only something for the user to do shows one), amber like Claude in Chrome's
    assert.deepEqual(chrome.log.filter((c) => c[0] === 'action.setBadgeText').at(-1), ['action.setBadgeText', { text: '' }]);
    assert.deepEqual(
      chrome.log.find((c) => c[0] === 'action.setBadgeBackgroundColor'),
      ['action.setBadgeBackgroundColor', { color: '#F59E0B' }],
    );
    // a chat message runs in the sessions and answers over the socket
    const ws = FakeWs.all[0];
    await ws.from({ chat: 'a', method: 'session.open', params: [{ title: 'T' }] });
    await ws.from({ chat: 'a', id: 1, method: 'chrome.tabs.create', params: [], turn: 0 });
    const tab = ws.sent.find((m) => m.id === 1).result.id;
    await ws.from({ chat: 'a', id: 10, method: 'chrome.debugger.attach', params: [{ tabId: tab }, '1.3'], turn: 0 });
    // Chrome's events go to the sessions of their acknowledged attachment
    chrome.debugger.onEvent.fire({ tabId: tab }, 'Page.loadEventFired', {});
    assert.equal(ws.sent.at(-1).method, 'chrome.debugger.onEvent');
    chrome.tabs.onUpdated.fire(tab, { groupId: -1 }, { id: tab, groupId: -1 });
    assert.equal(ws.sent.at(-1).params[1], 'removed_from_group');
    await ws.from({ chat: 'a', id: 2, method: 'chrome.tabs.create', params: [] });
    const t2 = ws.sent.find((m) => m.id === 2).result.id;
    chrome.debugger.onDetach.fire({ tabId: t2 }, 'target_closed');
    assert.equal(ws.sent.at(-1).method, 'chrome.debugger.onDetach');
    await ws.from({ chat: 'a', id: 3, method: 'chrome.tabs.create', params: [] });
    const t3 = ws.sent.find((m) => m.id === 3).result.id;
    // a popup is the chat's by the tab Chrome says opened it, not by openerTabId (the active tab, #1642)
    const before = ws.sent.length;
    const popup = chrome.addTab({ openerTabId: t3 });
    chrome.tabs.onCreated.fire(popup);
    await tick();
    assert.equal(ws.sent.length, before);
    chrome.webNavigation.onCreatedNavigationTarget.fire({ sourceTabId: t3, tabId: popup.id });
    await tick();
    assert.equal(ws.sent.at(-1).method, 'chrome.tabs.onCreated');
    assert.equal(ws.sent.at(-1).params[0].id, popup.id);
    chrome.tabs.onRemoved.fire(t3);
    assert.deepEqual(ws.sent.at(-1).params, [t3]);
    // installed: its page opens (an update doesn't); the alarm and Chrome's startup connect (no-ops while connected)
    const welcome = (c: any) => c[0] === 'tabs.create' && c[1]?.url === `chrome-extension://${chrome.runtime.id}/options.html#welcome`;
    chrome.runtime.onInstalled.fire({ reason: 'update' });
    assert.ok(!chrome.log.some(welcome));
    chrome.runtime.onInstalled.fire({ reason: 'install' });
    await tick();
    assert.ok(chrome.log.some(welcome), 'its page opens as the install checklist');
    assert.ok(chrome.log.some((c) => c[0] === 'alarms.create' && c[1] === RECONNECT_ALARM && c[2].periodInMinutes === 0.5));
    chrome.alarms.onAlarm.fire({ name: 'other' });
    chrome.alarms.onAlarm.fire({ name: RECONNECT_ALARM });
    chrome.alarms.onAlarm.fire(undefined);
    chrome.runtime.onStartup.fire();
    await tick();
    assert.equal(FakeWs.all.length, 1);
    // a failing badge update is noted
    chrome.action.setBadgeText = async () => {
      throw new Error('no');
    };
    ws.onclose();
    await tick();
    assert.ok(warn.mock.calls.some((c: any) => String(c.arguments[0]).includes('set the badge')));
    assert.equal(bg.client.status, 'offline');
    warn.mock.restore();
  });

  test('the service worker: an unreadable Disconnect, a badge color or a page that fails at start is noted, not thrown', async () => {
    const { chrome, warn } = await background({
      before: (c) => {
        c.storage.local.get = async (key: string) => {
          if (key === 'held') throw new Error('locked');
          return {};
        };
        c.action.setBadgeBackgroundColor = async () => {
          throw new Error('no color');
        };
        c.tabs.create = async () => {
          throw new Error('no page');
        };
      },
    });
    chrome.runtime.onInstalled.fire({ reason: 'install' });
    chrome.runtime.onInstalled.fire(undefined);
    await tick(2);
    const noted = warn.mock.calls.map((c: any) => String(c.arguments[0]));
    for (const what of ['read whether the extension was disconnected', 'color the badge', 'open its page'])
      assert.ok(
        noted.some((n: string) => n.includes(what)),
        what,
      );
    warn.mock.restore();
  });

  test('pairing from the options page: only this extension’s pages may pair or unpair; a bad code is refused', async () => {
    const { chrome, bg, warn } = await background();
    assert.equal(bg.client.status, 'unpaired');
    assert.equal(chrome.log.filter((c) => c[0] === 'action.setBadgeText').at(-1)[1].text, '!');
    // a web page or another extension
    assert.equal(await ask(chrome, { type: 'pair', code: 'x' }, { id: 'other', url: 'https://evil.example/' }), 'ignored');
    assert.equal(await ask(chrome, { type: 'pair', code: 'x' }, { id: chrome.runtime.id, url: 'https://evil.example/' }), 'ignored');
    assert.equal(await ask(chrome, { type: 'pair', code: 'x' }, null), 'ignored');
    assert.equal(await ask(chrome, { type: 'pair', code: 'x' }, { id: chrome.runtime.id }), 'ignored');
    assert.deepEqual(await ask(chrome, { type: 'status' }), { status: 'unpaired', port: null, asking: false });
    assert.deepEqual(await ask(chrome, { type: 'pair', code: 'nope' }), {
      status: 'unpaired',
      error: "That isn't a MoPilot pairing code.",
    });
    const code = protocol.pairingCode(50001, SECRET);
    assert.deepEqual(await ask(chrome, { type: 'pair', code: ` ${code} ` }), { status: 'connecting', port: 50001 });
    assert.equal(chrome.store.local.pairing, code);
    assert.equal(FakeWs.all.at(-1)?.url, 'ws://127.0.0.1:50001/mopilot-chrome');
    assert.deepEqual(await ask(chrome, { type: 'status' }), { status: 'connecting', port: 50001, asking: false });
    assert.deepEqual(await ask(chrome, { type: 'unpair' }), { status: 'unpaired' });
    assert.equal(chrome.store.local.pairing, undefined);
    // the one-time claim code MoPilot opened the page with is traded for the pairing code
    const claim = `mopilot-claim:1:50002:${'t'.repeat(32)}`;
    const answering = ask(chrome, { type: 'pair', code: claim });
    await until(() => FakeWs.all.at(-1)?.url === 'ws://127.0.0.1:50002/mopilot-chrome');
    const cw = FakeWs.all.at(-1) as FakeWs;
    await cw.from({ type: 'hello', protocol: 1, nonce: 'n' });
    assert.deepEqual(cw.sent.at(-1), { type: 'claim', protocol: 1, token: 't'.repeat(32) });
    const claimed = protocol.pairingCode(50002, SECRET);
    await cw.from({ type: 'paired', code: claimed });
    assert.deepEqual(await answering, { status: 'connecting', port: 50002 });
    assert.equal(chrome.store.local.pairing, claimed);
    // a claim MoPilot doesn't honor: nothing is stored, and the page says what to do
    const n = FakeWs.all.length;
    const refused = ask(chrome, { type: 'pair', code: claim });
    await until(() => FakeWs.all.length > n);
    FakeWs.all.at(-1)?.onclose();
    assert.equal(((await refused) as any).error, 'That code expired. Press Connect.');
    assert.equal(chrome.store.local.pairing, claimed);
    assert.deepEqual(await ask(chrome, { type: 'pair' }), { status: 'connecting', error: "That isn't a MoPilot pairing code." });
    await ask(chrome, { type: 'unpair' });
    // a failure answers with the status and the error
    chrome.fail['storage.local.get'] = new Error('broken');
    assert.deepEqual(await ask(chrome, { type: 'status' }), { status: 'unpaired', error: 'broken' });
    chrome.storage.local.get = async () => {
      throw 'plain';
    };
    assert.deepEqual(await ask(chrome, null), { status: 'unpaired', error: 'plain' });
    warn.mock.restore();
  });

  test('the service worker entry starts the background on its global scope', async () => {
    const chrome = fakeChromeApi();
    const g = globalThis as any;
    const saved = { chrome: g.chrome, WebSocket: g.WebSocket };
    g.chrome = chrome;
    g.WebSocket = FakeWs;
    try {
      await import('../../../electron/chrome-extension/background.mjs');
      await tick(5);
      assert.ok(chrome.debugger.onEvent.listeners.length === 1, 'listeners registered synchronously at start');
    } finally {
      g.chrome = saved.chrome;
      g.WebSocket = saved.WebSocket;
    }
  });
}
