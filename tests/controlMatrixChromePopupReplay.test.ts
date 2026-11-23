// Chrome popup ownership across connection replay: real extension sessions and transport, with only chrome.* mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { extensionWorld } from './support/chrome-extension-kit.ts';
import { until } from './support/chrome-relay-kit.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];

const require = createRequire(import.meta.url);
const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');
const { CONNECT_PAGE } = require('../electron/capabilities/browser/chromeRelay.cjs');

async function setup(t: any) {
  const w = await extensionWorld();
  const tabs = chromeBrowserTabs({ relay: w.channel, images: {} });
  t.after(() => {
    tabs.dispose();
    w.stop();
  });
  const root = await tabs.create('chat-a');
  const ids = () =>
    tabs
      .list('chat-a')
      .map((tab: any) => tab.wc.tabId)
      .sort();
  const disconnect = async () => {
    w.sockets.at(-1).sock.destroy();
    await until(() => !w.channel.connected('chat-a') && w.client.status !== 'connected');
    clearTimeout(w.client.retryTimer);
  };
  const reconnect = async () => {
    await w.connectExtension();
    return w.channel.connect('chat-a');
  };
  return { w, tabs, root, ids, disconnect, reconnect };
}

for (const reversed of [false, true]) {
  test(`CM-Z popup replay: disconnected child and nested child join once, ${reversed ? 'child-first' : 'parent-first'} replay`, async (t) => {
    const { w, tabs, root, ids, disconnect, reconnect } = await setup(t);
    const oldToken = w.channel.token('chat-a');
    await disconnect();
    const child = w.chrome.addTab({ openerTabId: root.wc.tabId });
    await w.sessions.onTabCreated(child);
    const nested = w.chrome.addTab({ openerTabId: child.id });
    await w.sessions.onTabCreated(nested);
    const unrelated = w.chrome.addTab();
    await w.sessions.onTabCreated(unrelated);
    if (reversed) w.sessions.chats.get('chat-a').tabs = new Set([nested.id, child.id, root.wc.tabId]);
    await tabs.turnEnded('chat-a');
    const link = await reconnect();
    assert.deepEqual(ids(), [root.wc.tabId, child.id, nested.id].sort());
    assert.equal(link.tabs.has(unrelated.id), false);
    assert.equal(w.chrome.attached.size, 0, 'adoption itself does not attach or act');
    await assert.rejects(w.channel.attach(oldToken, child.id), { code: 'stale_turn' });
    await w.channel.attach({ ...w.channel.token('chat-a'), membership: link.tabs.get(child.id).membership }, child.id);
    assert.ok(w.chrome.attached.has(child.id), 'the new turn can reach its own popup');
    link.emit('tab', child);
    assert.equal(tabs.list('chat-a').length, 3, 'duplicate reports do not duplicate tabs');
    assert.equal((await tabs.turnEnded('chat-a')).kept.length, 3);
    await disconnect();
    await reconnect();
    assert.equal(tabs.list('chat-a').length, 3, 'a second replay preserves the same tabs');
  });
}

test('CM-Z popup replay: removed children and departed openers never reappear', async (t) => {
  const { w, root, ids, disconnect, reconnect } = await setup(t);
  await disconnect();
  const removed = w.chrome.addTab({ openerTabId: root.wc.tabId });
  await w.sessions.onTabCreated(removed);
  w.sessions.onTabRemoved(removed.id);
  const orphan = w.chrome.addTab({ openerTabId: root.wc.tabId });
  await w.sessions.onTabCreated(orphan);
  w.sessions.onTabRemoved(root.wc.tabId);
  await reconnect();
  assert.deepEqual(ids(), []);
});

test('CM-Z popup replay: only the current link and this chat’s explicit opener lineage can adopt', async (t) => {
  const { w, tabs, root, ids, disconnect, reconnect } = await setup(t);
  const old = w.channel.link('chat-a');
  await disconnect();
  const link = await reconnect();
  const foreign = await tabs.create('chat-b');
  const reports = [
    { id: 900 },
    { id: 901, openerTabId: 4242 },
    { id: 902, openerTabId: foreign.wc.tabId },
    { id: 903, openerTabId: root.wc.tabId, url: CONNECT_PAGE },
    { id: 904, openerTabId: 905 },
    { id: 905, openerTabId: 904 },
  ];
  for (const tab of reports) link.tabs.set(tab.id, tab);
  link.emit('tab', reports[0]);
  const stale = { id: 906, openerTabId: root.wc.tabId };
  old.tabs.set(stale.id, stale);
  old.emit('tab', stale);
  old.emit('removed', root.wc.tabId);
  old.emit('detach', root.wc.tabId, 'canceled_by_user');
  old.emit('cdp', { tabId: root.wc.tabId }, 'Page.frameNavigated', { frame: { id: 'retired', url: 'https://retired.invalid/' } });
  assert.notEqual(root.wc.getURL(), 'https://retired.invalid/');
  assert.deepEqual(ids(), [root.wc.tabId]);
  tabs.dispose();
  const afterDispose = { id: 907, openerTabId: root.wc.tabId };
  link.tabs.set(afterDispose.id, afterDispose);
  link.emit('tab', afterDispose);
  assert.deepEqual(ids(), [root.wc.tabId]);
});

test('CM-Z popup replay: an opener retired at adoption cannot leave a phantom child', async (t) => {
  const { w, tabs, root, ids } = await setup(t);
  const adopt = tabs.adoptPopup.bind(tabs);
  tabs.adoptPopup = (opener: any, wc: any, options: any) => {
    opener.gone();
    return adopt(opener, wc, options);
  };
  const child = w.chrome.addTab({ openerTabId: root.wc.tabId });
  await w.sessions.onTabCreated(child);
  await until(() => w.channel.link('chat-a').tabs.has(child.id));
  assert.deepEqual(ids(), []);
  const nested = w.chrome.addTab({ openerTabId: child.id });
  await w.sessions.onTabCreated(nested);
  await until(() => w.channel.link('chat-a').tabs.has(nested.id));
  assert.deepEqual(ids(), []);
});

test('CM-Z popup replay: closing a popup during publication cannot revive it in the creation microtask', async (t) => {
  const { w, tabs, root, ids } = await setup(t);
  const child = w.chrome.addTab({ openerTabId: root.wc.tabId });
  tabs.o.onChange = () => {
    const popup = tabs.list('chat-a').find((tab: any) => tab.wc.tabId === child.id);
    popup?.wc.gone();
  };
  await w.sessions.onTabCreated(child);
  await until(() => w.channel.link('chat-a').tabs.has(child.id));
  const nested = w.chrome.addTab({ openerTabId: child.id });
  await w.sessions.onTabCreated(nested);
  await until(() => w.channel.link('chat-a').tabs.has(nested.id));
  assert.deepEqual(ids(), [root.wc.tabId]);
});

test('CM-Z popup replay: a parent explicitly closed offline never seeds its reported child', async (t) => {
  const { w, tabs, root, ids, disconnect, reconnect } = await setup(t);
  await disconnect();
  const child = w.chrome.addTab({ openerTabId: root.wc.tabId });
  await w.sessions.onTabCreated(child);
  await tabs.close('chat-a', root.id);
  await reconnect();
  await until(() => !w.chrome.tabsById.has(root.wc.tabId));
  assert.deepEqual(ids(), []);
  assert.equal(w.chrome.attached.size, 0);
});

test('CM-Z popup replay: live child-first reports drain when their known parent arrives', async (t) => {
  const { w, root, ids } = await setup(t);
  const link = w.channel.link('chat-a');
  const child = { id: 900, openerTabId: root.wc.tabId };
  const nested = { id: 901, openerTabId: child.id };
  link.tabs.set(nested.id, nested);
  link.emit('tab', nested);
  assert.deepEqual(ids(), [root.wc.tabId]);
  link.tabs.set(child.id, child);
  link.emit('tab', child);
  assert.deepEqual(ids(), [root.wc.tabId, child.id, nested.id].sort());
});
