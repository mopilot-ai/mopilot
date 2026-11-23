// A chat's Chrome tabs when it lets go of them (#1699: finished chats' tabs piled up in the user's Chrome until it
// stalled): the tabs its agent opened close (chromeHost.cjs ChromeTabs#closeLeftovers), except a tab the user brought
// to the front or took over, one ever marked deliverable or handoff, one the agent's last reply names (address or
// title), and a tab the user brought into the group. The extension reports the user activating a chat's tab
// (background.mjs, chromeLink.cjs `chrome.tabs.onActivated`). The relay and host are real; Chrome is a fake on loopback.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { pageChrome, playExtension, until } from './support/chrome-relay-kit.ts';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';

const require = createRequire(import.meta.url);
const { ChromeRelay } = require('../electron/capabilities/browser/chromeRelay.cjs');
const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');
const { startBackground }: any = await import('../electron/chrome-extension/src/background.mjs');

const relays: any[] = [];
after(() => {
  for (const r of relays) r.stop();
});
const images = { fromBuffer: () => ({ isEmpty: () => false, toBitmap: () => Buffer.from([255, 255, 255, 255]) }) };

function world() {
  const x = playExtension();
  pageChrome(x);
  const r = new ChromeRelay({ openPage: x.openPage, connectMs: 2000, commandMs: 1000 });
  relays.push(r);
  const tabs = chromeBrowserTabs({ relay: r, images });
  const removed = () => x.chrome.log.filter((l: any) => l[0] === 'chrome.tabs.remove').map((l: any) => l[1][0]);
  return { x, r, tabs, removed };
}

test('let-go closes the agent tabs nobody keeps; marked, activated, taken, named and user-brought tabs stay', async () => {
  const { x, tabs, removed } = world();
  // 0 plain, 1 marked, 2 activated, 3 named by address, 4 named by title, 5 user-brought, 6 taken over
  const t: any[] = [];
  for (let i = 0; i < 7; i++) t.push(await tabs.create('c'));
  // marked deliverable this turn: kept even after the mark lapses
  tabs.mark('c', t[1].id, 'deliverable');
  // the user brought it to the front
  x.connections[0].event('chrome.tabs.onActivated', t[2].wc.tabId);
  x.connections[0].event('chrome.tabs.onActivated', 'not a tab');
  x.connections[0].event('chrome.tabs.onActivated', 99999);
  // named in the agent's last reply, by its address or its title
  t[3].wc.url = 'https://shop.test/cart?session=1';
  t[4].wc.title = 'Order confirmation';
  tabs.noteReply('c', 'Your cart is at https://shop.test/cart and the "Order confirmation" page is open.');
  tabs.noteReply('c', null);
  // a tab the user dragged into the group, and one the user took over
  t[5].openedByAgent = false;
  t[6].userTook = true;
  await until(() => tabs.kept.has(t[2].wc));
  tabs.forget('c');
  await until(() => removed().length === 1);
  assert.deepEqual(removed(), [t[0].wc.tabId]);
  // its reply is forgotten with it
  assert.equal(tabs.replies.has('c'), false);
});

test('let-go with no reply keeps nothing it would not otherwise; a close that throws is noted, the rest go on', async () => {
  const { tabs, removed } = world();
  const a = await tabs.create('d');
  const b = await tabs.create('d');
  a.wc.url = 'https://a.test/';
  // a tab whose close throws (already closing): noted, and the others still close
  const close = tabs.o.close;
  tabs.o.close = (tab: any) => {
    if (tab === a) throw new Error('already closing');
    return close(tab);
  };
  tabs.forget('d');
  await until(() => removed().length === 1);
  assert.deepEqual(removed(), [b.wc.tabId]);
  assert.ok(recentIgnored().some((e: any) => /close a let-go chat's tab in Chrome/.test(JSON.stringify(e))));
  // an activation that arrives after the host stopped following the relay keeps nothing
  const { x: x2, tabs: tabs2 } = world();
  const c = await tabs2.create('e');
  tabs2.dispose();
  x2.connections[0].event('chrome.tabs.onActivated', c.wc.tabId);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tabs2.kept.has(c.wc), false);
});

test("extension background: the user bringing a chat's tab to the front is reported to that chat only", async () => {
  const chrome: any = fakeChromeApi();
  const g = { chrome, WebSocket: class {}, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval };
  const warn = mock.method(console, 'warn', () => undefined);
  const bg = startBackground(g);
  await bg.ready;
  bg.sessions.owner.set(7, 'chat-a');
  const sent: any[] = [];
  bg.client.send = (m: any) => sent.push(m);
  chrome.tabs.onActivated.fire({ tabId: 7, windowId: 1 });
  chrome.tabs.onActivated.fire({ tabId: 8, windowId: 1 });
  assert.deepEqual(sent, [{ chat: 'chat-a', method: 'chrome.tabs.onActivated', params: [7] }]);
  warn.mock.restore();
});
