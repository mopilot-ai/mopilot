// A pane tab's page zoom (electron/capabilities/browser/pageZoom.cjs): the fit to the pane's width, the user's per-site
// zoom, 100% under an explicit viewport, the views that apply it and screenshots of a zoomed page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FakeWC, setup as viewSetup } from './support/browser-view-fixture.ts';
import { drive, image, mapping, setup, tabOf, toFrame } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const {
  AUTO_LAYOUT,
  AUTO_MIN,
  STEPS,
  autoZoom,
  stepZoom,
  hostOf,
  holdNativeScale,
  PageZoom,
} = require('../electron/capabilities/browser/pageZoom.cjs');

const page = (url: string, zoom = 1) => Object.assign(new FakeWC(), { url, zoom });
const events = (sender: any) => sender.sent.filter(([c]: any) => c === 'browser:viewEvent').map(([, p]: any) => [p.type, p.state?.zoom]);

test('autoZoom: a desktop layout scaled to the pane, 100% at AUTO_LAYOUT and wider, never below the readable floor', () => {
  assert.equal(AUTO_LAYOUT, 1000);
  assert.equal(autoZoom(1000), 1);
  assert.equal(autoZoom(1600), 1);
  assert.equal(autoZoom(860), 0.86);
  assert.equal(autoZoom(803.4), 0.8, 'in 1% steps');
  assert.equal(autoZoom(670), AUTO_MIN);
  assert.equal(autoZoom(400), AUTO_MIN, 'a narrow pane gets the site’s own narrow layout, not tiny text');
  for (const bad of [0, -5, Number.NaN, undefined, '700']) assert.equal(autoZoom(bad), 1);
});

test("stepZoom: Chrome's steps from any zoom, stopping at the ends", () => {
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(0.7, 1), 0.75, 'from a fitted zoom to the next step');
  assert.equal(stepZoom(0.7, -1), 0.67);
  assert.equal(stepZoom(STEPS.at(-1), 1), STEPS.at(-1));
  assert.equal(stepZoom(STEPS[0], -1), STEPS[0]);
});

test('hostOf: the site a zoom is kept for; none for a page without a host or a bad address', () => {
  assert.equal(hostOf(page('https://www.booking.com/searchresults.html')), 'www.booking.com');
  assert.equal(hostOf(page('http://localhost:5173/a')), 'localhost:5173');
  assert.equal(hostOf(page('about:blank')), null);
  assert.equal(hostOf(page('')), null);
});

test('PageZoom: the fit, a site the user zoomed, 100% while an explicit viewport is held, and only real changes applied', () => {
  const refits: any[] = [];
  const z = new PageZoom({ onRefit: (wc: any) => refits.push(wc) });
  const a = page('https://a.test/x');
  const b = page('https://a.test/y');
  const blank = page('about:blank');
  assert.equal(z.zoomFor(a, 700), 0.7);
  assert.equal(z.isAuto(a), true);
  assert.equal(z.apply(a, 700), true);
  assert.equal(a.zoom, 0.7);
  assert.equal(z.apply(a, 700), false, 'unchanged: nothing sent');
  assert.deepEqual(a.calls, [['zoom', 0.7]]);
  // the user's zoom is per site
  assert.equal(z.step(a, 700, 'in'), true);
  assert.equal(z.zoomFor(b, 1400), 0.75);
  assert.equal(z.isAuto(b), false);
  z.step(a, 700, 'in');
  assert.equal(z.zoomFor(a, 700), 0.8);
  z.step(a, 700, 'out');
  assert.equal(z.zoomFor(a, 700), 0.75);
  z.step(a, 700, 'reset');
  assert.equal(z.isAuto(a), true);
  assert.equal(z.zoomFor(a, 700), 0.7);
  assert.equal(z.step(blank, 700, 'in'), false, 'a page with no site keeps the fit');
  assert.equal(z.isAuto(blank), true);
  // an explicit viewport: 100%, no user zoom, told to the views
  holdNativeScale(a, true);
  holdNativeScale(a, true);
  assert.deepEqual(refits, [a], 'a repeat changes nothing');
  assert.equal(z.zoomFor(a, 700), 1);
  assert.equal(z.isAuto(a), false);
  assert.equal(z.step(a, 700, 'in'), false);
  holdNativeScale(a, false);
  assert.deepEqual(refits, [a, a]);
  assert.equal(z.zoomFor(a, 700), 0.7);
  holdNativeScale(null, true);
  holdNativeScale('wc', true);
  assert.equal(refits.length, 2);
  // a page that went is left alone
  const gone = page('https://a.test/');
  gone.destroyed = true;
  assert.equal(z.apply(gone, 700), false);
  assert.equal(z.apply(null, 700), false);
  z.dispose();
  holdNativeScale(b, true);
  holdNativeScale(b, false);
  assert.equal(refits.length, 2, 'disposed: no longer told');
  new PageZoom().dispose();
});

test('views: the zoom follows the width a pane shows the page at, and a navigation puts it back (Chromium keeps one per host)', () => {
  const { views, sender } = viewSetup();
  const { id } = views.bind('p1', sender, { url: 'https://a.test/' });
  const e = views.entryOf(id);
  assert.equal(e.wc.zoom, 1, 'never shown: the parked width (1280) fits at 100%');
  // the window zooms 1.25: a 560 CSS px pane is 700 DIPs wide
  views.show(id, sender, { x: 0, y: 0, width: 560, height: 400 });
  assert.equal(e.wc.zoom, 0.7);
  views.show(id, sender, { x: 0, y: 0, width: 640, height: 400 });
  assert.equal(e.wc.zoom, 0.8);
  views.show(id, sender, { x: 0, y: 0, width: 640, height: 300 });
  assert.deepEqual(events(sender), [
    ['zoom-changed', 0.7],
    ['zoom-changed', 0.8],
  ]);
  // a navigation to a host whose zoom Chromium kept elsewhere is put back first
  e.wc.zoom = 1;
  e.wc.emit('did-navigate');
  assert.equal(e.wc.zoom, 0.8);
  assert.deepEqual(events(sender).at(-1), ['did-navigate', 0.8]);
  // parked: its navigation leaves the host's zoom to the page a pane shows; showing it again refits it
  views.show(id, sender, null);
  e.wc.zoom = 0.75;
  e.wc.emit('did-navigate');
  assert.equal(e.wc.zoom, 0.75);
  views.show(id, sender, { x: 0, y: 0, width: 640, height: 300 });
  assert.equal(e.wc.zoom, 0.8);
  // a view that went is not refitted
  e.wc.close();
  e.wc.zoom = 1;
  e.wc.emit('did-navigate');
  assert.equal(e.wc.zoom, 1);
});

test('views: Zoom In, Zoom Out and Actual Size are per site, reach its other views, and the pane hears of each', async () => {
  const { views, sender } = viewSetup();
  const a = views.entryOf(views.bind('p1', sender, { url: 'https://a.test/1' }).id);
  const b = views.entryOf(views.bind('p2', sender, { url: 'https://a.test/2' }).id);
  const c = views.entryOf(views.bind('p3', sender, { url: 'https://c.test/' }).id);
  for (const e of [a, b, c]) views.show(e.id, sender, { x: 0, y: 0, width: 560, height: 400 });
  sender.sent.length = 0;
  await views.nav(a.id, sender, 'zoom-in');
  assert.deepEqual([a.wc.zoom, b.wc.zoom, c.wc.zoom], [0.75, 0.75, 0.7]);
  assert.equal(views.state(a).zoomAuto, false);
  assert.equal(views.state(c).zoomAuto, true);
  await views.nav(a.id, sender, 'zoom-out');
  await views.nav(a.id, sender, 'zoom-out');
  assert.equal(a.wc.zoom, 0.5);
  await views.nav(a.id, sender, 'zoom-reset');
  assert.deepEqual([a.wc.zoom, b.wc.zoom], [0.7, 0.7]);
  assert.equal(views.state(a).zoomAuto, true);
  const told = events(sender).filter(([t]: any) => t === 'zoom-changed');
  assert.ok(told.length >= 4);
  // a page with no site: nothing to zoom, nothing told
  const blank = views.entryOf(views.bind('p4', sender, { url: 'about:blank' }).id);
  sender.sent.length = 0;
  await views.nav(blank.id, sender, 'zoom-in');
  assert.deepEqual(events(sender), []);
  // a gone view of the site is skipped
  b.wc.destroyed = true;
  await views.nav(a.id, sender, 'zoom-in');
  assert.equal(a.wc.zoom, 0.75);
  views.shutdown();
});

test('views: an explicit viewport holds the page at 100% and gives it back its fit; other pages are not views', () => {
  const { views, sender } = viewSetup();
  const e = views.entryOf(views.bind('p1', sender, { url: 'https://a.test/' }).id);
  views.show(e.id, sender, { x: 0, y: 0, width: 560, height: 400 });
  holdNativeScale(e.wc, true);
  assert.equal(e.wc.zoom, 1);
  holdNativeScale(e.wc, false);
  assert.equal(e.wc.zoom, 0.7);
  holdNativeScale(new FakeWC(), true);
  views.shutdown();
});

test('capture: a zoomed page’s region is taken in DIPs (capturePage and CDP clip), and so is the full page', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const rects: any[] = [];
  tab.wc.getZoomFactor = () => 0.5;
  tab.wc.captureImpl = (rect: any) => (rects.push(rect), image({ src: 'capturePage' }));
  const st = { w: 1600, h: 1200, dpr: 1, sx: 0, sy: 10 };
  const shot = await drive(t, h.tabs.capture(tab, st, { region: [100, 100, 300, 200] }));
  assert.deepEqual(shot.rect, { x: 100, y: 100, width: 200, height: 100 }, 'the model’s frame stays in CSS pixels');
  assert.deepEqual(rects, [{ x: 50, y: 50, width: 100, height: 50 }]);
  // capturePage failing: CDP's clip in DIPs too
  tab.wc.handlers['Page.captureScreenshot'] = () => ({ data: Buffer.from('png').toString('base64') });
  tab.wc.captureImpl = () => {
    throw new Error('hidden');
  };
  await drive(t, h.tabs.capture(tab, st, { region: [100, 100, 300, 200] }));
  assert.deepEqual(tab.wc.debugger.sent('Page.captureScreenshot').at(-1).params.clip, { x: 50, y: 55, width: 100, height: 50, scale: 1 });
  tab.wc.handlers['Page.getLayoutMetrics'] = () => ({ cssContentSize: { width: 2000, height: 3000 } });
  const full = await drive(t, h.tabs.captureFull(tab));
  assert.deepEqual(tab.wc.debugger.sent('Page.captureScreenshot').at(-1).params.clip, { x: 0, y: 0, width: 1000, height: 1500, scale: 1 });
  assert.deepEqual(full.frame, { w: 2000, h: 3000 });
  // the model's click on what it saw lands on that CSS point (input takes CSS pixels at any zoom)
  tab.wc.captureImpl = () => image({ src: 'capturePage' });
  const view = await drive(t, h.tabs.capture(tab, st));
  assert.deepEqual(view.frame, { w: 1600, h: 1200 }, 'framed in CSS pixels, not the DIP capture');
  const [x, y] = toFrame(mapping(view, st), [view.width / 2, view.height / 2]);
  await drive(t, h.tabs.click(tab, await h.tabs.point(tab, st, { coordinate: [x, y] })));
  const pressed = tab.wc.debugger.sent('Input.dispatchMouseEvent').find((c: any) => c.params.type === 'mousePressed');
  assert.deepEqual([pressed.params.x, pressed.params.y], [800, 600]);
  // an unknown zoom is 1
  tab.wc.getZoomFactor = () => Number.NaN;
  tab.wc.captureImpl = (rect: any) => (rects.push(rect), image({ src: 'capturePage' }));
  await drive(t, h.tabs.capture(tab, st, { region: [100, 100, 300, 200] }));
  assert.deepEqual(rects.at(-1), { x: 100, y: 100, width: 200, height: 100 });
});

test('resize: a device holds the page at 100% until desktop or the CDP session ends it', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const z = new PageZoom();
  tab.wc.getURL = () => 'https://a.test/';
  await drive(t, tab.attach());
  await drive(t, h.tabs.resize(tab, { width: 1280, height: 800 }));
  assert.equal(z.zoomFor(tab.wc, 700), 1, 'Chromium would divide a desktop override by the zoom');
  await drive(t, h.tabs.resize(tab, { preset: 'desktop' }));
  assert.equal(z.zoomFor(tab.wc, 700), 0.7);
  await drive(t, h.tabs.resize(tab, { preset: 'mobile' }));
  assert.equal(z.zoomFor(tab.wc, 700), 1);
  tab.detach();
  assert.equal(z.zoomFor(tab.wc, 700), 0.7);
  z.dispose();
});

test('the plugin viewport: held at 100% while on, given back when its send fails, and when the turn forgets it', async () => {
  const { sizeTab, unsizeTab, forgetViewport } = require('../electron/capabilities/browser/iabBackend/viewport.cjs');
  const z = new PageZoom();
  const tab = (over: any = {}) => ({
    wc: page('https://a.test/'),
    get backend() {
      return this.wc;
    },
    emulated: null,
    closed: false,
    rendererGone: () => false,
    send: async () => {},
    ...over,
  });
  const b: any = { viewport: { width: 1280, height: 800 }, sized: new Set() };
  const ok = tab();
  await sizeTab(b, ok);
  assert.equal(z.zoomFor(ok.wc, 700), 1);
  const failing = tab({ send: () => Promise.reject(new Error('renderer gone')) });
  await assert.rejects(sizeTab(b, failing), /renderer gone/);
  assert.equal(z.zoomFor(failing.wc, 700), 0.7, 'no override went on');
  assert.equal(b.sized.has(failing), false);
  await unsizeTab(b, ok);
  assert.equal(z.zoomFor(ok.wc, 700), 0.7);
  // the turn ends: tabs it sized are given back, except one whose device the user picked
  const device = tab();
  await sizeTab(b, ok);
  await sizeTab(b, device);
  device.emulated = { preset: 'mobile' };
  forgetViewport(b);
  assert.deepEqual([z.zoomFor(ok.wc, 700), z.zoomFor(device.wc, 700), b.sized.size, b.viewport], [0.7, 1, 0, null]);
  z.dispose();
});
