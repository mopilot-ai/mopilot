// CM-K31: a navigation that turns into a download (Content-Disposition: attachment) is never a failed load (#1484).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { treeFiles } from '../scripts/source-tree.mjs';
import { setup as viewSetup } from './support/browser-view-fixture.ts';
import { setup as hostSetup, tabOf } from './support/browser-host-kit.ts';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { browserWorld } = require('./helpers/browser.cjs');
const { BrowserWindows } = require('../electron/capabilities/browser/windows.cjs');
const { PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');
const { noteDownload, wasDownload, isFailedLoad, WINDOW_MS } = require('../electron/capabilities/browser/downloadNavigations.cjs');
const { browserDownloads } = require('../electron/app/browserDownloads.cjs');

const FILE = 'http://mail.localhost:8820/m/MSG-1/att/0';

test('CM-K31: a navigation that turned into a download is no failed load: no pane notice, no Retry dead end, no agent error (#1484)', async (t) => {
  // the rule: a page's download from a URL (its redirect chain included) makes that URL's failure no failed load, for a while
  const wc = {};
  noteDownload(wc, [FILE, 'http://cdn.test/passport.pdf', null], 1000);
  assert.equal(wasDownload(wc, 'http://cdn.test/passport.pdf', 1000 + WINDOW_MS - 1), true);
  assert.equal(wasDownload(wc, FILE, 1000 + WINDOW_MS), false, 'a later failure of the same URL is one');
  assert.equal(wasDownload({}, FILE), false);
  assert.equal(wasDownload(null, FILE), false);
  noteDownload(null, [FILE]);
  noteDownload(wc, [], 2000);
  assert.equal(wasDownload(wc, FILE, 2000), true, 'nothing to note changes nothing');
  assert.equal(isFailedLoad(wc, -20, FILE, true, 2000), false);
  assert.equal(isFailedLoad(wc, -105, 'http://x.test/', true, 2000), true);
  assert.equal(isFailedLoad(wc, -3, 'http://x.test/', true, 2000), false);
  assert.equal(isFailedLoad(wc, -105, 'http://x.test/', false, 2000), false);

  // the session's will-download notes the page, from the download's URL chain (a redirect included), else its URL
  const saved: string[] = [];
  const d = browserDownloads({
    app: { getPath: () => '/tmp/dl' },
    session: { fromPartition: () => ({ on: () => undefined }) },
    partition: 'persist:browser',
    tabs: () => ({ download: () => '/tmp/agent/passport.csv' }),
  });
  const viaChain = {};
  d.onBrowserDownload({}, { getURLChain: () => [FILE, 'http://cdn.test/p.csv'], setSavePath: (f: string) => saved.push(f) }, viaChain);
  const viaUrl = {};
  d.onBrowserDownload({}, { getURL: () => FILE, setSavePath: (f: string) => saved.push(f) }, viaUrl);
  assert.deepEqual([wasDownload(viaChain, 'http://cdn.test/p.csv'), wasDownload(viaUrl, FILE)], [true, true]);
  assert.deepEqual(saved, ['/tmp/agent/passport.csv', '/tmp/agent/passport.csv']);

  // the pane's notice (BrowserWindows): no "failed" for the download's URL; another failure still shows
  const w = browserWorld();
  const panel = new PanelBrowser({ ...w, open: () => false });
  panel.attach('chat', w.root, w.host);
  const manager = new BrowserWindows({ ...w, onPopup: () => undefined });
  manager.register(w.root);
  noteDownload(w.root, [FILE]);
  w.root.emit('did-start-loading');
  w.root.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', FILE, true);
  w.root.emit('did-stop-loading');
  assert.equal(manager.state(w.root.id, w.host)[0].kind, 'ready');
  // sage_browser_* (cdp.cjs PanelBrowser) on the same page records no failure for it
  assert.equal(panel.tabs.get('chat').failure ?? null, null);
  w.root.emit('did-start-loading');
  w.root.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://gone.test/', true);
  assert.equal(manager.state(w.root.id, w.host)[0].detail, 'ERR_NAME_NOT_RESOLVED');

  // the view (views.cjs): the pane hears no failure for it, and its toolbar load of that URL resolves
  const { views, sender } = viewSetup();
  const r = views.bind('p1', sender, { url: 'https://mail.test/' });
  const e = views.entryOf(r.id);
  noteDownload(e.wc, [FILE]);
  sender.sent.length = 0;
  e.wc.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', FILE, true);
  e.wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://gone.test/', true);
  assert.deepEqual(
    sender.sent.map(([, p]: any) => [p.type, p.detail?.validatedURL]),
    [['did-fail-load', 'https://gone.test/']],
  );
  e.wc.loadResult = Promise.reject(new Error('ERR_BLOCKED_BY_CLIENT (-20) loading'));
  assert.equal(await views.nav(e.id, sender, 'load', FILE), undefined);
  e.wc.loadResult = Promise.reject(new Error('ERR_NAME_NOT_RESOLVED'));
  await assert.rejects(views.nav(e.id, sender, 'load', 'https://gone.test/'), /NAME_NOT_RESOLVED/);

  // ...and another failure still is one there; an agent's tab (tab.cjs) the same
  assert.equal(panel.tabs.get('chat').failure, 'ERR_NAME_NOT_RESOLVED');
  const tab = tabOf(hostSetup(t));
  noteDownload(tab.wc, [FILE]);
  tab.wc.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', FILE, true);
  assert.equal(tab.failure, null);
  tab.wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://gone.test/', true);
  assert.equal(tab.failure, 'ERR_NAME_NOT_RESOLVED');
});

test("CM-K31: every agent navigate that reads Page.navigate's errorText asks whether the link became a download (#1523)", () => {
  // Chromium answers a link that serves a file with ERR_ABORTED, and the download's will-download can come just after:
  // only the shared rule (downloadNavigations.cjs becameDownload) waits for it, so a navigate that throws on errorText
  // without asking it tells the agent "Couldn't open" for a file that is downloading
  const root = fileURLToPath(new URL('../electron/', import.meta.url));
  const readers = treeFiles(root, /\.cjs$/)
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => /'Page\.navigate'/.test(text) && /\br\.errorText\b/.test(text));
  assert.deepEqual(
    readers.map(({ file }) => file.slice(root.length)).sort(),
    ['capabilities/browser/cdp.cjs', 'capabilities/browser/hostNavigation.cjs'],
    'the scan still finds the agent navigate paths',
  );
  for (const { file, text } of readers) assert.match(text, /becameDownload\(/, `${file} reads errorText without becameDownload`);
});
