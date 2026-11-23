// App zoom: the step model (shared/zoom.mjs) and main's zoom of every app window with its title bar buttons (electron/app/zoom.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import {
  CHAT_FONT_SIZES,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  legacyZoomPatch,
  normalizeZoomLevel,
  titleBarHeightAt,
  windowButtonsAt,
  zoomFactorOf,
  zoomLevelOf,
  zoomStep,
} from '../shared/zoom.mjs';

const require = createRequire(import.meta.url);
const { createZoom, WINDOW_BUTTONS, TITLE_BAR_HEIGHT } = require('../electron/app/zoom.cjs');

test('a step is half a zoom level, as Claude Desktop zooms, snapped to that grid and kept within the limits', () => {
  assert.equal(zoomStep(0, 1), 0.5);
  assert.equal(zoomStep(0.5, -1), 0);
  assert.equal(zoomStep(3, 0), 0, 'Actual Size');
  // an off-grid level (a hand-edited file) lands on the grid first
  assert.equal(zoomStep(0.3, 1), 1);
  assert.equal(zoomStep(MAX_ZOOM_LEVEL, 1), MAX_ZOOM_LEVEL);
  assert.equal(zoomStep(MIN_ZOOM_LEVEL, -1), MIN_ZOOM_LEVEL);
  assert.equal(zoomStep('x', 2), 0.5, 'any positive direction is one step');
  let level = 0;
  for (let i = 0; i < 40; i++) level = zoomStep(level, -1);
  assert.equal(level, MIN_ZOOM_LEVEL);
  assert.ok(zoomFactorOf(MIN_ZOOM_LEVEL) > 0.5 && zoomFactorOf(MAX_ZOOM_LEVEL) < 3);
  assert.ok(Math.abs(zoomFactorOf(0.5) - 1.0954) < 1e-4, 'about 9.5% a step');
});

test('a saved level that is not a finite number is Actual Size; -0 is 0', () => {
  for (const v of [undefined, null, '1', Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(normalizeZoomLevel(v), 0);
  assert.ok(Object.is(normalizeZoomLevel(-0.1), 0));
  assert.equal(normalizeZoomLevel(99), MAX_ZOOM_LEVEL);
  assert.equal(normalizeZoomLevel(-99), MIN_ZOOM_LEVEL);
});

test('a chat font size the old shortcuts left (one Settings does not offer) becomes the nearest zoom level', () => {
  assert.deepEqual(legacyZoomPatch({ fontSize: 17 }), { zoomLevel: 1, fontSize: 14 });
  assert.deepEqual(legacyZoomPatch({ fontSize: 11 }), { zoomLevel: -1.5, fontSize: 14 });
  assert.deepEqual(legacyZoomPatch({ fontSize: 24 }), { zoomLevel: 3, fontSize: 14 });
  // a size Settings offers was the user's choice there, and stays the chat font size
  for (const fontSize of CHAT_FONT_SIZES) assert.equal(legacyZoomPatch({ fontSize }), null);
  // once moved (or zoomed since), the saved level stands
  assert.equal(legacyZoomPatch({ fontSize: 17, zoomLevel: 0 }), null);
  for (const prefs of [undefined, null, 'x', {}, { fontSize: '17' }, { fontSize: 0 }, { fontSize: Number.NaN }])
    assert.equal(legacyZoomPatch(prefs), null);
});

test('the level saved prefs ask for: their zoomLevel, or the one an old font size moves to', () => {
  assert.equal(zoomLevelOf({ zoomLevel: 2 }), 2);
  assert.equal(zoomLevelOf({ fontSize: 17 }), 1);
  assert.equal(zoomLevelOf({ fontSize: 16 }), 0);
  assert.equal(zoomLevelOf(undefined), 0);
  assert.equal(zoomLevelOf('x'), 0);
});

test("macOS's window buttons stay centered in the zoomed title bar; Windows' caption buttons are as tall as it", () => {
  assert.deepEqual(windowButtonsAt({ x: 17, y: 16 }, 1), { x: 17, y: 16 });
  // centers (23, 22) scale with the 44px title bar: at 1.5 it is 66pt tall, the buttons centered at 33
  assert.deepEqual(windowButtonsAt({ x: 17, y: 16 }, 1.5), { x: 29, y: 27 });
  assert.deepEqual(windowButtonsAt({ x: 0, y: 0 }, 0.5), { x: 0, y: 0 }, 'never off the window');
  assert.equal(titleBarHeightAt(44, 1.2), 53);
});

/** A fake app window: its page's zoom level and title bar buttons. */
function fakeWindow() {
  const wc: any = Object.assign(new EventEmitter(), {
    level: 0,
    sets: 0,
    getZoomLevel: () => wc.level,
    setZoomLevel: (l: number) => ((wc.level = l), wc.sets++),
  });
  const win: any = Object.assign(new EventEmitter(), {
    webContents: wc,
    destroyed: false,
    buttons: null as any,
    overlay: null as any,
    isDestroyed: () => win.destroyed,
    setWindowButtonPosition: (p: any) => (win.buttons = p),
    setTitleBarOverlay: (o: any) => (win.overlay = o),
  });
  return win;
}

test('main reads the saved level once, when the first window asks, and new windows start with buttons placed for it', () => {
  let reads = 0;
  const zoom = createZoom({ prefs: () => (reads++, { zoomLevel: 2 }) });
  assert.equal(reads, 0, 'not before a window opens (the profile folder may still change)');
  const at = zoom.chromeOptions();
  assert.deepEqual(at.trafficLightPosition, windowButtonsAt(WINDOW_BUTTONS, zoomFactorOf(2)));
  assert.equal(at.titleBarHeight, titleBarHeightAt(TITLE_BAR_HEIGHT, zoomFactorOf(2)));
  assert.equal(zoom.level, 2);
  assert.equal(reads, 1);
  assert.equal(zoom.titleBarHeight(1.5), 66);
});

test('every window follows a new level at once, each with its own title bar; a page that loads again gets it back', () => {
  const zoom = createZoom({ prefs: () => ({}) });
  const mac = fakeWindow();
  const win = fakeWindow();
  const quick = fakeWindow();
  zoom.attach(mac, 'buttons');
  zoom.attach(win, 'overlay');
  zoom.attach(quick, null);
  assert.equal(zoom.set(1), true);
  for (const w of [mac, win, quick]) assert.equal(w.webContents.level, 1);
  assert.deepEqual(mac.buttons, windowButtonsAt(WINDOW_BUTTONS, 1.2));
  assert.equal(mac.overlay, null);
  assert.deepEqual(win.overlay, { height: 53 });
  assert.equal(win.buttons, null);
  assert.equal(quick.buttons, null);
  assert.equal(quick.overlay, null, 'Quick Chat has no title bar buttons');
  // the same level again changes nothing
  assert.equal(zoom.set(1.1), false);
  // Chromium keeps zoom per page address: a reload or a route change can come back at another level
  mac.webContents.level = 0;
  mac.webContents.emit('did-navigate');
  assert.equal(mac.webContents.level, 1);
  win.webContents.level = 0;
  win.webContents.emit('did-navigate-in-page');
  assert.equal(win.webContents.level, 1);
  // a page already at the level is left alone
  const sets = quick.webContents.sets;
  quick.webContents.emit('did-navigate');
  assert.equal(quick.webContents.sets, sets);
  // a closed window is let go; one closing is skipped
  quick.emit('closed');
  win.destroyed = true;
  zoom.set(-1);
  assert.equal(quick.webContents.level, 1);
  assert.equal(win.webContents.level, 1);
  assert.equal(mac.webContents.level, -1);
});
