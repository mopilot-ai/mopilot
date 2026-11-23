// The browser host's screenshots (electron/capabilities/browser/host.cjs): sizing per model, regions, the CDP
// fallback, blank and transparent pages, full-page captures, the agent cursor and password masking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  FRAME_SCRIPT,
  BLACK_PAGE_SCRIPT,
  PAGE_BACKDROP,
  mapping,
  toFrame,
  image,
  flush,
  drive,
  setup,
  tabOf,
  recordingCursor,
} from './support/browser-host-kit.ts';

/* ------------------------------------------------------------------ */
/* screenshots                                                         */
/* ------------------------------------------------------------------ */

test('capture: a screenshot of the full viewport, at most 1568 px, JPEG; scale shrinks it', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const st = { w: 800, h: 600, dpr: 2, sx: 0, sy: 10 };
  const shot = await drive(t, h.tabs.capture(tab, st));
  const jpeg = JSON.parse(Buffer.from(shot.data, 'base64').toString());
  assert.deepEqual(jpeg, { q: 75, info: { src: 'capturePage' }, width: 800, height: 600, quality: 'good' });
  assert.deepEqual([shot.width, shot.height, shot.frame, shot.rect], [800, 600, { w: 800, h: 600 }, null]);
  const big = await drive(t, h.tabs.capture(tab, { w: 3136, h: 1000, dpr: 1, sx: 0, sy: 0 }));
  assert.deepEqual([big.width, big.height], [1568, 500]);
  const half = await drive(t, h.tabs.capture(tab, st, { scale: 0.5 }));
  assert.deepEqual([half.width, half.height], [400, 300]);
  const tiny = await drive(t, h.tabs.capture(tab, st, { scale: 0.01 }));
  assert.deepEqual([tiny.width, tiny.height], [80, 60], 'scale is at least 0.1');
  const bad = await drive(t, h.tabs.capture(tab, st, { scale: 'x' }));
  assert.equal(bad.width, 800, 'a bad scale is 1');
});

test("capture: sized for the chat's model (IAB-07): 2000 px for high-resolution models, else 1568 px; unknown is the default", async (t) => {
  const models: Record<string, any> = { hi: 'claude-opus-4-7', old: 'claude-sonnet-4-5', alias: async () => 'fable', none: null };
  const asked: string[] = [];
  const h = setup(t, {
    modelOf: (chatId: string) => {
      asked.push(chatId);
      if (chatId === 'boom') throw new Error('no such chat');
      const m = models[chatId];
      return typeof m === 'function' ? m() : m;
    },
  });
  const wide = { w: 3136, h: 1000, dpr: 1, sx: 0, sy: 0 };
  const size = async (chatId: string, st: any = wide, opts: any = {}) => {
    const shot = await drive(t, h.tabs.capture(tabOf(h, null, chatId), st, opts));
    return [shot.width, shot.height];
  };
  // a high-resolution model sees a wide viewport 1:1 up to 2000 px (and 3.75 MP)
  assert.deepEqual(await size('hi', { w: 1800, h: 900, dpr: 1, sx: 0, sy: 0 }), [1800, 900]);
  assert.deepEqual(await size('hi', { w: 2400, h: 1200, dpr: 1, sx: 0, sy: 0 }), [2000, 1000]);
  assert.deepEqual(await size('hi'), [2000, 638]);
  assert.deepEqual(await size('alias'), [2000, 638], 'an alias names the current model, from a promise too');
  // older models, unknown models and a failing lookup: 1568 px and 1.15 MP
  assert.deepEqual(await size('old'), [1568, 500]);
  assert.deepEqual(await size('none'), [1568, 500]);
  assert.deepEqual(await size('boom'), [1568, 500]);
  assert.deepEqual(await size('old', { w: 1400, h: 1000, dpr: 1, sx: 0, sy: 0 }), [1269, 906], 'the pixel budget applies too');
  // a screenshot never exceeds the viewport's CSS pixels, whatever the model: its pixels stay the coordinate frame
  assert.deepEqual(await size('hi', { w: 800, h: 600, dpr: 2, sx: 0, sy: 0 }), [800, 600]);
  // a zoom goes to device resolution, up to the model's zoom side (2000 px for every model)
  const st = { w: 2000, h: 1200, dpr: 2, sx: 0, sy: 0 };
  assert.deepEqual(await size('hi', st, { region: [0, 0, 2000, 1000] }), [2000, 1000]);
  assert.deepEqual(await size('old', st, { region: [0, 0, 2000, 1000] }), [2000, 1000]);
  assert.ok(asked.includes('hi') && asked.includes('boom'), 'the chat that asked is the one whose model counts');
});

test('capture: a click on a scaled screenshot lands where the model saw it (image pixel -> viewport point)', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const st = { w: 3136, h: 1000, dpr: 1, sx: 0, sy: 0 };
  const shot = await drive(t, h.tabs.capture(tab, st));
  assert.deepEqual([shot.width, shot.height], [1568, 500], 'half size for the default model');
  // the model sees a button at image pixel (1000, 300) and clicks the point the result's factor gives
  const [x, y] = toFrame(mapping(shot, st), [1000, 300]);
  const p = await h.tabs.point(tab, st, { coordinate: [x, y] });
  await drive(t, h.tabs.click(tab, p));
  const pressed = tab.wc.debugger.sent('Input.dispatchMouseEvent').find((c: any) => c.params.type === 'mousePressed');
  assert.deepEqual([pressed.params.x, pressed.params.y], [2000, 600]);
  // a zoom's pixels map through its region
  const zoom = await drive(t, h.tabs.capture(tab, { ...st, dpr: 2 }, { region: [100, 100, 300, 200] }));
  assert.deepEqual(toFrame(mapping(zoom, st), [zoom.width, zoom.height]), [300, 200]);
});

test('capture: a zoom shows its region up to device resolution, clipped to the viewport; bad regions fail', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const rects: any[] = [];
  tab.wc.captureImpl = (rect: any) => (rects.push(rect), image({ src: 'capturePage' }));
  const st = { w: 800, h: 600, dpr: 2, sx: 0, sy: 10 };
  const zoom = await drive(t, h.tabs.capture(tab, st, { region: [300, 200, 100, 100] }));
  assert.deepEqual(zoom.rect, { x: 100, y: 100, width: 200, height: 100 });
  assert.deepEqual(rects, [{ x: 100, y: 100, width: 200, height: 100 }]);
  assert.deepEqual([zoom.width, zoom.height], [400, 200], 'twice the CSS size on a 2x display');
  const clipped = await drive(t, h.tabs.capture(tab, { ...st, dpr: undefined }, { region: [-50, -50, 900, 700] }));
  assert.deepEqual(clipped.rect, { x: 0, y: 0, width: 800, height: 600 });
  assert.deepEqual([clipped.width, clipped.height], [800, 600]);
  for (const region of ['x', [1, 2, 3], [1, 2, 3, 'x']])
    await assert.rejects(h.tabs.capture(tab, st, { region }), { code: 'bad_args', message: 'region must be [x0, y0, x1, y1].' });
  for (const region of [
    [10, 10, 10, 50],
    [900, 0, 1000, 10],
  ])
    await assert.rejects(h.tabs.capture(tab, st, { region }), {
      code: 'bad_args',
      message: 'The region is empty or outside the viewport.',
    });
});

test('capture: falls back to CDP when capturePage fails, is empty, or the viewport is emulated; a stuck CDP capture fails', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const st = { w: 800, h: 600, dpr: 1, sx: 5, sy: 10 };
  tab.wc.handlers['Page.captureScreenshot'] = (p: any) => ({ data: Buffer.from(JSON.stringify(p)).toString('base64') });
  const cdp = () => tab.wc.debugger.sent('Page.captureScreenshot').map((c) => c.params);
  tab.wc.captureImpl = () => {
    throw new Error('hidden');
  };
  assert.deepEqual(JSON.parse(Buffer.from((await drive(t, h.tabs.capture(tab, st))).data, 'base64').toString()).info, {
    src: 'cdp',
    bytes: Buffer.from(JSON.stringify({ format: 'png' })).length,
  });
  tab.wc.captureImpl = () => image({ src: 'capturePage' }, true);
  await drive(t, h.tabs.capture(tab, st, { region: [0, 0, 100, 50] }));
  tab.wc.captureImpl = () => null;
  await drive(t, h.tabs.capture(tab, st));
  tab.wc.captureImpl = () => image({ src: 'capturePage' });
  tab.emulated = { w: 375, h: 812, mobile: true };
  await drive(t, h.tabs.capture(tab, st));
  assert.deepEqual(cdp(), [
    { format: 'png' },
    { format: 'png', clip: { x: 5, y: 10, width: 100, height: 50, scale: 1 } },
    { format: 'png' },
    { format: 'png' },
  ]);
  tab.wc.handlers['Page.captureScreenshot'] = () => new Promise(() => {});
  await assert.rejects(drive(t, h.tabs.capture(tab, st), { step: 1000 }), { code: 'capture_failed' });
});

test('IAB-11 guard: under the mobile preset a 980 px page is captured once per call by CDP, with the parameters that do not tile', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, h.tabs.resize(tab, { preset: 'mobile' }));
  let paneCaptures = 0;
  tab.wc.captureImpl = () => (paneCaptures++, image({ src: 'capturePage' }));
  const params: any[] = [];
  tab.wc.handlers['Page.captureScreenshot'] = (p: any) => (params.push(p), { data: Buffer.from('png').toString('base64') });
  tab.wc.handlers['Page.getLayoutMetrics'] = () => ({ cssContentSize: { width: 980, height: 3000 } });
  // a page without a viewport meta lays out at 980 CSS px; at 375x812 @3x its visual viewport is 980x2122 CSS px
  const st = { w: 980, h: 2122, dpr: 3, sx: 0, sy: 400 };
  const shot = await drive(t, h.tabs.capture(tab, st));
  const zoom = await drive(t, h.tabs.capture(tab, st, { region: [0, 0, 980, 300] }));
  const full = await drive(t, h.tabs.captureFull(tab));
  // capturePage would copy the pane's own surface, not the emulated viewport
  assert.equal(paneCaptures, 0);
  assert.deepEqual(params, [
    // the viewport: no clip and no captureBeyondViewport, so Chromium captures the emulated viewport as laid out, once
    { format: 'png' },
    // a zoom: its region in page CSS px (scroll included), at scale 1; Chromium applies the device scale
    { format: 'png', clip: { x: 0, y: 400, width: 980, height: 300, scale: 1 } },
    // the full page is the only capture beyond the viewport, clipped to the CSS content size
    { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 980, height: 3000, scale: 1 } },
  ]);
  // one image per call, in the frame's aspect (that of the 1125x2436 device image): nothing is stretched or repeated
  assert.deepEqual([shot.frame, shot.rect, shot.width, shot.height], [{ w: 980, h: 2122 }, null, 724, 1568]);
  assert.ok(Math.abs(shot.width / shot.height - 1125 / 2436) < 0.001);
  assert.deepEqual([zoom.rect, zoom.width, zoom.height], [{ x: 0, y: 0, width: 980, height: 300 }, 2000, 612]);
  assert.deepEqual([full.frame, full.width, full.height, full.truncated], [{ w: 980, h: 3000 }, 980, 3000, false]);
});

test('capture: a capturePage that hangs is bounded and CDP is used; black images go to CDP and never come back as the page', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const st = { w: 800, h: 600, dpr: 1, sx: 0, sy: 0 };
  const src = (shot: any) => JSON.parse(Buffer.from(shot.data, 'base64').toString()).info.src;
  const cdpShots: any[] = [];
  let cdpBlack = false;
  let cdpEmpty = false;
  h.tabs.o.images.fromBuffer = (buf: Buffer) => image({ src: 'cdp', bytes: buf.length }, cdpEmpty, cdpBlack);
  tab.wc.handlers['Page.captureScreenshot'] = (p: any) => (cdpShots.push(p), { data: Buffer.from('png').toString('base64') });
  // capturePage never answers: CDP after CAPTURE_MS
  tab.wc.captureImpl = () => new Promise(() => {});
  assert.equal(src(await drive(t, h.tabs.capture(tab, st), { step: 1000 })), 'cdp');
  // a black capturePage image is not the page: CDP
  tab.wc.captureImpl = () => image({ src: 'capturePage' }, false, true);
  assert.equal(src(await drive(t, h.tabs.capture(tab, st))), 'cdp');
  assert.equal(cdpShots.length, 2);

  // both black: an error, not a black image, unless the page is black itself
  cdpBlack = true;
  let pageBlack: any = { result: { value: false } };
  const pageCheck = (params: any, sessionId?: string) => {
    // the agent world (masking password fields around the capture) answers as usual
    if (params.expression !== BLACK_PAGE_SCRIPT) {
      delete tab.wc.handlers['Runtime.evaluate'];
      try {
        return tab.wc.cdp('Runtime.evaluate', params, sessionId);
      } finally {
        tab.wc.handlers['Runtime.evaluate'] = pageCheck;
      }
    }
    if (pageBlack instanceof Error) throw pageBlack;
    return pageBlack;
  };
  tab.wc.handlers['Runtime.evaluate'] = pageCheck;
  const pageChecks = () => tab.wc.debugger.sent('Runtime.evaluate').filter((c) => c.params.expression === BLACK_PAGE_SCRIPT);
  const blank = {
    code: 'capture_failed',
    message:
      "The screenshot of tab_aaaaaa came back blank: the page isn't painted in its window. Open the browser pane in MoPilot (or call browser_tabs_select) and try again.",
  };
  await assert.rejects(drive(t, h.tabs.capture(tab, st)), blank);
  // a black capture is retried once on the pane's white before giving up
  const backdrops = () => tab.wc.debugger.sent('Emulation.setDefaultBackgroundColorOverride').length;
  const before = backdrops();
  await assert.rejects(drive(t, h.tabs.capture(tab, st)), blank);
  assert.equal(backdrops(), before + 1);
  pageBlack = new Error('context gone');
  await assert.rejects(drive(t, h.tabs.capture(tab, st)), blank);
  pageBlack = { result: { value: true } };
  assert.equal(src(await drive(t, h.tabs.capture(tab, st))), 'cdp', 'a black page captured black (the last capture)');
  assert.deepEqual(pageChecks().at(-1)?.params, { expression: BLACK_PAGE_SCRIPT, returnByValue: true });
  // only CDP answered (capturePage failed): its black image is the black page
  tab.wc.captureImpl = () => {
    throw new Error('hidden');
  };
  assert.equal(src(await drive(t, h.tabs.capture(tab, st))), 'cdp');
  // nothing at all (capturePage empty, CDP empty): an error without asking the page
  const asked = pageChecks().length;
  cdpEmpty = true;
  tab.wc.captureImpl = () => image({ src: 'capturePage' }, true);
  await assert.rejects(drive(t, h.tabs.capture(tab, st)), blank);
  assert.equal(pageChecks().length, asked);
});

test("capture: a page with no background (transparent, black once encoded) is retried on the pane's white and comes back as the page", async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const st = { w: 800, h: 600, dpr: 1, sx: 0, sy: 0 };
  let backdrop = false;
  tab.wc.handlers['Emulation.setDefaultBackgroundColorOverride'] = (p: any) => {
    assert.deepEqual(p, PAGE_BACKDROP);
    backdrop = true;
    return {};
  };
  // before the backdrop: every pixel transparent or black (black text on no background)
  tab.wc.captureImpl = () => ({ isEmpty: () => false, toBitmap: () => Buffer.from([0, 0, 0, 0, 0, 0, 0, 255]) });
  h.tabs.o.images.fromBuffer = (buf: Buffer) =>
    backdrop ? image({ src: 'cdp-on-white' }) : { isEmpty: () => false, toBitmap: () => Buffer.from([0, 0, 0, 0]) };
  tab.wc.handlers['Page.captureScreenshot'] = () => ({ data: Buffer.from('png').toString('base64') });
  const shot = await drive(t, h.tabs.capture(tab, st));
  assert.equal(JSON.parse(Buffer.from(shot.data, 'base64').toString()).info.src, 'cdp-on-white');
  // a failing backdrop command is ignored: the retry still runs
  backdrop = false;
  tab.wc.handlers['Emulation.setDefaultBackgroundColorOverride'] = () => {
    throw new Error('gone');
  };
  h.tabs.o.images.fromBuffer = (() => {
    let n = 0;
    return () => (n++ ? image({ src: 'second' }) : image({}, false, true));
  })();
  assert.equal(JSON.parse(Buffer.from((await drive(t, h.tabs.capture(tab, st))).data, 'base64').toString()).info.src, 'second');
});

test('captureFull: the whole page up to 8000 px tall, at most 1280 px wide; blank or stuck captures fail', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const clips: any[] = [];
  tab.wc.handlers['Page.getLayoutMetrics'] = () => ({ cssContentSize: { width: 2560, height: 12000.5 } });
  tab.wc.handlers['Page.captureScreenshot'] = (p: any) => (clips.push(p), { data: Buffer.from('png').toString('base64') });
  const shot = await drive(t, h.tabs.captureFull(tab));
  assert.deepEqual(clips[0], { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 2560, height: 8000, scale: 1 } });
  assert.deepEqual([shot.width, shot.height, shot.frame, shot.rect, shot.truncated], [1280, 4000, { w: 2560, h: 8000 }, null, true]);
  tab.wc.handlers['Page.getLayoutMetrics'] = () => ({ contentSize: { width: 0, height: 300 } });
  const small = await drive(t, h.tabs.captureFull(tab));
  assert.deepEqual([small.width, small.height, small.truncated], [1, 300, false]);
  h.tabs.o.images.fromBuffer = () => image({}, false, true);
  await assert.rejects(drive(t, h.tabs.captureFull(tab)), {
    code: 'capture_failed',
    message: /full-page screenshot of tab_aaaaaa came back blank/,
  });
  tab.wc.handlers['Page.captureScreenshot'] = () => new Promise(() => {});
  await assert.rejects(drive(t, h.tabs.captureFull(tab), { step: 1000 }), {
    code: 'capture_failed',
    message: /^Couldn't capture the page/,
  });
});

test('cursor: each input action is shown before it is sent (the element name, never the typed text)', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const seen = recordingCursor(h);
  const order: string[] = [];
  const act = h.tabs.o.cursor.act;
  h.tabs.o.cursor.act = async (tb: any, a: any) => (order.push(`show ${a.kind}`), act(tb, a));
  tab.wc.handlers['Input.dispatchMouseEvent'] = (p: any) => (order.push(p.type), {});
  await drive(t, h.tabs.click(tab, { x: 1, y: 2, name: 'Submit' }, { button: 'right', clickCount: 2 }));
  assert.deepEqual(order.slice(0, 2), ['show click', 'mouseMoved']);
  await drive(t, h.tabs.hover(tab, { x: 3, y: 4 }));
  await drive(t, h.tabs.drag(tab, { x: 0, y: 0 }, { x: 9, y: 9 }));
  await drive(t, h.tabs.scroll(tab, { x: 5, y: 6 }, 'up'));
  await drive(t, h.tabs.typeText(tab, 'hunter2'));
  await drive(t, h.tabs.keys(tab, ' Enter  Tab '));
  assert.deepEqual(
    seen.map((s) => s[2]),
    [
      { kind: 'click', x: 1, y: 2, name: 'Submit', button: 'right', clickCount: 2 },
      { kind: 'hover', x: 3, y: 4, name: undefined },
      { kind: 'drag', x: 0, y: 0, to: { x: 9, y: 9 } },
      { kind: 'scroll', x: 5, y: 6, direction: 'up' },
      { kind: 'type' },
      { kind: 'key', keys: 'Enter Tab' },
    ],
  );
  assert.equal(JSON.stringify(seen).includes('hunter2'), false);
  // a bad scroll direction fails before anything is shown
  await assert.rejects(h.tabs.scroll(tab, { x: 5, y: 5 }, 'sideways'), { code: 'bad_args' });
  assert.equal(seen.length, 6);
});

test('cursor: hidden while a screenshot is taken, and shown again even when the capture fails', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const seen = recordingCursor(h);
  const st = { w: 800, h: 600, dpr: 1, sx: 0, sy: 0 };
  tab.wc.captureImpl = () => (seen.push(['capture']), image({ src: 'capturePage' }));
  const shot = await drive(t, h.tabs.capture(tab, st, { scale: 0.5 }));
  assert.equal(shot.width, 400);
  assert.deepEqual(seen, [['conceal', tab.id], ['capture'], ['reveal', tab.id]]);
  seen.length = 0;
  await assert.rejects(drive(t, h.tabs.capture(tab, st, { region: [0, 0, 0, 0] })), { code: 'bad_args' });
  assert.deepEqual(seen, [
    ['conceal', tab.id],
    ['reveal', tab.id],
  ]);
});

test('cursor: removed when the user takes the tab over and at the turn end, before CDP is let go', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const seen = recordingCursor(h);
  await drive(t, h.tabs.ready(tab, 'c'));
  assert.equal(h.tabs.takeOver('c', tab.id), true);
  assert.equal(h.tabs.takeOver('c', tab.id, false), true);
  assert.deepEqual(seen, [['clear', tab.id, true]], 'handing back draws nothing');
  seen.length = 0;
  await drive(t, h.tabs.ready(tab, 'c'));
  // the cursor goes before the turn's commands stop (a Chrome tab's relay refuses them after, #1632)
  h.tabs.onTurnEnd(() => seen.push(['turn over']));
  await drive(t, h.tabs.turnEnded('c'));
  assert.deepEqual(seen, [['clear', tab.id, true], ['turn over']]);
  assert.equal(tab.wc.debugger.isAttached(), false);
});

test("cursor: browser_script's wheel shows its direction, and the full-page capture keeps the cursor out", async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const seen = recordingCursor(h);
  for (const [dx, dy] of [
    [0, -50],
    [0, 50],
    [0, 0],
    [-30, 0],
    [30, 0],
  ])
    await drive(t, h.tabs.wheel(tab, { x: 1, y: 2 }, dx, dy));
  assert.deepEqual(
    seen.map((s) => s[2].direction),
    ['up', 'down', 'down', 'left', 'right'],
  );
  assert.deepEqual(seen[0], ['act', tab.id, { kind: 'scroll', x: 1, y: 2, direction: 'up' }]);
  seen.length = 0;
  tab.wc.handlers['Page.getLayoutMetrics'] = () => ({ cssContentSize: { width: 100, height: 100 } });
  tab.wc.handlers['Page.captureScreenshot'] = () => (seen.push(['capture']), { data: Buffer.from('png').toString('base64') });
  await drive(t, h.tabs.captureFull(tab));
  assert.deepEqual(seen, [['conceal', tab.id], ['capture'], ['reveal', tab.id]]);
  seen.length = 0;
  h.tabs.o.images.fromBuffer = () => image({}, false, true);
  await assert.rejects(drive(t, h.tabs.captureFull(tab)), { code: 'capture_failed' });
  assert.deepEqual(seen, [['conceal', tab.id], ['capture'], ['reveal', tab.id]]);
});

test('capture: password fields are masked in every frame first (with a painted frame after), and put back after', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  tab.wc.debugger.event('Target.attachedToTarget', { sessionId: 'F1', targetInfo: { type: 'iframe', targetId: 'frame-1' } });
  await flush();
  const st = { w: 800, h: 600, dpr: 1, sx: 0, sy: 0 };
  const order: any[] = [];
  const masked: Record<string, number> = { '': 0, F1: 2 };
  tab.wc.ops.mask = (args: any, sid?: string) => (order.push(['mask', args.on, sid ?? '']), { count: args.on ? masked[sid ?? ''] : 0 });
  tab.wc.captureImpl = () => (order.push(['capture']), image({ src: 'capturePage' }));
  const frames = () => tab.wc.debugger.sent('Runtime.evaluate').filter((c) => c.params.expression === FRAME_SCRIPT).length;
  const before = frames();
  await drive(t, h.tabs.capture(tab, st));
  assert.deepEqual(order, [['mask', true, ''], ['mask', true, 'F1'], ['capture'], ['mask', false, ''], ['mask', false, 'F1']]);
  assert.equal(frames(), before + 1, 'a frame is painted after masking');
  // nothing to mask: no frame wait; a frame whose mask fails is skipped
  tab.wc.ops.mask = (_args: any, sid?: string) => {
    if (sid === 'F1') throw new Error('gone');
    return { count: 0 };
  };
  await drive(t, h.tabs.capture(tab, st));
  assert.equal(frames(), before + 1);
  // a nested frame the page could not reach is recorded; the rest is masked
  const { recentIgnored, clearIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');
  clearIgnored();
  tab.wc.ops.mask = () => ({ count: 0, unreadable: ['TypeError: frame torn down', 'TypeError: again'] });
  await drive(t, h.tabs.capture(tab, st));
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['mask password fields in a nested frame for a screenshot', 'TypeError: frame torn down; TypeError: again']],
  );
  clearIgnored();
  // the full-page capture too, and the masks are put back when it fails
  order.length = 0;
  tab.wc.ops.mask = (args: any, sid?: string) => (order.push(['mask', args.on, sid ?? '']), { count: 1 });
  tab.wc.handlers['Page.getLayoutMetrics'] = () => ({ cssContentSize: { width: 100, height: 100 } });
  tab.wc.handlers['Page.captureScreenshot'] = () => {
    throw new Error('gone');
  };
  await assert.rejects(drive(t, h.tabs.captureFull(tab)), /gone/);
  assert.deepEqual(order, [
    ['mask', true, ''],
    ['mask', true, 'F1'],
    ['mask', false, ''],
    ['mask', false, 'F1'],
  ]);
});

test('capture: a frame that fails to paint or never paints after masking does not stop the screenshot', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  const st = { w: 800, h: 600, dpr: 1, sx: 0, sy: 0 };
  tab.wc.ops.mask = (args: any) => ({ count: args.on ? 1 : 0 });
  tab.wc.captureImpl = () => image({ src: 'capturePage' });
  const cdp = tab.wc.cdp.bind(tab.wc);
  let frame: () => any = () => {
    throw new Error('no frame');
  };
  tab.wc.cdp = (method: string, params: any, sessionId?: string) =>
    method === 'Runtime.evaluate' && params.expression === FRAME_SCRIPT ? frame() : cdp(method, params, sessionId);
  const failed = await drive(t, h.tabs.capture(tab, st));
  assert.ok(failed.data);
  frame = () => new Promise(() => {});
  const hung = await drive(t, h.tabs.capture(tab, st), { step: 250 });
  assert.ok(hung.data);
});
