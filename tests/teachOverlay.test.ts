// electron/capabilities/teachOverlay.cjs: where the teach tooltip goes, what its page says, and how its window answers a click.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  TeachOverlay,
  placeTooltip,
  tooltipHtml,
  NEXT_URL,
  EXIT_URL,
  WIDTH,
  PAD,
  FALLBACK_HEIGHT,
} = require('../electron/capabilities/teachOverlay.cjs');

const D = { x: 0, y: 0, width: 1000, height: 800 };
const SIZE = { w: 340, h: 150 };

test('placeTooltip: below the anchor when it fits, else above, right, left; centered with no anchor', () => {
  assert.deepEqual(placeTooltip(null, D, SIZE), { left: 330, top: 325, side: 'none', arrow: 0 });
  assert.deepEqual(placeTooltip({ x: 500, y: 100 }, D, SIZE), { left: 330, top: 116, side: 'below', arrow: 170 });
  assert.deepEqual(placeTooltip({ x: 500, y: 700 }, D, SIZE), { left: 330, top: 534, side: 'above', arrow: 170 });
  // neither below nor above fits: to the right, then the left
  const tall = { x: 0, y: 0, width: 1000, height: 200 };
  assert.deepEqual(placeTooltip({ x: 100, y: 100 }, tall, SIZE), { left: 116, top: 25, side: 'right', arrow: 75 });
  assert.deepEqual(placeTooltip({ x: 900, y: 100 }, tall, SIZE), { left: 544, top: 25, side: 'left', arrow: 75 });
  // none fits: below is the least bad
  const tiny = { x: 0, y: 0, width: 300, height: 100 };
  assert.equal(placeTooltip({ x: 150, y: 50 }, tiny, SIZE).side, 'below');
  // clamped to the edges, with the arrow sliding to still point at the anchor
  const edge = placeTooltip({ x: 5, y: 100 }, D, SIZE);
  assert.equal(edge.left, 20);
  assert.equal(edge.arrow, 16);
  const far = placeTooltip({ x: 995, y: 100 }, D, SIZE);
  assert.equal(far.left, 640);
  assert.equal(far.arrow, 324);
  // a second display's origin is honored
  assert.equal(placeTooltip({ x: 2500, y: 100 }, { x: 2000, y: 0, width: 1000, height: 800 }, SIZE).left, 2330);
});

test('tooltipHtml: the words are escaped; Next and Exit are links; working swaps them for the Esc hint', () => {
  const html = tooltipHtml({ explanation: 'Click <b>"Send"</b> & wait', nextPreview: "Next: I'll click" }, { side: 'below', arrow: 40 });
  assert.match(html, /Click &lt;b&gt;&quot;Send&quot;&lt;\/b&gt; &amp; wait/);
  assert.match(html, new RegExp(`id="exit" href="${EXIT_URL}"`));
  assert.match(html, new RegExp(`id="next" href="${NEXT_URL}"`));
  assert.match(html, /id="arrow" class="below" style="--at:40px"/);
  assert.match(html, /default-src 'none'/);
  const working = tooltipHtml({ explanation: 'x', nextPreview: '' }, { working: true });
  assert.match(working, /Working…/);
  assert.match(working, /Esc to stop/);
  assert.doesNotMatch(working, /id="next"/);
  assert.doesNotMatch(working, /id="preview"/);
  assert.doesNotMatch(working, /id="arrow"/);
  assert.doesNotMatch(tooltipHtml({ explanation: 'x', nextPreview: 'y' }), /id="arrow"/);
  assert.match(tooltipHtml({ explanation: 'x', nextPreview: 'y' }, { side: 'left' }), /style="--at:0px"/);
});

/** Electron's modules as far as the overlay uses them. */
function fakeElectron(o: { height?: any; loadFails?: boolean } = {}) {
  const log: any[] = [];
  let nav: any = null;
  const win: any = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    setAlwaysOnTop: (...a: any[]) => log.push(['top', ...a]),
    setVisibleOnAllWorkspaces: (...a: any[]) => log.push(['spaces', ...a]),
    setContentProtection: (v: boolean) => log.push(['protect', v]),
    setIgnoreMouseEvents: (v: boolean) => log.push(['ignore', v]),
    setBounds: (b: any) => log.push(['bounds', b]),
    showInactive: () => log.push(['show']),
    hide: () => log.push(['hide']),
    destroy: () => {
      win.destroyed = true;
      log.push(['destroy']);
    },
    loadURL: async (u: string) => {
      log.push(['load', decodeURIComponent(u.replace('data:text/html;charset=utf-8,', ''))]);
      if (o.loadFails) throw new Error('load failed');
    },
    webContents: {
      on: (_e: string, f: any) => (nav = f),
      setWindowOpenHandler: (f: any) => log.push(['open', f().action]),
      executeJavaScript: async () => {
        if (o.height instanceof Error) throw o.height;
        return o.height ?? 120;
      },
    },
  };
  const made: any[] = [];
  const electron = {
    BrowserWindow: class {
      constructor(opts: any) {
        made.push(opts);
        return win;
      }
    },
    screen: {
      getDisplayNearestPoint: (p: any) => ({ workArea: p.x >= 1000 ? { x: 1000, y: 0, width: 800, height: 600 } : D }),
      getPrimaryDisplay: () => ({ bounds: D }),
    },
  };
  const click = (url: string) => {
    let prevented = false;
    nav({ preventDefault: () => (prevented = true) }, url);
    return prevented;
  };
  return { electron, win, log, made, click };
}

const notes: string[] = [];
const note = (what: string) => notes.push(what);
const tick = () => new Promise((r) => setTimeout(r, 0));
const logOf = (log: any[], k: string) => log.filter((l) => l[0] === k);
const STEP = { explanation: 'Look here', nextPreview: 'Next: click', anchor: { x: 500, y: 100 } };

test('TeachOverlay: shows the tooltip placed from the measured page, and Next answers the waiting step', async () => {
  const f = fakeElectron({ height: 120.4 });
  const o = new TeachOverlay({ electron: f.electron, note });
  assert.equal(o.available, true);
  assert.deepEqual(o.windows(), []);
  const choice = o.show('c1', STEP);
  await tick();
  await tick();
  const [bounds] = logOf(f.log, 'bounds').slice(-1);
  assert.deepEqual(bounds[1], { x: 330 - PAD, y: 116 - PAD, width: WIDTH + PAD * 2, height: 121 + PAD * 2 });
  assert.equal(logOf(f.log, 'show').length, 1);
  assert.deepEqual(logOf(f.log, 'ignore')[0], ['ignore', false], 'a person can click it while a step waits');
  assert.equal(f.made[0].focusable, false);
  assert.deepEqual(logOf(f.log, 'protect'), [['protect', true]]);
  assert.deepEqual(logOf(f.log, 'open'), [['open', 'deny']]);
  assert.equal(o.windows().length, 1);
  assert.equal(f.click('https://elsewhere.invalid/x'), true, 'any other navigation is cancelled and ignored');
  assert.equal(f.click(NEXT_URL), true);
  assert.equal(await choice, 'next');
  // Working: click-through, with the Working page
  o.working('c1');
  assert.deepEqual(logOf(f.log, 'ignore').slice(-1)[0], ['ignore', true]);
  assert.match(logOf(f.log, 'load').slice(-1)[0][1], /Working…/);
  // another chat's working is ignored
  const before = f.log.length;
  o.working('c2');
  assert.equal(f.log.length, before);
  // hide, then the same window is reused for the next tour
  o.hide('c2');
  assert.equal(logOf(f.log, 'hide').length, 0);
  o.hide('c1');
  assert.equal(logOf(f.log, 'hide').length, 1);
  const again = o.show('c1', { ...STEP, anchor: null });
  await tick();
  await tick();
  f.click(EXIT_URL);
  assert.equal(await again, 'exit');
  assert.equal(f.made.length, 1, 'one window');
});

test('TeachOverlay: a later step replaces the one waiting; a hide or dispose cancels it', async () => {
  const f = fakeElectron();
  const o = new TeachOverlay({ electron: f.electron, note });
  const first = o.show('c1', STEP);
  const second = o.show('c1', { ...STEP, anchor: { x: 1200, y: 100 } });
  assert.equal(await first, 'cancel');
  await tick();
  await tick();
  assert.deepEqual(logOf(f.log, 'bounds').slice(-1)[0][1].x, 1200 - 170 - PAD, 'the other display is used');
  o.hide('c1');
  assert.equal(await second, 'cancel');
  const third = o.show('c1', { ...STEP, anchor: null, near: { x: 1100, y: 10 } });
  o.dispose();
  assert.equal(await third, 'cancel');
  assert.equal(f.win.destroyed, true);
  assert.deepEqual(o.windows(), []);
  o.dispose();
  o.hide('c1');
  o.working('c1');
});

test('TeachOverlay: a page that cannot be measured uses the fixed height; a step replaced mid-load is not placed', async () => {
  const f = fakeElectron({ height: new Error('no script') });
  const o = new TeachOverlay({ electron: f.electron, note });
  const a = o.show('c1', STEP);
  await tick();
  await tick();
  assert.equal(logOf(f.log, 'bounds').slice(-1)[0][1].height, FALLBACK_HEIGHT + PAD * 2);
  f.click(NEXT_URL);
  await a;
  const odd = fakeElectron({ height: 0 });
  const p = new TeachOverlay({ electron: odd.electron, note });
  void p.show('c1', STEP);
  await tick();
  await tick();
  assert.equal(logOf(odd.log, 'bounds').slice(-1)[0][1].height, FALLBACK_HEIGHT + PAD * 2);
  // replaced while measuring: only the new step is shown
  const g = fakeElectron();
  const q = new TeachOverlay({ electron: g.electron, note });
  const old = q.show('c1', STEP);
  const fresh = q.show('c1', { ...STEP, explanation: 'New' });
  assert.equal(await old, 'cancel');
  await tick();
  await tick();
  await tick();
  assert.equal(logOf(g.log, 'show').length, 1);
  assert.match(logOf(g.log, 'load').slice(-1)[0][1], /New/);
  f.win.destroyed = false;
  q.hide('c1');
  assert.equal(await fresh, 'cancel');
});

test('TeachOverlay: a window that cannot load cancels the step; failures hiding, closing or switching clicks are survived', async () => {
  const f = fakeElectron({ loadFails: true });
  const o = new TeachOverlay({ electron: f.electron, note });
  assert.equal(await o.show('c1', STEP), 'cancel');
  o.working('c1');
  await tick();
  // a destroyed window is not touched, and one that throws is survived
  const g = fakeElectron();
  const p = new TeachOverlay({ electron: g.electron, note });
  const shown = p.show('c1', STEP);
  await tick();
  await tick();
  g.click(NEXT_URL);
  await shown;
  g.win.hide = () => {
    throw new Error('gone');
  };
  g.win.setIgnoreMouseEvents = () => {
    throw new Error('gone');
  };
  g.win.destroy = () => {
    throw new Error('gone');
  };
  p.working('c1');
  p.hide('c1');
  p.dispose();
  const h = fakeElectron();
  const q = new TeachOverlay({ electron: h.electron, note });
  const second = q.show('c1', STEP);
  await tick();
  await tick();
  h.win.destroyed = true;
  q.working('c1');
  q.hide('c1');
  assert.equal(await second, 'cancel');
  for (const what of [
    'measure the teach tooltip',
    'show the teach tooltip',
    'show the teach tooltip as working',
    'hide the teach tooltip',
    'close the teach tooltip',
    'set whether the teach tooltip takes clicks',
  ])
    assert.ok(notes.includes(what), `noted: ${what}`);
});

test('TeachOverlay: without Electron it is unavailable', () => {
  assert.equal(new TeachOverlay({ electron: null, note }).available, false);
  assert.equal(new TeachOverlay({ electron: { BrowserWindow: class {}, screen: null }, note }).available, false);
});

test('TeachOverlay: a step replaced while its first page loads is not measured or shown', async () => {
  const f = fakeElectron();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const load = f.win.loadURL;
  let first = true;
  f.win.loadURL = async (u: string) => {
    await load(u);
    if (first) {
      first = false;
      await gate;
    }
  };
  const o = new TeachOverlay({ electron: f.electron, note });
  const old = o.show('c1', STEP);
  await tick();
  const fresh = o.show('c1', { ...STEP, explanation: 'Newer' });
  assert.equal(await old, 'cancel');
  release();
  await tick();
  await tick();
  await tick();
  assert.equal(logOf(f.log, 'show').length, 1, 'only the newer step is shown');
  f.click(NEXT_URL);
  assert.equal(await fresh, 'next');
});

test('TeachOverlay: a step replaced while it is measured, or while its placed page loads, is not shown', async () => {
  for (const slow of ['measure', 'second load'] as const) {
    const f = fakeElectron();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    if (slow === 'measure') f.win.webContents.executeJavaScript = async () => (await gate, 120);
    else {
      const load = f.win.loadURL;
      let n = 0;
      f.win.loadURL = async (u: string) => {
        await load(u);
        if (++n === 2) await gate;
      };
    }
    const o = new TeachOverlay({ electron: f.electron, note });
    const old = o.show('c1', STEP);
    await tick();
    await tick();
    const fresh = o.show('c1', { ...STEP, explanation: 'Newer' });
    assert.equal(await old, 'cancel');
    release();
    await tick();
    await tick();
    await tick();
    f.click(NEXT_URL);
    assert.equal(await fresh, 'next');
    assert.equal(logOf(f.log, 'show').length, 1, `${slow}: only the newer step is shown`);
  }
});
