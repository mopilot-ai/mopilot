// electron/main.cjs: the saved zoom on every app window from its first page, a zoom from any window on all of them,
// Windows' caption buttons as tall as the zoomed title bar, and the old font size shortcuts' size moved to the zoom.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';
import { windowButtonsAt, zoomFactorOf } from '../shared/zoom.mjs';

after(() => unloadMain());
const chats = (h: any) => h.mod('platform/chats.cjs');
/** A saved prefs change, from any window or main itself (electron/platform/chats.cjs registerChats onPrefs). */
const prefsSaved = (h: any, prefs: any) => chats(h).registerChats.mock.calls[0].arguments[1].onPrefs(prefs);
/** What main wrote to the saved prefs (patchPrefs' set, by call). */
const patched = (h: any) => chats(h).patchPrefs.mock.calls.map((c: any) => c.arguments[1]);

test('macOS: windows open at the saved zoom, and a zoom from any window reaches every one, Quick Chat too', async () => {
  const h = await loadMain({ platform: 'darwin', state: { prefs: { zoomLevel: 1, welcomeDone: true } } });
  await h.ready();
  const win = h.windows[0];
  assert.deepEqual(win.opts.trafficLightPosition, windowButtonsAt({ x: 17, y: 16 }, zoomFactorOf(1)));
  win.webContents.emit('did-navigate');
  assert.equal(win.webContents.zoomLevel, 1, 'from its first page');
  await h.invoke('window:open');
  await h.invoke('window:mini');
  const quick = h.windows.at(-1);
  quick.webContents.emit('did-navigate');
  assert.equal(quick.webContents.zoomLevel, 1);
  assert.equal(h.windows.length, 3);
  prefsSaved(h, { zoomLevel: 2 });
  for (const w of h.windows) assert.equal(w.webContents.zoomLevel, 2);
  assert.deepEqual(win.buttons, windowButtonsAt({ x: 17, y: 16 }, zoomFactorOf(2)));
  assert.equal(quick.buttons, null, 'Quick Chat has no window buttons');
  // another pref leaves the zoom as it is
  win.webContents.zoomLevel = 7;
  prefsSaved(h, { zoomLevel: 2, theme: 'dark' });
  assert.equal(win.webContents.zoomLevel, 7);
});

test('Windows: the caption buttons start, and stay, as tall as the zoomed title bar', async () => {
  const h = await loadMain({ platform: 'win32', state: { prefs: { zoomLevel: -1, welcomeDone: true } } });
  await h.ready();
  const win = h.windows[0];
  assert.equal(win.opts.titleBarOverlay.height, Math.round(44 / 1.2));
  prefsSaved(h, { zoomLevel: 1 });
  assert.deepEqual(win.overlay, { height: 53 });
  assert.equal(win.buttons, null);
  // the theme's colors come at the window's own zoom
  await h.invokeFrom(win.webContents, 'window:titleBarOverlay', '#111', '#eee');
  assert.deepEqual(win.overlay, { color: '#111', symbolColor: '#eee', height: 53 });
});

test('a chat font size the old shortcuts left is the zoom from the first window on, and is saved as one', async () => {
  const h = await loadMain({ platform: 'darwin', state: { prefs: { fontSize: 17, welcomeDone: true } } });
  await h.ready();
  const win = h.windows[0];
  win.webContents.emit('did-navigate');
  assert.equal(win.webContents.zoomLevel, 1);
  assert.deepEqual(patched(h), [{ zoomLevel: 1, fontSize: 14 }]);
});

test('a chat font size Settings offers stays as it is, at Actual Size', async () => {
  const h = await loadMain({ platform: 'darwin', state: { prefs: { fontSize: 16, welcomeDone: true } } });
  await h.ready();
  assert.deepEqual(patched(h), []);
  h.windows[0].webContents.emit('did-navigate');
  assert.equal(h.windows[0].webContents.zoomLevel, 0);
});

test('a failed move of the old font size leaves startup going', async () => {
  const h = await loadMain({
    platform: 'darwin',
    state: { prefs: { fontSize: 11, welcomeDone: true } },
    before: (h) =>
      h.mod('platform/chats.cjs').patchPrefs.mock.mockImplementation(() => {
        throw new Error('disk full');
      }),
  });
  await h.ready();
  assert.equal(patched(h).length, 1);
  h.windows[0].webContents.emit('did-navigate');
  assert.equal(h.windows[0].webContents.zoomLevel, -1.5, 'main zooms as the old size asked');
});

test('Linux: the page zooms; no window buttons or caption overlay are placed', async () => {
  const h = await loadMain({ platform: 'linux', state: { prefs: { zoomLevel: 1, welcomeDone: true } } });
  await h.ready();
  const win = h.windows[0];
  win.webContents.emit('did-navigate');
  assert.equal(win.webContents.zoomLevel, 1);
  prefsSaved(h, { zoomLevel: 2 });
  assert.equal(win.webContents.zoomLevel, 2);
  assert.deepEqual([win.buttons, win.overlay], [null, null]);
});
