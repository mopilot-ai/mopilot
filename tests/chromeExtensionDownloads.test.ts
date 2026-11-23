// Downloads in the user's Chrome (#1632): the extension matches a download to the chat tab that began it
// (chrome-extension/src/downloads.mjs, wired in background.mjs) and reports it; main turns the report into the same
// download lines the in-app browser's agent gets (agentDownloads.cjs reportChromeDownload, chromeLink + chromeHost).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { fakeChrome, playExtension, until } from './support/chrome-relay-kit.ts';

const require = createRequire(import.meta.url);
const { Downloads, MATCH_MS }: any = await import('../electron/chrome-extension/src/downloads.mjs');
const { startBackground }: any = await import('../electron/chrome-extension/src/background.mjs');
const { reportChromeDownload } = require('../electron/capabilities/browser/agentDownloads.cjs');
const { ChromeRelay } = require('../electron/capabilities/browser/chromeRelay.cjs');
const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');

const relays: any[] = [];
after(() => {
  for (const r of relays) r.stop();
});

function downloads(o: any = {}) {
  const chrome: any = fakeChromeApi();
  const sent: any[] = [];
  const logged: string[] = [];
  let now = 1000;
  const owners = new Map<number, string>([[7, 'chat-a']]);
  const d = new Downloads({
    chrome,
    owner: (tabId: number) => owners.get(tabId),
    send: (m: any) => sent.push(m),
    log: (what: string) => logged.push(what),
    now: () => now,
    ...o,
  });
  return { chrome, sent, logged, d, owners, advance: (ms: number) => (now += ms) };
}
const began = (url: string, tabId = 7) => [{ tabId }, 'Page.downloadWillBegin', { url, guid: 'g', suggestedFilename: 'x' }];

test('extension downloads: a download begun in a chat tab is reported from start to its file, by the chat', async () => {
  const { chrome, sent, d } = downloads();
  d.cdp(...began('https://a.example/report.pdf'));
  d.created({ id: 1, url: 'https://a.example/report.pdf', state: 'in_progress', filename: '', mime: 'application/pdf' });
  assert.deepEqual(sent, [
    {
      chat: 'chat-a',
      method: 'chrome.downloads.onChanged',
      params: [
        {
          tabId: 7,
          id: 1,
          url: 'https://a.example/report.pdf',
          filename: '',
          state: 'in_progress',
          error: null,
          bytesReceived: 0,
          totalBytes: 0,
          mime: 'application/pdf',
        },
      ],
    },
  ]);
  // a progress tick with neither a state nor a file name says nothing
  await d.changed({ id: 1, bytesReceived: { current: 5 } });
  assert.equal(sent.length, 1);
  chrome.downloads.items.set(1, {
    id: 1,
    url: 'https://a.example/report.pdf',
    finalUrl: 'https://cdn.example/report.pdf',
    filename: '/Users/u/Downloads/report.pdf',
    state: 'complete',
    bytesReceived: 10,
    totalBytes: 10,
  });
  await d.changed({ id: 1, state: { current: 'complete' } });
  assert.deepEqual(sent[1].params[0], {
    tabId: 7,
    id: 1,
    url: 'https://cdn.example/report.pdf',
    filename: '/Users/u/Downloads/report.pdf',
    state: 'complete',
    error: null,
    bytesReceived: 10,
    totalBytes: 10,
    mime: '',
  });
  // it ended: nothing more about it
  await d.changed({ id: 1, state: { current: 'complete' } });
  assert.equal(sent.length, 2);
});

test('extension downloads: matched by the final URL too; failures carry Chrome reason; the user own downloads stay unreported', async () => {
  const { chrome, sent, d, logged, advance } = downloads();
  // another tab (no chat), a non-download event and a malformed one are ignored
  d.cdp(...began('https://u.example/a', 99));
  d.cdp({ tabId: 7 }, 'Page.frameNavigated', {});
  d.cdp({ tabId: 7 }, 'Page.downloadWillBegin', {});
  d.created({ id: 2, url: 'https://u.example/a' });
  d.created(null);
  d.created({ id: 'x' });
  assert.equal(sent.length, 0);
  // matched by finalUrl; an interrupted download goes with its error
  d.cdp(...began('https://b.example/r'));
  d.created({ id: 3, url: 'https://b.example/start', finalUrl: 'https://b.example/r', state: 'interrupted', error: 'NETWORK_FAILED' });
  assert.equal(sent[0].params[0].state, 'interrupted');
  assert.equal(sent[0].params[0].error, 'NETWORK_FAILED');
  assert.equal(d.tracked.size, 0);
  // too late to match
  d.cdp(...began('https://c.example/late'));
  advance(MATCH_MS);
  d.created({ id: 4, url: 'https://c.example/late' });
  assert.equal(sent.length, 1);
  // Chrome's answer failing, or the item gone, says nothing
  d.cdp(...began('https://d.example/f'));
  d.created({ id: 5, url: 'https://d.example/f' });
  assert.equal(sent.length, 2);
  await d.changed({ id: 5, state: { current: 'complete' } });
  assert.equal(sent.length, 2, 'no item');
  chrome.fail['downloads.search'] = new Error('gone');
  await d.changed({ id: 5, filename: { current: '/x' } });
  assert.deepEqual(logged, ['read a download']);
  // two changes in flight for one download that ends: the second finds it gone
  d.cdp(...began('https://f.example/g'));
  d.created({ id: 6, url: 'https://f.example/g' });
  delete chrome.fail['downloads.search'];
  chrome.downloads.items.set(6, { id: 6, state: 'complete' });
  await Promise.all([d.changed({ id: 6, state: { current: 'complete' } }), d.changed({ id: 6, filename: { current: '/f' } })]);
  assert.deepEqual(
    sent.slice(-2).map((m) => [m.params[0].state, m.params[0].url]),
    [
      ['in_progress', 'https://f.example/g'],
      ['complete', ''],
    ],
  );
  // untracked and malformed deltas
  await d.changed({ id: 77, state: { current: 'complete' } });
  await d.changed(null);
  // pending begins are capped
  for (let i = 0; i < 30; i++) d.cdp(...began(`https://e.example/${i}`));
  assert.equal(d.pending.length, 20);
  // the real clock by default: read between two reads of it, since a millisecond may pass between calls
  const before = Date.now();
  const now = new Downloads({ chrome, owner: () => undefined, send: () => undefined, log: () => undefined }).now();
  assert.ok(now >= before && now <= Date.now(), `${now} is the clock`);
});

test('extension background: the downloads are wired to Chrome events and the chat tabs', async (t) => {
  const chrome: any = fakeChromeApi();
  const g = { chrome, WebSocket: class {}, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval };
  const warn = mock.method(console, 'warn', () => undefined);
  const bg = startBackground(g);
  t.after(() => bg.client.dispose());
  await bg.ready;
  bg.sessions.owner.set(7, 'chat-a');
  const sent: any[] = [];
  bg.client.send = (m: any) => sent.push(m);
  chrome.debugger.onEvent.fire(...began('https://a.example/z'));
  chrome.downloads.onCreated.fire({ id: 9, url: 'https://a.example/z' });
  chrome.downloads.items.set(9, { id: 9, url: 'https://a.example/z', state: 'complete', filename: '/d/z' });
  chrome.downloads.onChanged.fire({ id: 9, state: { current: 'complete' } });
  const reported = () => sent.filter((m) => m.method === 'chrome.downloads.onChanged');
  await until(() => reported().length === 2);
  assert.deepEqual(
    reported().map((m) => [m.chat, m.params[0].state]),
    [
      ['chat-a', 'in_progress'],
      ['chat-a', 'complete'],
    ],
  );
  bg.client.reset = async () => undefined;
  warn.mock.restore();
});

/* ---------- main: the report ---------- */

function host() {
  const changes: string[] = [];
  const told: any[] = [];
  const h: any = {
    chats: new Map([['c', {}]]),
    change: (_chat: string, line: string) => changes.push(line),
  };
  h.downloadListeners = new Set([
    (s: any) => told.push(s),
    () => {
      throw new Error('a failing listener');
    },
  ]);
  return { h, changes, told };
}

test('reportChromeDownload: started once, then where the file landed, as the in-app browser says it', () => {
  const { h, changes, told } = host();
  const tab: any = { chatId: 'c', id: 't1', downloads: [] };
  reportChromeDownload(h, tab, { id: 1, url: 'https://a.example/files/report.pdf?x=1', filename: '', state: 'in_progress' });
  reportChromeDownload(h, tab, { id: 1, url: 'https://a.example/files/report.pdf?x=1', filename: '/D/report.pdf', state: 'in_progress' });
  reportChromeDownload(h, tab, { id: 1, url: 'https://a.example/files/report.pdf', filename: '/D/report (1).pdf', state: 'complete' });
  assert.deepEqual(changes, ['download_started report.pdf in t1', 'download_completed report (1).pdf -> /D/report (1).pdf']);
  assert.deepEqual(tab.downloads, [{ name: 'report (1).pdf', path: '/D/report (1).pdf', state: 'completed' }]);
  assert.deepEqual(
    told.map((s) => [s.id, s.status]),
    [
      ['chrome-1', 'started'],
      ['chrome-1', 'complete'],
    ],
  );
  // cancelled by the user, or failed: no file
  tab.downloads.length = 0;
  reportChromeDownload(h, tab, { id: 2, url: 'https://a.example/', state: 'interrupted', error: 'USER_CANCELED' });
  assert.equal(changes.at(-1), 'download_cancelled download: stopped before it finished, so no file was saved');
  reportChromeDownload(h, tab, { id: 3, url: '', state: 'interrupted', error: 'NETWORK_FAILED' });
  assert.equal(changes.at(-1), 'download_failed download: the download failed, so no file was saved');
  assert.equal(told.at(-1).status, 'failed');
  // a long list keeps the last 20; a chat deleted meanwhile is not told the end
  for (let i = 10; i < 32; i++) reportChromeDownload(h, tab, { id: i, url: `https://a.example/${i}.zip`, state: 'in_progress' });
  assert.equal(tab.downloads.length, 20);
  h.chats.clear();
  const before = changes.length;
  reportChromeDownload(h, tab, { id: 31, filename: '/D/31.zip', state: 'complete' });
  assert.equal(changes.length, before);
});

/* ---------- main: the channel to the host ---------- */

const images = { fromBuffer: (b: Buffer) => ({ b, isEmpty: () => false, toBitmap: () => Buffer.from([255, 255, 255, 255]) }) };

test('chromeHost: a download the extension reports for a chat tab reaches that chat; other tabs and malformed ones do not', async () => {
  const x = playExtension(fakeChrome());
  const r = new ChromeRelay({ connectMs: 2000, commandMs: 500, openPage: x.openPage });
  relays.push(r);
  const tabs = chromeBrowserTabs({ relay: r, images });
  const t1 = await tabs.create('c', { focus: true });
  const ext = x.connections[0] as any;
  ext.event('chrome.downloads.onChanged', {
    tabId: t1.wc.tabId,
    id: 4,
    url: 'https://a.example/f.csv',
    filename: '',
    state: 'in_progress',
  });
  ext.event('chrome.downloads.onChanged', { tabId: 12345, id: 5, url: 'https://a.example/g.csv', state: 'in_progress' });
  ext.event('chrome.downloads.onChanged', { tabId: t1.wc.tabId });
  ext.event('chrome.downloads.onChanged');
  await until(() => t1.downloads.length === 1);
  assert.deepEqual(t1.downloads, [{ name: 'f.csv', path: '', state: 'progressing' }]);
  // a report that arrives after the host stopped following the relay goes nowhere
  const link = r.link('c');
  tabs.dispose();
  link.emit('download', { tabId: t1.wc.tabId, id: 6, url: 'https://a.example/h.csv', state: 'in_progress' });
  assert.equal(t1.downloads.length, 1);
});
