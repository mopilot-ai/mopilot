// Built-in browser backend sessions-tabs unit cases with shared tab, host and grant fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { require, S, fakeTab, backend, withTab } from './fixture';

export function registerSessionsTabsCases() {
  test('reserved backend method names receive the ordinary unknown-method refusal', async () => {
    const { call } = backend();
    for (const method of ['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
      await assert.rejects(call(method), new RegExp(`No handler registered for method: ${method}`));
  });

  test('sessions: only the thread may call; ping needs none; unknown and user-browser methods fail clearly', async () => {
    const { b, call } = backend();
    assert.equal(await b.handle('ping'), 'pong');
    await assert.rejects(b.handle('getTabs', { session_id: 'other' }), /No built-in browser route is available for browser session other/);
    await assert.rejects(b.handle('getTabs'), /browser session undefined/);
    await assert.rejects(b.handle('getTabs', 'x'), /browser session undefined/);
    await assert.rejects(call('getUserTabs'), /getUserTabs is not available in MoPilot's built-in browser/);
    await assert.rejects(call('nope'), /No handler registered for method: nope/);
    assert.equal(await call('nameSession', { name: 'x' }), null);
    assert.equal(await call('setBlobDownloadOrigin', {}), null);
  });

  test('getInfo: a session-scoped iab backend naming the thread and the build flavor', async () => {
    const { call } = backend({ version: '1.2' });
    const info = await call('getInfo');
    assert.equal(info.type, 'iab');
    assert.equal(info.discoveryScope, 'session');
    assert.equal(info.version, '1.2');
    assert.deepEqual(info.metadata, { codexAppBuildFlavor: 'prod', codexSessionId: S });
    assert.deepEqual(info.apiSupportOverrides, { 'Browser.user': false, 'Tab.markDeliverable': true, 'Tab.markHandoff': true });
    assert.deepEqual(
      info.capabilities.browser.map((c: any) => c.id),
      ['visibility', 'viewport'],
    );
    const bare = backend({ flavor: null });
    const b2 = await bare.call('getInfo');
    assert.deepEqual(b2.metadata, { codexSessionId: S });
    assert.equal(b2.version, null);
  });

  test("tabs: the chat's tabs with integer ids; createTab opens one in the chat's pane; focus selects; no host fails", async () => {
    const { host, call, tab, id } = await withTab();
    assert.equal(id, 1);
    assert.deepEqual(host.calls[0], ['create', `chat:${S}`, { focus: false }]);
    const other = fakeTab('tab_user', { url: '', title: '' });
    host.tabs.push(other);
    host.cur = tab;
    assert.deepEqual(await call('getTabs'), [
      { id: 1, providerTabId: tab.id, sessionControlled: true, title: 'Example', active: true, url: 'https://example.com/' },
      { id: 2, providerTabId: 'tab_user', sessionControlled: false, title: '', active: false, url: '' },
    ]);
    tab.title = '';
    assert.equal((await call('getTabs'))[0].title, 'https://example.com/');
    assert.equal(await call('focusTab', { tabId: 2 }), true);
    assert.deepEqual(host.calls.at(-1), ['select', `chat:${S}`, 'tab_user']);
    await assert.rejects(call('focusTab', { tabId: 9 }), /Unknown tab: 9/);
    other.closed = true;
    await assert.rejects(call('focusTab', { tabId: 2 }), /Unknown tab: 2/);
    other.closed = false;
    other.wc.destroy();
    await assert.rejects(call('focusTab', { tabId: 2 }), /Unknown tab: 2/);
    tab.signin = { reason: '' };
    await assert.rejects(call('getCommittedTabUrl', { tabId: 1 }), /user's turn on tab 1\. Use another tab/);
    tab.signin = null;
    assert.equal(await call('getCommittedTabUrl', { tabId: 1 }), 'https://example.com/');
    tab.url = '';
    assert.equal(await call('getCommittedTabUrl', { tabId: 1 }), null);
    const none = backend({ noHost: true });
    await assert.rejects(none.call('getTabs'), /built-in browser is not available/);
  });

  test('attach forwards CDP events (top frame and child sessions); detach and the debugger going stop it', async () => {
    const { b, call, tab, notes, grants } = await withTab();
    assert.equal(await call('attach', { tabId: 1 }), null);
    assert.equal(await call('attachTarget', { tabId: 1, targetId: 'x' }), null);
    assert.equal(tab.attached, 1);
    assert.equal(tab.held, 1);
    assert.deepEqual(grants.calls[0].slice(0, 3), ['peek', 'https://example.com/', 'read']);
    const dbg = tab.wc.debugger;
    dbg.emit('message', {}, 'Page.loadEventFired', { t: 1 }, '');
    dbg.emit('message', {}, 'Network.x', {}, 'unknown-child');
    dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'c1', targetInfo: { targetId: 'f1' } }, '');
    dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'c2' }, '');
    dbg.emit('message', {}, 'Target.attachedToTarget', {}, '');
    dbg.emit('message', {}, 'Runtime.x', { y: 1 }, 'c1');
    dbg.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'c1' }, '');
    dbg.emit('message', {}, 'Target.detachedFromTarget', undefined, '');
    dbg.emit('message', {}, 'Runtime.y', {}, 'c1');
    assert.deepEqual(
      notes.map(([m, p]) => [m, p.method, p.source]),
      [
        ['onCDPEvent', 'Page.loadEventFired', { tabId: 1 }],
        ['onCDPEvent', 'Target.attachedToTarget', { tabId: 1 }],
        ['onCDPEvent', 'Target.attachedToTarget', { tabId: 1 }],
        ['onCDPEvent', 'Target.attachedToTarget', { tabId: 1 }],
        ['onCDPEvent', 'Runtime.x', { tabId: 1, sessionId: 'c1', targetId: 'f1' }],
        ['onCDPEvent', 'Target.detachedFromTarget', { tabId: 1 }],
        ['onCDPEvent', 'Target.detachedFromTarget', { tabId: 1 }],
      ],
    );
    assert.equal(b.held.get(tab).children.get('c2'), '');
    // detachTarget of a child target keeps the tab; of the tab itself (or none) lets go
    assert.equal(await call('detachTarget', { tabId: 1, targetId: 'f9' }), null);
    assert.equal(b.held.has(tab), true);
    assert.equal(await call('detachTarget', { tabId: 1 }), null);
    assert.equal(b.held.has(tab), false);
    assert.deepEqual(notes.at(-1), ['onCDPDetach', { tabId: 1 }]);
    assert.deepEqual(dbg.sent, [
      ['Fetch.disable', {}],
      ['Fetch.disable', {}, 'c2'],
    ]);
    assert.equal(dbg.listenerCount('message'), 0);
    assert.equal(await call('detachTarget', { tabId: 9 }), null);
    await call('attach', { tabId: 1 });
    assert.equal(await call('detachTarget', { tabId: 1, targetId: 'mopilot-iab-tab:1' }), null);
    assert.equal(b.held.has(tab), false);
    // the debugger going (the host detached it, or the page went)
    await call('attach', { tabId: 1 });
    dbg.emit('detach', {}, 'target closed');
    assert.equal(b.held.has(tab), false);
    assert.deepEqual(dbg.sent.length, 3);
    assert.equal(await call('detach', { tabId: 9 }), null);
    // a dropped tab whose debugger is gone or detached sends nothing
    await call('attach', { tabId: 1 });
    dbg.attached = false;
    await call('detach', { tabId: 1 });
    await call('attach', { tabId: 1 });
    tab.wc.destroy();
    b.drop(tab);
    b.drop(tab);
    assert.equal(dbg.sent.length, 3);
  });
}

export function registerHandlerContractsCases() {
  test('browser protocol handlers share the backend turn ledger and reject unnamed commands', async () => {
    const { TurnTokens } = require('../../../electron/capabilities/contract/turnTokens.cjs');
    const turns = new TurnTokens();
    const { b, call, tab } = await withTab();
    b.turns = () => turns;
    await call('executeCdp', { target: { tabId: 1 }, method: 'Page.reload' });
    assert.equal(tab.sends.at(-1)[0], 'Page.reload');
    assert.ok(turns.current(turns.issue(`chat:${S}`, S)));
    await assert.rejects(call('executeUnhandledCommand'), /Unsupported command.*undefined/);
  });

  // Found by the real-app edge-case suite (CM-L16): size emulation on a tab whose renderer is gone crashes the app, so
  // the plugin's viewport skips such a tab, without failing the command, and reaches it once a reload brings it back.
}
