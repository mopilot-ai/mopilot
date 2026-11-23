// The control matrix (docs/control-plane/matrix.md), stream Z: a chat keeps its Chrome tab when MoPilot's extension's MV3 service worker restarts (edge suite bu-sw-asleep, E-B2b).
// Main's channel, the browser host over Chrome, the browser_* tools, the Codex backend and the extension's own
// background logic are real and talk over a loopback WebSocket; Chrome is the chrome.* fake
// (tests/support/chrome-extension-kit.ts), so nothing starts a browser. A worker restart is the old worker's
// connection dropping with nothing of it left but chrome.storage.session, and a new Sessions and Client restoring
// from it and connecting again, as background.mjs does. Restored receipts and host/backend identities are fresh;
// the physical tab stays open, while a request using the retired identity fails before re-listing and retry.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { until } from './support/chrome-relay-kit.ts';
import { extensionWorld, loopbackWebSocket } from './support/chrome-extension-kit.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];

const require = createRequire(import.meta.url);
const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { ChromeBackend } = require('../electron/capabilities/browser/chromeBackend.cjs');
const { Sessions } = await import('../electron/chrome-extension/src/sessions.mjs');
const { Client } = await import('../electron/chrome-extension/src/client.mjs');
const { parsePairingCode, pairingCode } = await import('../electron/chrome-extension/src/protocol.mjs');

const stops: Array<() => void> = [];
after(() => {
  for (const s of stops) s();
});
const images = { fromBuffer: (b: Buffer) => ({ b, isEmpty: () => false, toBitmap: () => Buffer.from([255, 255, 255, 255]) }) };
const grants = {
  anchor: () => 'ask',
  peek: () => 'ok',
  require: async () => undefined,
  riskOf: () => ({ level: 'normal' }),
  act: async () => undefined,
};

/** Pages in the fake Chrome: a navigation answers with a loader, then the load events reach whichever worker runs now. */
function pages(w: any, worker: () => any) {
  const page = new Map<number, { url: string; title: string }>();
  const at = (tabId: number) => {
    if (!page.has(tabId)) page.set(tabId, { url: 'about:blank', title: '' });
    return page.get(tabId) as { url: string; title: string };
  };
  const c = w.chrome.cdp;
  c['Target.getTargetInfo'] = (_p: any, t: any) => ({
    targetInfo: { targetId: `T${t.tabId}`, url: at(t.tabId).url, title: at(t.tabId).title },
  });
  c['Page.getNavigationHistory'] = (_p: any, t: any) => ({ currentIndex: 0, entries: [{ id: 1, url: at(t.tabId).url }] });
  c['Page.getFrameTree'] = (_p: any, t: any) => ({ frameTree: { frame: { id: `T${t.tabId}` } } });
  c['Page.createIsolatedWorld'] = { executionContextId: 3 };
  c['Runtime.evaluate'] = (p: any) =>
    String(p.expression).includes('navigator.userAgent')
      ? { result: { value: 'Chrome/140' } }
      : { result: { value: { value: { quietMs: 1000, visibility: 'visible' }, seq: 0 } } };
  c['Page.navigate'] = (p: any, t: any) => {
    setTimeout(() => {
      const frame = `T${t.tabId}`;
      const s = worker().sessions;
      s.onDebuggerEvent({ tabId: t.tabId }, 'Page.frameStartedLoading', { frameId: frame });
      at(t.tabId).url = p.url;
      at(t.tabId).title = 'Example Domain';
      s.onDebuggerEvent({ tabId: t.tabId }, 'Page.frameNavigated', { frame: { id: frame, url: p.url } });
      s.onDebuggerEvent({ tabId: t.tabId }, 'Page.frameStoppedLoading', { frameId: frame });
    }, 5);
    return { frameId: `T${t.tabId}`, loaderId: 'L1' };
  };
}

/**
 * MoPilot and its extension over the fake Chrome, with the browser host and the browser_* tools on top, and a
 * way to restart the extension's service worker. `chromeHeld`: Chrome keeps a stopped worker's debuggers attached,
 * and refuses a second attach to a tab while one is (as it does for any debugger).
 */
async function setup({ chromeHeld = false, connectMs = 3000 } = {}) {
  const w = await extensionWorld({ connectMs, graceMs: 60_000 });
  stops.push(() => w.stop());
  const now = { sessions: w.sessions, client: w.client };
  pages(w, () => now);
  if (chromeHeld) {
    const attach = w.chrome.debugger.attach;
    w.chrome.debugger.attach = async (target: any, version: string) => {
      if (w.chrome.attached.has(target.tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${target.tabId}.`);
      return attach(target, version);
    };
  }
  const tabs = chromeBrowserTabs({ relay: w.channel, images });
  const tools = createBrowserTools({ tabs, grants });
  const tool = (n: string) => tools.find((t: any) => t.name === n);
  /** Chrome stops the worker (idle, or its DevTools target closed): its socket goes, and it runs nothing more; a new one starts from storage */
  const stopWorker = async () => {
    await now.sessions.saveTail; // A graceful fixture restart includes every queued ownership snapshot.
    const old = now.client;
    if (!w.channel.peer) return;
    const peer = w.channel.peer;
    const ws = old.ws;
    old.dispose({ releaseSessions: false });
    ws.sock.destroy();
    await until(() => w.channel.peer !== peer);
  };
  const restartWorker = async () => {
    await stopWorker();
    const peer = w.channel.peer;
    const { LoopbackWebSocket } = loopbackWebSocket();
    let client: any;
    const sessions = new Sessions({
      chrome: w.chrome,
      send: (m: any) => client.send(m),
      storage: w.chrome.storage.session,
      log: () => undefined,
    });
    const code = pairingCode(w.port, w.pairing.get().secret);
    client = new Client({
      WebSocket: LoopbackWebSocket,
      crypto: webcrypto,
      pairing: async () => parsePairingCode(code),
      sessions,
      version: '0.3.0',
    });
    stops.push(() => client.dispose({ releaseSessions: false }));
    now.sessions = sessions;
    now.client = client;
    await sessions.restore();
    await sessions.saveTail; // Restored native-debugger cleanup is durable before the next connection.
    await client.connect();
    await until(() => w.channel.peer?.open && w.channel.peer !== peer);
  };
  return { w, tabs, tool, stopWorker, restartWorker, now };
}

const navigations = (w: any) =>
  w.chrome.log.filter((l: any) => l[0] === 'debugger.sendCommand' && l[2] === 'Page.navigate').map((l: any) => [l[1].tabId, l[3].url]);
const created = (w: any) => w.chrome.log.filter((l: any) => l[0] === 'tabs.create').length;

test('CM-Z29: worker restore retires the old request and wrapper, then re-listing drives the same physical Chrome tab', async () => {
  const { w, tabs, tool, restartWorker, now } = await setup();
  const ctx = { chatId: 'c', segmentId: 'codex-thread' };
  await tool('browser_navigate').handler({ url: 'http://localhost:8790/s/bu-note' }, ctx);
  const first = tabs.current('c');
  const chromeId = first.wc.tabId;
  const oldReceipt = first.wc.membership;
  await tabs.turnEnded('c');
  await until(() => !w.chrome.attached.has(chromeId));

  await restartWorker();
  assert.equal(w.channel.connected('c'), false, 'the chat’s connection went with the old worker');
  assert.equal(tabs.current('c'), first, 'the suspended wrapper remains until the chat reconnects');
  assert.equal(first.wc.isDestroyed(), false);
  assert.equal(now.sessions.owner.get(chromeId), 'c', 'the new worker restored the physical tab');
  assert.notEqual(now.sessions.memberships.get(chromeId).id, oldReceipt);

  const before = created(w);
  const url = 'http://localhost:8790/s/bu-note?saved=1';
  await assert.rejects(tool('browser_navigate').handler({ tabId: first.id, url }, ctx), { code: 'tab_closed' });
  assert.equal(first.wc.isDestroyed(), true);
  assert.equal(
    navigations(w).some(([, target]) => target === url),
    false,
    'the retired request never navigates',
  );
  const listed = await tool('browser_tabs_context').handler({}, ctx);
  const fresh = tabs.list('c').find((tab) => tab.wc.tabId === chromeId);
  assert.ok(fresh);
  assert.notEqual(fresh, first);
  assert.notEqual(fresh.id, first.id);
  assert.notEqual(fresh.wc.membership, oldReceipt);
  assert.equal(fresh.created, false);
  assert.equal(fresh.owner, null);
  assert.ok(listed[0].text.includes(fresh.id), 're-listing exposes the fresh identity');
  const out = await tool('browser_navigate').handler({ tabId: fresh.id, url }, ctx);
  assert.ok(out[0].text.startsWith(`Navigated ${fresh.id} to ${url}`));
  assert.equal(created(w), before, 'no new physical tab was opened');
  assert.deepEqual(navigations(w).at(-1), [chromeId, url]);
  assert.ok(w.chrome.attached.has(chromeId));
  assert.ok(w.chrome.tabsById.get(chromeId).groupId > 0);
});

test('CM-Z29: the Chrome backend retires its old tab ID after worker restore and re-lists a fresh ID for the same physical tab', async () => {
  const { w, tabs, restartWorker } = await setup();
  const b = new ChromeBackend({ threadId: 'th-1', chatOf: () => 'c', tabs: () => tabs, grants: () => grants });
  const tab = await b.handle('createTab', { session_id: 'th-1' });
  const first = tabs.current('c');
  const chromeId = first.wc.tabId;
  const cdp = (tabId: number, url: string) =>
    b.handle('executeCdp', { session_id: 'th-1', target: { tabId }, method: 'Page.navigate', commandParams: { url } });
  await cdp(tab.id, 'http://localhost:8790/s/bu-note');
  await tabs.turnEnded('c');
  await restartWorker();
  const url = 'http://localhost:8790/s/bu-note#again';
  await assert.rejects(cdp(tab.id, url), { code: 'tab_closed' });
  assert.equal(
    navigations(w).some(([, target]) => target === url),
    false,
  );
  const listed = await b.handle('getTabs', { session_id: 'th-1' });
  assert.equal(listed.length, 1);
  const fresh = listed[0];
  assert.notEqual(fresh.id, tab.id);
  assert.notEqual(fresh.providerTabId, tab.providerTabId);
  assert.equal(fresh.sessionControlled, false, 'old backend control is not inherited');
  assert.equal(first.wc.isDestroyed(), true);
  assert.equal(tabs.list('c')[0].wc.tabId, chromeId);
  await assert.rejects(cdp(tab.id, url), /Unknown tab/);
  await cdp(fresh.id, url);
  assert.deepEqual(navigations(w).at(-1), [chromeId, url]);
});

test('CM-Z29: a debugger the stopped worker still held is let go when the new worker starts, so the chat attaches again instead of finding it taken', async () => {
  const { w, tabs, tool, restartWorker, now } = await setup({ chromeHeld: true });
  const ctx = { chatId: 'c', segmentId: 's' };
  await tool('browser_navigate').handler({ url: 'https://example.com/' }, ctx);
  const first = tabs.current('c');
  const chromeId = first.wc.tabId;
  await now.sessions.saveTail;
  assert.deepEqual(w.chrome.store.session.sessions.c.attached, [chromeId], 'what the worker attached is kept in storage');
  // the worker stops mid-turn: Chrome keeps its debugger on the tab
  await restartWorker();
  assert.equal(w.chrome.attached.has(chromeId), false, 'the new worker let go of it');
  assert.deepEqual(w.chrome.store.session.sessions.c.attached, []);
  await assert.rejects(tool('browser_navigate').handler({ tabId: first.id, url: 'https://example.com/two' }, ctx), { code: 'tab_closed' });
  await tool('browser_tabs_context').handler({}, ctx);
  const fresh = tabs.list('c').find((tab) => tab.wc.tabId === chromeId);
  assert.ok(fresh);
  assert.notEqual(fresh, first);
  await tool('browser_navigate').handler({ tabId: fresh.id, url: 'https://example.com/two' }, ctx);
  assert.deepEqual(navigations(w).at(-1), [chromeId, 'https://example.com/two']);
});

test('CM-Z29: a tab closed while the worker was away is gone for the chat: its next action opens another tab by itself', async () => {
  const { w, tabs, tool, restartWorker } = await setup();
  const ctx = { chatId: 'c', segmentId: 's' };
  await tool('browser_navigate').handler({ url: 'https://example.com/' }, ctx);
  const first = tabs.current('c');
  await tabs.turnEnded('c');
  await restartWorker();
  w.chrome.tabsById.delete(first.wc.tabId);
  // the old tab's own action reconnects and learns it is gone
  await assert.rejects(first.send('Runtime.evaluate', { expression: '1' }), (e: any) => e.code === 'tab_closed');
  assert.equal(first.wc.isDestroyed(), true);
  await tool('browser_navigate').handler({ url: 'https://example.com/two' }, ctx);
  const next = tabs.current('c');
  assert.notEqual(next, first);
  assert.deepEqual(navigations(w).at(-1), [next.wc.tabId, 'https://example.com/two']);
});

test('CM-Z29: a connection MoPilot closes (the chat deleted) still takes the chat’s tabs with it', async () => {
  const { w, tabs, tool } = await setup();
  await tool('browser_navigate').handler({ url: 'https://example.com/' }, { chatId: 'c', segmentId: 's' });
  const wc = tabs.current('c').wc;
  w.channel.disconnect('c');
  assert.equal(wc.isDestroyed(), true);
  assert.equal(wc.resuming, false);
});

test('CM-Z29: an offline action fails as disconnected; after worker restore the retired identity fails and a fresh identity retries on the same tab', async () => {
  const { w, tabs, tool, stopWorker, restartWorker } = await setup({ connectMs: 200 });
  const ctx = { chatId: 'c', segmentId: 's' };
  await tool('browser_navigate').handler({ url: 'https://example.com/' }, ctx);
  const first = tabs.current('c');
  await tabs.turnEnded('c');
  await stopWorker();
  await assert.rejects(tool('browser_navigate').handler({ url: 'https://example.com/two' }, ctx), (e: any) => e.code === 'not_connected');
  assert.equal(tabs.current('c'), first, 'still the chat’s tab');
  assert.equal(first.wc.resuming, true);
  await restartWorker();
  const url = 'https://example.com/three';
  await assert.rejects(tool('browser_navigate').handler({ tabId: first.id, url }, ctx), { code: 'tab_closed' });
  assert.equal(
    navigations(w).some(([, target]) => target === url),
    false,
  );
  await tool('browser_tabs_context').handler({}, ctx);
  const fresh = tabs.list('c').find((tab) => tab.wc.tabId === first.wc.tabId);
  assert.ok(fresh);
  assert.notEqual(fresh.id, first.id);
  assert.equal(first.wc.isDestroyed(), true);
  await tool('browser_navigate').handler({ tabId: fresh.id, url }, ctx);
  assert.deepEqual(navigations(w).at(-1), [first.wc.tabId, url]);
});

test('CM-Z29: an offline close stays closed after worker restore without deleting the fresh native membership; another kept tab rehydrates', async () => {
  const { w, tabs, tool, stopWorker, restartWorker } = await setup();
  const ctx = { chatId: 'c', segmentId: 's' };
  await tool('browser_navigate').handler({ url: 'https://example.com/' }, ctx);
  const first = tabs.current('c');
  const chromeId = first.wc.tabId;
  const second = await tabs.create('c');
  const secondId = second.wc.tabId;
  // both unmarked tabs stay in the chat's group across the turn end and worker restart
  await tabs.turnEnded('c');
  second.wc.loading = true;
  await stopWorker();
  assert.equal(second.wc.isLoading(), false, 'no load event comes while it has no debugger');
  await tabs.close('c', first.id);
  assert.equal(first.wc.isDestroyed(), true, 'it left the chat at once');
  assert.ok(w.chrome.tabsById.has(chromeId), 'Chrome still has it while the extension is away');
  await restartWorker();
  await assert.rejects(tool('browser_navigate').handler({ tabId: second.id, url: 'https://example.com/two' }, ctx), { code: 'tab_closed' });
  await tool('browser_tabs_context').handler({}, ctx);
  const fresh = tabs.list('c').find((tab) => tab.wc.tabId === secondId);
  assert.ok(fresh);
  assert.notEqual(fresh, second);
  assert.notEqual(fresh.id, second.id);
  assert.equal(second.wc.isDestroyed(), true);
  await tool('browser_navigate').handler({ tabId: fresh.id, url: 'https://example.com/two' }, ctx);
  assert.deepEqual(navigations(w).at(-1), [secondId, 'https://example.com/two']);
  assert.equal(first.wc.isDestroyed(), true);
  assert.deepEqual(
    tabs.list('c').map((tab) => tab.wc.tabId),
    [secondId],
    'the explicit close cannot be undone by replay',
  );
  assert.ok(w.chrome.tabsById.has(chromeId), 'the obsolete close cannot delete a newly restored native membership');
  assert.equal(
    w.chrome.log.some(([name, id]) => name === 'tabs.remove' && id === chromeId),
    false,
  );
  assert.ok(w.chrome.tabsById.has(secondId), 'the other physical tab stays open');
});
