// Chrome tab state, debugger lifetime and CDP ownership against an in-memory relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeRelay, tick, until } from './support/chrome-relay-kit.ts';

const require = createRequire(import.meta.url);
const { ChromeTabContents, RelayDebugger, isRelayTab, ID_BASE } = require('../electron/capabilities/browser/chromeTab.cjs');
const { assertCdpTarget } = require('../electron/capabilities/browser/cdp.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');
const code = (c: string, re?: RegExp) => (e: any) => e?.code === c && (!re || re.test(e.message));

test('chromeTab: a known tab, its debugger over the relay, and the state its CDP events give', async () => {
  const r = fakeRelay();
  r.replies['Target.getTargetInfo'] = { targetInfo: { targetId: 'MAIN', url: 'https://a.test/', title: 'A' } };
  r.replies['Page.getNavigationHistory'] = {
    currentIndex: 1,
    entries: [
      { id: 1, url: 'https://z.test/' },
      { id: 2, url: 'https://a.test/' },
      { id: 3, url: 'https://b.test/' },
    ],
  };
  r.replies['Runtime.evaluate'] = { result: { value: 'UA/1' } };
  const wc = new ChromeTabContents({ relay: r, chatId: 'c', tab: { id: 5, url: 'https://start.test/', title: 'Start' } });
  assert.ok(isRelayTab(wc));
  assert.equal(isRelayTab({}), false);
  assert.equal(isRelayTab(null), false);
  assert.ok(wc.id > ID_BASE);
  assert.equal(wc.getURL(), 'https://start.test/');
  assert.equal(wc.getTitle(), 'Start');
  assert.equal(wc.isLoading(), false);
  assert.equal(wc.isDestroyed(), false);
  assert.equal(await wc.capturePage(), null);
  wc.setBackgroundThrottling(false);
  wc.assertDrivable();
  await assert.rejects(wc.debugger.sendCommand('Page.enable'), code('failed', /not attached/));
  assert.equal(wc.debugger.isAttached(), false);
  wc.debugger.attach('1.3');
  wc.debugger.attach('1.3');
  assert.equal(wc.debugger.isAttached(), true);
  await wc.debugger.ready;
  assert.equal(wc.getURL(), 'https://a.test/');
  assert.equal(wc.getTitle(), 'A');
  assert.equal(wc.getUserAgent(), 'UA/1');
  assert.equal(wc.navigationHistory.getActiveIndex(), 1);
  assert.equal(wc.navigationHistory.length(), 3);
  assert.equal(wc.navigationHistory.getEntryAtIndex(0).url, 'https://z.test/');
  assert.equal(wc.navigationHistory.getEntryAtIndex(9), null);
  assert.deepEqual(r.calls[0], ['attach', 0, 5]);
  await wc.debugger.sendCommand('Page.enable', undefined, 'S9');
  assert.deepEqual(r.calls.at(-1), ['cdp', 0, { tabId: 5, sessionId: 'S9' }, 'Page.enable', {}]);

  // events: the host's webContents events from the tab's CDP events; child sessions only reach the debugger
  const events: string[] = [];
  for (const e of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) wc.on(e, () => events.push(e));
  const messages: any[] = [];
  wc.debugger.on('message', (_e: any, m: string, _p: any, sid: string) => messages.push([m, sid]));
  wc.event({ tabId: 5 }, 'Page.frameStartedLoading', { frameId: 'MAIN' });
  wc.event({ tabId: 5 }, 'Page.frameStartedLoading', { frameId: 'MAIN' });
  wc.event({ tabId: 5 }, 'Page.frameStartedLoading', { frameId: 'CHILD' });
  assert.equal(wc.isLoading(), true);
  wc.event({ tabId: 5 }, 'Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://b.test/' } });
  wc.event({ tabId: 5 }, 'Page.frameNavigated', { frame: { id: 'CH', parentId: 'MAIN', url: 'https://ads.test/' } });
  wc.event({ tabId: 5 }, 'Page.frameNavigated', {});
  wc.event({ tabId: 5 }, 'Page.frameNavigated', { frame: {} });
  assert.equal(wc.mainFrame, 'MAIN');
  assert.equal(wc.getURL(), 'https://b.test/');
  wc.event({ tabId: 5 }, 'Page.frameStoppedLoading', { frameId: 'MAIN' });
  wc.event({ tabId: 5 }, 'Page.frameStoppedLoading', { frameId: 'MAIN' });
  wc.event({ tabId: 5 }, 'Page.navigatedWithinDocument', { frameId: 'MAIN', url: 'https://b.test/#x' });
  wc.event({ tabId: 5 }, 'Page.navigatedWithinDocument', { frameId: 'OTHER', url: 'https://other.test/' });
  wc.event({ tabId: 5 }, 'Page.navigatedWithinDocument', { frameId: 'MAIN' });
  wc.event({ tabId: 5, sessionId: 'S2' }, 'Page.frameNavigated', { frame: { id: 'X', url: 'https://child.test/' } });
  wc.event({ tabId: 5 }, 'Network.requestWillBeSent');
  wc.event(null, 'Runtime.consoleAPICalled', {});
  assert.equal(wc.getURL(), 'https://b.test/#x');
  await tick(5);
  assert.equal(wc.getURL(), 'https://a.test/', 'the refresh after a navigation reads the target again');
  assert.deepEqual(events, [
    'did-start-loading',
    'did-navigate',
    'did-navigate',
    'did-stop-loading',
    'did-navigate-in-page',
    'did-navigate-in-page',
  ]);
  assert.deepEqual(messages.at(-3), ['Page.frameNavigated', 'S2']);

  // history moves, reload
  r.calls.length = 0;
  wc.navigationHistory.goBack();
  wc.navigationHistory.goForward();
  wc.reload();
  await tick(5);
  assert.deepEqual(
    r.calls
      .filter((c: any) => c[3] !== 'Target.getTargetInfo' && c[3] !== 'Page.getNavigationHistory' && c[3] !== 'Runtime.evaluate')
      .map((c: any) => [c[3], c[4]]),
    [
      ['Page.navigateToHistoryEntry', { entryId: 1 }],
      ['Page.navigateToHistoryEntry', { entryId: 3 }],
      ['Page.reload', {}],
    ],
  );
  r.replies['Page.getNavigationHistory'] = { currentIndex: 0, entries: [{ id: 1, url: 'x' }] };
  await wc.refresh();
  r.calls.length = 0;
  wc.navigationHistory.goBack();
  assert.equal(r.calls.length, 0, 'no entry to go back to');
  r.replies['Page.reload'] = new Error('gone');
  wc.reload();
  await tick(5);
  assert.ok(recentIgnored().some((e: any) => /reload a Chrome tab/.test(e.context)));

  // detaching lets go over the relay, whatever the turn; a failed detach is only noted
  r.turn = 3;
  r.detachFails = true;
  wc.debugger.detach();
  wc.debugger.detach();
  await tick(5);
  await tick(5);
  assert.deepEqual(
    r.calls.filter((c: any) => c[0] === 'detach'),
    [['detach', 0, 5]],
  );
  assert.ok(recentIgnored().some((e: any) => /detach from a Chrome tab/.test(e.context)));
  // a refresh with nothing attached does nothing; a later attach takes the new turn's token
  r.calls.length = 0;
  await wc.refresh();
  assert.equal(r.calls.length, 0);
  wc.event({ tabId: 5 }, 'Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://c.test/' } });
  assert.equal(r.calls.length, 0, 'no refresh while detached');
  wc.debugger.attach();
  await wc.debugger.ready;
  assert.deepEqual(r.calls[0], ['attach', 3, 5]);
});

test('chromeTab: refreshes keep what a failed read cannot give; the debugger is lost; the tab goes', async () => {
  const r = fakeRelay();
  r.replies['Target.getTargetInfo'] = new Error('no');
  r.replies['Page.getNavigationHistory'] = { entries: 'bad' };
  r.replies['Runtime.evaluate'] = new Error('no');
  const wc = new ChromeTabContents({ relay: r, chatId: 'c', tab: { id: 5 } });
  assert.equal(wc.getURL(), '');
  assert.equal(wc.getTitle(), '');
  wc.debugger.attach();
  await wc.debugger.ready;
  assert.equal(wc.getURL(), '');
  r.replies['Target.getTargetInfo'] = { targetInfo: {} };
  await wc.refresh();
  assert.equal(wc.mainFrame, null);
  r.replies['Target.getTargetInfo'] = { targetInfo: { targetId: 'T' } };
  r.replies['Page.getNavigationHistory'] = { entries: [{ id: 1, url: 'u' }] };
  r.replies['Runtime.evaluate'] = { result: { value: 'UA' } };
  await wc.refresh();
  assert.equal(wc.mainFrame, 'T');
  assert.equal(wc.navigationHistory.getActiveIndex(), 0);
  r.calls.length = 0;
  await wc.refresh();
  assert.equal(r.calls.filter((c: any) => c[3] === 'Runtime.evaluate').length, 0, 'the user agent is read once');
  // a refresh that fails after a navigation is only noted
  const r2 = fakeRelay();
  const wc2 = new ChromeTabContents({ relay: r2, chatId: 'c', tab: { id: 5 } });
  wc2.debugger.attach();
  await wc2.debugger.ready;
  wc2.refresh = async () => {
    throw new Error('refresh failed');
  };
  wc2.event({ tabId: 5 }, 'Page.frameStoppedLoading', {});
  wc2.event({ tabId: 5 }, 'Page.frameStartedLoading', {});
  wc2.event({ tabId: 5 }, 'Page.frameStoppedLoading', {});
  await tick(5);
  assert.ok(recentIgnored().some((e: any) => /read a Chrome tab after a navigation/.test(e.context)));

  const lost: any[] = [];
  wc.debugger.on('detach', (_e: any, reason: string) => lost.push(reason));
  wc.debugger.lost('canceled_by_user');
  wc.debugger.lost('again');
  assert.deepEqual(lost, ['canceled_by_user']);
  assert.equal(wc.debugger.isAttached(), false);
  // drivable only while in the chat's connection
  r.tabs.delete(5);
  assert.throws(() => wc.assertDrivable(), code('bad_target', /no longer one of this chat's tabs/));
  r.linked = false;
  assert.throws(() => wc.assertDrivable(), code('not_connected'));
  let destroyed = 0;
  wc.on('destroyed', () => destroyed++);
  wc.gone();
  wc.gone();
  assert.equal(destroyed, 1);
  assert.equal(wc.isDestroyed(), true);
  assert.throws(() => wc.assertDrivable(), code('bad_target', /it is gone/));
  assert.ok(wc.debugger instanceof RelayDebugger);
});

test('chromeTab: a tab still opening, one Chrome opened, one it did not open, and an attach that fails', async () => {
  const r = fakeRelay();
  let open: any;
  const wc = new ChromeTabContents({ relay: r, chatId: 'c', open: new Promise((res) => (open = res)) });
  assert.equal(wc.tabId, null);
  wc.assertDrivable();
  wc.debugger.attach();
  const sent = wc.debugger.sendCommand('Page.enable');
  open({ id: 5, url: 'about:blank', title: 'New' });
  await sent;
  assert.equal(wc.tabId, 5);
  assert.equal(wc.getTitle(), 'New');
  const wcNoUrl = new ChromeTabContents({ relay: r, chatId: 'c', open: Promise.resolve({ id: 5 }) });
  await wcNoUrl.created;
  assert.equal(wcNoUrl.getURL(), '');

  for (const bad of [() => Promise.resolve(null), () => Promise.resolve({ id: 'x' }), () => Promise.reject(new Error('no window'))]) {
    const w = new ChromeTabContents({ relay: r, chatId: 'c', open: bad() });
    let gone = 0;
    w.on('destroyed', () => gone++);
    await assert.rejects(w.created);
    assert.equal(gone, 1);
    assert.equal(w.isDestroyed(), true);
  }
  // a pending tab that goes before it opened lets go of nothing
  const w2 = new ChromeTabContents({ relay: r, chatId: 'c', open: new Promise(() => undefined) });
  w2.debugger.attach();
  r.calls.length = 0;
  w2.debugger.detach();
  assert.equal(r.calls.length, 0);
  // an attach that fails is reported by the command waiting on it
  const r2 = fakeRelay();
  r2.attach = async () => {
    throw new Error('Another debugger is already attached');
  };
  const w3 = new ChromeTabContents({ relay: r2, chatId: 'c', tab: { id: 5 } });
  w3.debugger.attach();
  await assert.rejects(w3.debugger.sendCommand('Page.enable'), /Another debugger/);
  assert.ok(recentIgnored().some((e: any) => /attach to a Chrome tab over the relay/.test(e.context)));
});

test('chromeTab: a failed attach lets go so the next action attaches anew; a detach waits for an attach still on its way', async () => {
  const r = fakeRelay();
  let fail = true;
  let landing: any;
  r.attach = async (tok: any, tabId: number) => {
    r.calls.push(['attach', tok.turn, tabId]);
    if (fail) throw new Error('Another debugger is already attached');
    await new Promise((res) => (landing = res));
  };
  const wc = new ChromeTabContents({ relay: r, chatId: 'c', tab: { id: 5 } });
  const lost: string[] = [];
  wc.debugger.on('detach', (_e: any, why: string) => lost.push(why));
  wc.debugger.attach();
  await assert.rejects(wc.debugger.sendCommand('Page.enable'), /Another debugger/);
  await tick(1);
  assert.equal(wc.debugger.isAttached(), false);
  assert.deepEqual(lost, ['attach_failed']);
  fail = false;
  wc.debugger.attach();
  await tick(1);
  // the turn ends while this attach is still on its way: the detach goes after it lands
  wc.debugger.detach();
  await tick(5);
  assert.equal(r.calls.filter((c: any) => c[0] === 'detach').length, 0);
  landing();
  await until(() => r.calls.some((c: any) => c[0] === 'detach'));
  // a failed attach that was already let go of does not report a second loss
  fail = true;
  wc.debugger.attach();
  wc.debugger.detach();
  await tick(5);
  assert.deepEqual(lost, ['attach_failed']);
});

test('cdp: assertCdpTarget lets a Chrome relay tab through only on its own check', () => {
  const r = fakeRelay();
  const wc = new ChromeTabContents({ relay: r, chatId: 'c', tab: { id: 5 } });
  assertCdpTarget(wc, { appContents: [], panelSession: null });
  r.linked = false;
  assert.throws(() => assertCdpTarget(wc, { appContents: [], panelSession: null }), code('not_connected'));
  // anything else shaped like it is still checked as a webContents
  const lookalike = { isDestroyed: () => false, id: 1, getType: () => 'window', assertDrivable() {} };
  assert.throws(() => assertCdpTarget(lookalike, { appContents: [], panelSession: null }), code('bad_target', /not a browser tab/));
});
