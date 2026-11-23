// A tab on a Host as the browser host's page (electron/capabilities/browser/remoteTab.cjs, package 2.6): page state from CDP events, history, and the debugger's attach, detach and failures. The Host's service is the transport; Chromium is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { flush } from './support/browser-host-kit.ts';
import { world, sent } from './support/remote-tabs-kit.ts';

const require = createRequire(import.meta.url);
const { RemoteTabContents } = require('../electron/capabilities/browser/remoteTab.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');

test('RemoteTabContents follows the page like a pane tab: loads, navigations, failures and history', async (t) => {
  const w = world(t);
  const tab = await w.tabs.create('c');
  const wc = tab.backend;
  await w.tabs.readPage(tab);
  let session = w.chromium.sessionOf(wc.targetId)!;
  const seen: string[] = [];
  for (const e of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) wc.on(e, () => seen.push(e));
  wc.on('did-fail-load', (_e: any, _c: any, d: string, u: string) => seen.push(`fail ${d} ${u}`));
  const emit = (m: string, p: any, sid = '') => w.chromium.emit(m, p, sid || session);
  emit('Page.frameStartedLoading', { frameId: wc.targetId });
  emit('Page.frameStartedLoading', { frameId: wc.targetId });
  assert.equal(wc.isLoading(), true);
  // a frame of the page is not the page
  emit('Page.frameStartedLoading', { frameId: 'child' });
  emit('Page.frameStoppedLoading', { frameId: 'child' });
  assert.equal(wc.isLoading(), true);
  emit('Network.requestWillBeSent', { type: 'Document', requestId: 'r1', frameId: wc.targetId });
  emit('Network.requestWillBeSent', { type: 'Script', requestId: 'r2', frameId: wc.targetId });
  emit('Network.requestWillBeSent', { type: 'Document', requestId: 'r3', frameId: 'child' });
  emit('Network.loadingFailed', { requestId: 'r2', errorText: 'x' });
  emit('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_NAME_NOT_RESOLVED', canceled: true });
  emit('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  emit('Page.frameNavigated', { frame: { id: wc.targetId, url: 'chrome-error://chromewebdata/', unreachableUrl: 'https://nope.test/' } });
  emit('Page.frameNavigated', { frame: { id: 'child', parentId: wc.targetId, url: 'https://ad.test/' } });
  emit('Page.frameNavigated', {});
  emit('Page.navigatedWithinDocument', { frameId: wc.targetId, url: 'https://nope.test/#a' });
  emit('Page.navigatedWithinDocument', { frameId: 'child', url: 'https://ad.test/#a' });
  emit('Page.frameStoppedLoading', { frameId: wc.targetId });
  emit('Page.frameStoppedLoading', { frameId: wc.targetId });
  emit('Network.dataReceived', {});
  await flush();
  assert.deepEqual(seen, [
    'did-start-loading',
    'did-navigate',
    'fail net::ERR_NAME_NOT_RESOLVED https://nope.test/',
    'did-navigate-in-page',
    'did-stop-loading',
  ]);
  assert.equal(wc.isLoading(), false);
  // events with parts missing leave the page's state as it was
  emit('Page.frameNavigated', { frame: {} });
  emit('Page.navigatedWithinDocument', { frameId: wc.targetId });
  assert.equal(typeof wc.getURL(), 'string');
  // a failed load without a failed document request is a plain failure
  w.chromium.emit('Page.frameStartedLoading', { frameId: wc.targetId }, session);
  emit('Page.frameNavigated', { frame: { id: wc.targetId, url: 'chrome-error://x', unreachableUrl: 'https://down.test/' } });
  assert.ok(seen.includes('fail ERR_FAILED https://down.test/'));
  // a navigation that arrives after the debugger was let go reads nothing
  await flush();
  const reads = sent(w, 'Page.getNavigationHistory').length;
  wc.debugger.detach();
  emit('Page.frameNavigated', { frame: { id: wc.targetId, url: 'https://late.test/' } });
  await flush();
  assert.equal(sent(w, 'Page.getNavigationHistory').length, reads);
  wc.debugger.attach();
  await flush();
  session = w.chromium.sessionOf(wc.targetId)!;
  // a frame's own session events reach the debugger but not the page's state
  const messages: string[] = [];
  wc.debugger.on('message', (_e: any, m: string, _p: any, sid: string) => messages.push(`${m}@${sid}`));
  const loadingBefore = wc.isLoading();
  w.chromium.sessions.set('F1', wc.targetId);
  emit('Target.attachedToTarget', { sessionId: 'F1', targetInfo: { targetId: 'frame', type: 'iframe' } });
  w.chromium.emit('Page.frameStartedLoading', { frameId: wc.targetId }, 'F1');
  emit('Runtime.consoleAPICalled', {});
  assert.deepEqual(messages, ['Target.attachedToTarget@', 'Page.frameStartedLoading@F1', 'Runtime.consoleAPICalled@']);
  assert.equal(wc.isLoading(), loadingBefore);
  // history: back and forward move through Chromium's entries; none to go to is nothing
  wc.history = {
    currentIndex: 1,
    entries: [
      { id: 5, url: 'a' },
      { id: 6, url: 'b' },
    ],
  };
  assert.equal(wc.navigationHistory.getActiveIndex(), 1);
  assert.equal(wc.navigationHistory.length(), 2);
  assert.equal(wc.navigationHistory.getEntryAtIndex(0).url, 'a');
  assert.equal(wc.navigationHistory.getEntryAtIndex(9), null);
  wc.navigationHistory.goBack();
  wc.navigationHistory.goForward();
  await flush();
  assert.deepEqual(
    sent(w, 'Page.navigateToHistoryEntry').map((c) => c.params.entryId),
    [5],
  );
  // a refresh keeps what a read cannot give
  w.chromium.fails.set('Page.getNavigationHistory', 'gone');
  w.chromium.fails.set('Target.getTargetInfo', 'gone');
  await wc.refresh();
  assert.equal(wc.history.entries.length, 2);
  w.chromium.fails.clear();
  // answers of an unexpected shape keep what the tab knew
  const odd = new RemoteTabContents({
    transport: {
      command: async (_c: string, r: any) =>
        r.method === 'Runtime.evaluate'
          ? { result: { value: 5 } }
          : r.method === 'Target.getTargetInfo'
            ? { targetInfo: { targetId: 'T' } }
            : { entries: 'x' },
    },
    hostId: 'h',
    chatId: 'c',
    tab: { targetId: 'T', url: 'u', title: 't' },
  });
  await odd.refresh();
  assert.deepEqual([odd.getURL(), odd.getTitle(), odd.getUserAgent(), odd.history.entries.length], ['u', 't', '', 0]);
  // a tab the Host has not named yet has nothing to read
  const blank = new RemoteTabContents({ transport: w.transport, hostId: 'h', chatId: 'c', open: new Promise(() => undefined) });
  await blank.refresh();
  // a Chromium that crashed the tab's session says CDP went; the next action attaches again
  let detached = 0;
  wc.debugger.on('detach', () => detached++);
  w.chromium.emit('Target.detachedFromTarget', { sessionId: session });
  assert.equal(detached, 1);
  assert.equal(wc.debugger.isAttached(), false);
});

test('a debugger that cannot attach says why on its next command, and attaching again recovers', async (t) => {
  const w = world(t);
  const tab = await w.tabs.create('c');
  const wc = tab.backend;
  w.chromium.fails.set('Target.attachToTarget', 'no such target');
  wc.debugger.attach();
  wc.debugger.attach();
  await flush();
  assert.equal(wc.debugger.isAttached(), false);
  await assert.rejects(
    wc.debugger.sendCommand('Page.enable'),
    (e: any) => e.code === 'failed' || /not attached|no such target|Target/.test(String(e.message)),
  );
  w.chromium.fails.clear();
  wc.debugger.attach();
  await flush();
  assert.equal(wc.debugger.isAttached(), true);
  await wc.debugger.sendCommand('Page.enable');
  // detach twice is one detach; sending when never attached is refused
  wc.debugger.detach();
  wc.debugger.detach();
  await assert.rejects(wc.debugger.sendCommand('Page.enable'), (e: any) => e.code === 'failed');
  // a tab the Host never opened rejects its created promise to whoever waits
  const never = new RemoteTabContents({ transport: w.transport, hostId: 'h', chatId: 'c', open: Promise.resolve({ targetId: '' }) });
  await assert.rejects(never.created, (e: any) => e.code === 'failed');
  assert.equal(never.isDestroyed(), true);
  const empty = new RemoteTabContents({ transport: w.transport, hostId: 'h', chatId: 'c', open: Promise.resolve(null as any) });
  await assert.rejects(empty.created, (e: any) => /didn't open/.test(e.message));
  // the Tab's receipt belongs to the dispatch
  wc.debugger.attach();
  let receipts = 0;
  await wc.debugger.sendGuardedCommand('Page.enable', {}, '', () => receipts++);
  assert.equal(receipts, 1);
  await wc.debugger.sendGuardedCommand('Page.enable');
  // a command a call that ended must not send: Stop in the call's own guard
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    guarded({ signal: ctl.signal }, () => wc.debugger.sendCommand('Page.enable')),
    (e: any) => e.code === 'aborted' || /ended|stopped|abort/i.test(String(e.message)),
  );
});
