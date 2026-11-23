// The browser backend contract (electron/capabilities/browser/backend.cjs): a marked fake backend runs the host's tools, and the local wrapper reads through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drive, setup, tabOf, image } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const { markBackendTab, isBackendTab, captureContents } = require('../electron/capabilities/browser/backend.cjs');
const { LocalTabContents } = require('../electron/capabilities/browser/localBackend.cjs');
const { assertCdpTarget } = require('../electron/capabilities/browser/cdp.cjs');

/** A backend that is no Electron page: no session, type or window, only the contract. */
function backendOf(h: any, o: any = {}) {
  const wc = h.newWC({ type: 'remote', session: undefined, owner: undefined, ...o });
  return markBackendTab(wc);
}

test('a marked backend is driven by the host tools with no Electron checks (open, navigate, click, capture, dialog)', async (t) => {
  const h = setup(t);
  const wc = backendOf(h);
  const tab = tabOf(h, 'tab_aaaaaa', 'c', wc, null);
  assert.equal(tab.backend, wc, 'a backend is its own backend');
  assert.equal(h.tabs.byKey('c', 'tab_aaaaaa'), tab);
  wc.handlers['Page.navigate'] = (p: any) => {
    wc.url = p.url;
    setTimeout(() => wc.emit('did-stop-loading'), 1);
    return {};
  };
  wc.title = 'Remote';
  await drive(t, h.tabs.navigate(tab, 'https://a.test/'));
  assert.equal(tab.url, 'https://a.test/');
  assert.equal(tab.title, 'Remote');
  const st = { w: 800, h: 600, dpr: 1, sx: 0, sy: 0 };
  const shot = await drive(t, h.tabs.capture(tab, st));
  assert.equal(shot.width, 800);
  const p = await h.tabs.point(tab, st, { coordinate: [10, 10] });
  await drive(t, h.tabs.click(tab, p));
  assert.ok(wc.debugger.sent('Input.dispatchMouseEvent').length > 0);
  wc.debugger.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' });
  assert.equal(tab.dialog.message, 'Sure?');
  await drive(t, h.tabs.handleDialog(tab, true, undefined));
  assert.equal(wc.debugger.sent('Page.handleJavaScriptDialog').length, 1);
  h.tabs.detach?.('c');
});

test('capture prefers the backend capture(), and a backend with none or an empty answer falls back to CDP', async (t) => {
  const h = setup(t);
  const wc = backendOf(h);
  const seen: any[] = [];
  wc.capture = (rect: any) => (seen.push(rect), Promise.resolve(image({ src: 'backend' })));
  const tab = tabOf(h, 'tab_aaaaaa', 'c', wc, null);
  const st = { w: 800, h: 600, dpr: 1, sx: 0, sy: 0 };
  const own = JSON.parse(Buffer.from((await drive(t, h.tabs.capture(tab, st))).data, 'base64').toString());
  assert.equal(own.info.src, 'backend');
  assert.equal(seen.length, 1);
  assert.equal(wc.debugger.sent('Page.captureScreenshot').length, 0);
  wc.capture = () => Promise.resolve(null);
  wc.handlers['Page.captureScreenshot'] = () => ({ data: 'AA==' });
  const viaCdp = JSON.parse(Buffer.from((await drive(t, h.tabs.capture(tab, st))).data, 'base64').toString());
  assert.equal(viaCdp.info.src, 'cdp');
  assert.ok(wc.debugger.sent('Page.captureScreenshot').length > 0);
});

test('captureContents: capture() first, then capturePage, else nothing', async () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 };
  assert.equal((await captureContents({ capture: (r: any) => ['own', r], capturePage: () => 'page' }, rect))[0], 'own');
  assert.equal((await captureContents({ capturePage: (r: any) => ({ page: r }) }, rect)).page, rect);
  assert.equal(await captureContents({}, rect), null);
});

test('assertCdpTarget accepts a marked backend through its own assertDrivable, and refuses an unmarked foreign object', (t) => {
  const h = setup(t);
  const o = { appContents: [h.owner], panelSession: h.panelSession };
  const plain = backendOf(h);
  assert.doesNotThrow(() => assertCdpTarget(plain, o));
  delete plain.assertDrivable;
  assert.doesNotThrow(() => assertCdpTarget(plain, o), 'no check of its own: not destroyed is enough');
  plain.destroy();
  assert.throws(() => assertCdpTarget(plain, o), /it is gone/, 'no check of its own: destroyed is refused');
  const gone = backendOf(h);
  gone.assertDrivable = () => {
    throw new Error('Refusing to drive this page over CDP: it is gone');
  };
  assert.throws(() => assertCdpTarget(gone, o), /it is gone/);
  assert.equal(isBackendTab(gone), true);
  const foreign = h.newWC({ type: 'remote', session: undefined });
  assert.equal(isBackendTab(foreign), false);
  assert.throws(() => assertCdpTarget(foreign, o), { code: 'bad_target' });
  assert.equal(isBackendTab(null), false);
  assert.equal(isBackendTab('x'), false);
});

test('LocalTabContents reads through to the webContents and delegates capture', async (t) => {
  const h = setup(t);
  const wc = h.newWC();
  wc.url = 'https://l.test/';
  wc.title = 'Local';
  wc.loading = true;
  const local = new LocalTabContents(wc);
  assert.deepEqual(
    [local.id, local.debugger, local.navigationHistory, local.isDestroyed(), local.getURL(), local.getTitle(), local.isLoading()],
    [wc.id, wc.debugger, wc.navigationHistory, false, 'https://l.test/', 'Local', true],
  );
  local.setBackgroundThrottling(false);
  assert.deepEqual(wc.throttling, [false]);
  const shot = await local.capture({ x: 0, y: 0, width: 5, height: 5 });
  assert.equal(shot.info.src, 'capturePage');
  const heard: string[] = [];
  const fn = () => heard.push('x');
  assert.equal(local.on('ping', fn), local);
  assert.equal(local.once('pong', fn), local);
  wc.emit('ping');
  wc.emit('pong');
  assert.equal(local.off('ping', fn), local);
  wc.emit('ping');
  assert.equal(heard.length, 2);
  Object.assign(wc, {
    isCrashed: () => true,
    reload: () => heard.push('reload'),
    stop: () => heard.push('stop'),
    getUserAgent: () => 'UA',
    getZoomFactor: () => 1.5,
  });
  assert.deepEqual([local.isCrashed(), local.getUserAgent(), local.getZoomFactor()], [true, 'UA', 1.5]);
  local.reload();
  local.stop();
  assert.deepEqual(heard.slice(2), ['reload', 'stop']);
  wc.destroy();
  assert.equal(local.isDestroyed(), true);
});

test('a pane tab gets a LocalTabContents; the Electron wc stays on tab.wc for the window layers', (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  assert.ok(tab.backend instanceof LocalTabContents);
  assert.equal(tab.backend.contents, tab.wc);
});

const { keyOf } = require('../electron/capabilities/browser/pageKey.cjs');
const { noteDownload, wasDownload, becameDownload } = require('../electron/capabilities/browser/downloadNavigations.cjs');
const { isViewTab } = require('../electron/capabilities/browser/views.cjs');

test('keyOf: a wrapped page is keyed by its webContents, a backend that is its own page by itself', (t) => {
  const h = setup(t);
  const wc = h.newWC();
  assert.equal(keyOf(new LocalTabContents(wc)), wc);
  assert.equal(keyOf(wc), wc);
  const own = backendOf(h);
  assert.equal(keyOf(own), own);
  assert.equal(keyOf(null), null);
});

test('download state is one page whether the session names the webContents or the tool layer its backend', async (t) => {
  const h = setup(t);
  const wc = h.newWC();
  const backend = new LocalTabContents(wc);
  noteDownload(wc, ['https://a.test/f.zip']);
  assert.equal(wasDownload(backend, 'https://a.test/f.zip'), true);
  assert.equal(wasDownload(h.newWC(), 'https://a.test/f.zip'), false, 'another page');
  const other = h.newWC();
  const waiting = becameDownload(new LocalTabContents(other), 'https://a.test/g.zip', 'net::ERR_ABORTED', 1000);
  noteDownload(other, ['https://a.test/g.zip']);
  assert.equal(await waiting, true, 'a download noted on the webContents wakes the backend waiting for it');
});

test('layers and the tab lookup follow the page across a webContents and its backend', (t) => {
  const h = setup(t);
  const wc = h.newWC();
  const tab = tabOf(h, 'tab_aaaaaa', 'c', wc, null);
  assert.equal(h.tabs.layer(wc, 'front', h.owner), true);
  assert.equal(tab.layer, 'front');
  assert.equal(h.tabs.layers.get(tab.backend.identity), 'front');
  assert.equal(isViewTab(tab.backend), false);
  // a fake backend tab is keyed by itself
  const own = backendOf(h);
  const remote = tabOf(h, 'tab_bbbbbb', 'c', own, null);
  assert.equal(remote.layer, null);
  assert.equal(h.tabs.layers.has(own), false);
});

test('LocalTabContents forwards listener removal, emit and main-frame loading, and tolerates a page without zoom or crash state', (t) => {
  const h = setup(t);
  const wc = h.newWC();
  const backend = new LocalTabContents(wc);
  const seen: any[] = [];
  const listener = (v: any) => seen.push(v);
  assert.equal(backend.on('custom', listener), backend);
  assert.equal(backend.emit('custom', 1), true);
  assert.equal(backend.removeListener('custom', listener), backend);
  backend.emit('custom', 2);
  assert.deepEqual(seen, [1]);
  wc.isLoadingMainFrame = () => true;
  assert.equal(backend.isLoadingMainFrame(), true);
  delete wc.isCrashed;
  delete wc.getZoomFactor;
  assert.equal(backend.isCrashed(), false);
  assert.equal(backend.getZoomFactor(), undefined);
  wc.isCrashed = () => true;
  assert.equal(backend.isCrashed(), true);
});
