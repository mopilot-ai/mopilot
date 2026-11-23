// The legacy relay's report contract, shared by actual-socket and socket-free framed transport tests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { clientFrame, until } from './chrome-relay-kit.ts';
const require = createRequire(import.meta.url);
const { ChromeLink, CONNECT_PAGE } = require('../../electron/capabilities/browser/chromeLink.cjs');
const { recentIgnored } = require('../../electron/ignored.cjs');

/** A final ordered ready frame proves malformed frames were consumed before negative assertions. */
export async function assertLegacyReports(link: any, ext: { raw: (data: Buffer) => void; send: (message: any) => void }) {
  const seen: any[] = [];
  const connectTab = link.connectTab;
  assert.ok(Number.isSafeInteger(connectTab));
  assert.equal(link.membershipReceipts, false);
  for (const ev of ['tab', 'removed', 'cdp', 'detach']) link.on(ev, (...a: any[]) => seen.push([ev, ...a]));
  ext.raw(clientFrame(1, Buffer.from('not json')));
  ext.raw(clientFrame(1, Buffer.from('5')));
  ext.send({ method: 'chrome.tabs.onCreated', params: [{ noId: true }] });
  ext.send({ method: 'chrome.tabs.onCreated', params: [{ id: 7, url: 'https://a.test/', openerTabId: connectTab }] });
  ext.send({ method: 'chrome.tabs.onCreated', params: [{ id: 8, url: `${CONNECT_PAGE}?again` }] });
  ext.send({ method: 'chrome.debugger.onEvent', params: [{ tabId: 7 }, 'Page.loadEventFired', null] });
  ext.send({ method: 'chrome.debugger.onEvent', params: [{ tabId: 'x' }, 'Page.loadEventFired', {}] });
  ext.send({ method: 'chrome.debugger.onEvent', params: [null] });
  ext.send({ method: 'chrome.debugger.onDetach', params: [{ tabId: 7 }, 'canceled_by_user'] });
  ext.send({ method: 'chrome.debugger.onDetach', params: [{ tabId: 7 }] });
  ext.send({ method: 'chrome.debugger.onDetach', params: [{}] });
  ext.send({ method: 'chrome.tabs.onRemoved', params: [connectTab] });
  ext.send({ method: 'chrome.tabs.onRemoved' });
  for (const id of [null, -1, 1.5, '8', Number.MAX_SAFE_INTEGER + 1]) ext.send({ method: 'chrome.tabs.onRemoved', params: [id] });
  ext.send({ method: 'something.else', params: 'x' });
  ext.send({ method: 'chrome.tabs.onRemoved', params: [4242] });
  let complete = false;
  link.once('ready', () => {
    complete = true;
  });
  ext.send({ method: 'extension.initialized' });
  await until(() => complete);
  assert.ok(recentIgnored().some((e: any) => /parse a message from the Playwright Extension/.test(e.context)));
  assert.deepEqual(
    seen.map((s) => s[0]),
    ['tab', 'tab', 'cdp', 'detach', 'detach', 'removed', 'removed'],
  );
  assert.deepEqual(seen[2].slice(1), [{ tabId: 7 }, 'Page.loadEventFired', {}]);
  assert.deepEqual(seen[3].slice(1), [7, 'canceled_by_user']);
  assert.deepEqual(seen[4].slice(1), [7, '']);
  assert.deepEqual(
    seen.filter((s) => s[0] === 'removed'),
    [
      ['removed', connectTab],
      ['removed', 4242],
    ],
    'only valid IDs emit removals, including an unknown ID; malformed inputs never become successes',
  );
  assert.equal(link.connectTab, null, 'the connect tab went; a second connect page is not the chat tab');
  assert.equal(link.tabs.has(7), false, 'a tab the user took back is not the chat’s until reported again');
  assert.ok(link.tabs.has(8), 'invalid removal IDs cannot erase the remaining tab');
  assert.ok(link instanceof ChromeLink);
}
