// Motion bench disc cursor (Sky's grey disc with a glyph), the page's ready event as the origin, and the 1x recording layout (bench/lib/motion cursor, cursorBench, layout, cli).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCursor, findMoves, flatBackground } from '../bench/lib/motion/cursor.mjs';
import { analyzeCursor, originFromEvents, pageScale, readyOrigin } from '../bench/lib/motion/cursorBench.mjs';
import { measureRecording } from '../bench/lib/motion/cli.mjs';
import { cursorCrop, moveWindowLines, parkedBounds, PARKED_SIZE } from '../bench/lib/motion/layout.mjs';
import { momentById, resolveRegions } from '../bench/lib/motion/moments.mjs';
import { stubPlanner } from '../bench/lib/motion/skyFit.mjs';
import { cursorVideo, discSynthVideo, drawDisc, fixtureRun, ORIGIN, PAGE_LUMA, WALL0 } from './support/motionCursor.ts';

const RECT: [number, number, number, number] = [0, 0, 320, 200];
/** detectCursor on a page of the synthetic page's luma: a cursor that rests is not the median of the frames. */
const detect = (video: ReturnType<typeof cursorVideo>, o: Record<string, unknown> = {}) =>
  detectCursor(video, { rect: RECT, background: flatBackground(video, RECT, PAGE_LUMA), ...o });
const planner = { planner: stubPlanner, source: 'stub' };

type Fill = (x: number, y: number, w: number, h: number, v: number) => void;
/** The first frame's fix of a still page that `extra` draws on. */
const scene = (extra: (fill: Fill) => void, o: Record<string, unknown> = {}) =>
  detect(
    cursorVideo(() => null, { count: 1, extra: (_t, fill) => extra(fill) }),
    o,
  )[0];

test('detectCursor finds a grey disc with a glyph in it to under a pixel, at scale 1 and 2, and tracks its moves', () => {
  const f = detect(cursorVideo(() => [100, 80], { count: 3, disc: true }))[0];
  assert.ok(f.found && Math.abs(f.x - 100) <= 1 && Math.abs(f.y - 80) <= 1, JSON.stringify(f));
  // at scale 2 the cells are coarser; the centre is within a cell
  const synth = discSynthVideo(2);
  const coarse = detectCursor(synth, { rect: [0, 0, 640, 400], background: flatBackground(synth, [0, 0, 640, 400], PAGE_LUMA) });
  assert.ok(coarse.filter((c) => c.found).length > 190);
  const moves = findMoves(coarse);
  assert.equal(moves.length, 2);
  assert.ok(Math.hypot(moves[0].end.x - 520, moves[0].end.y - 280) < 3, JSON.stringify(moves[0].end));
  assert.ok(Math.hypot(moves[1].end.x - 100, moves[1].end.y - 120) < 3);
});

test('a disc must be dark, round, compact and of cursor size; the heaviest qualifying one wins; anything else takes the arrow path', () => {
  // two discs: the bigger one is the cursor whichever is found first
  for (const order of [0, 1]) {
    const f = scene((fill) => {
      const discs: [number, number, number][] = [
        [60, 60, 8],
        [200, 100, 12],
      ];
      if (order) discs.reverse();
      for (const [x, y, r] of discs) drawDisc(fill, x, y, r);
    });
    assert.ok(f.found && Math.abs(f.x - 200) <= 1 && Math.abs(f.y - 100) <= 1, JSON.stringify(f));
  }
  // a light disc on a dark page is not a dark disc: the arrow path runs and centres on its pixels
  const light = scene(
    (fill) => {
      fill(0, 0, 320, 200, 120);
      drawDisc((x, y, w, h) => fill(x, y, w, h, 235), 100, 100, 12);
    },
    { background: new Uint8Array(320 * 200).fill(120) },
  );
  assert.ok(light.found && Math.abs(light.x - 100) < 3, JSON.stringify(light));
  // too small (a 12 px square), too big (a 60 px disc), too elongated (36x14), a hollow ring, a solid square: no disc, the arrow path decides
  const shapes: [string, (fill: Fill) => void, number][] = [
    ['small', (fill) => fill(100, 100, 12, 12, 40), 106],
    ['big', (fill) => drawDisc(fill, 160, 100, 30), 160],
    ['bar', (fill) => fill(100, 100, 36, 14, 40), 118],
    [
      'ring',
      (fill) => {
        fill(100, 100, 24, 24, 40);
        fill(104, 104, 16, 16, 235);
      },
      112,
    ],
    ['square', (fill) => fill(100, 100, 22, 22, 40), 111],
  ];
  for (const [name, draw, x] of shapes) {
    const f = scene(draw);
    assert.ok(f.found && Math.abs(f.x - x) < 3, `${name}: ${JSON.stringify(f)}`);
  }
});

test('readyOrigin reads the viewport from the page window, else the clicks; the ready event wins', () => {
  const ready = { type: 'ready', t: 0, viewport: [1280, 768], screenX: 0, screenY: 30, outerWidth: 1280, outerHeight: 800 };
  assert.deepEqual(readyOrigin([ready], 1), { x: 0, y: 62 });
  assert.deepEqual(readyOrigin([{ ...ready, screenX: 10, outerWidth: 1300 }], 2), { x: 40, y: 124 - 20 });
  for (const missing of ['screenX', 'screenY', 'outerWidth', 'outerHeight', 'viewport']) {
    assert.equal(readyOrigin([{ ...ready, [missing]: undefined }], 1), null, missing);
  }
  assert.equal(readyOrigin([], 1), null);
  // the native fixture app reports its content view's place itself
  const native = { type: 'ready', t: 0, viewport: [1280, 800], frame: { x: 0, y: 24, width: 1280, height: 800 } };
  assert.deepEqual(readyOrigin([native], 1), { x: 0, y: 24 });
  assert.deepEqual(readyOrigin([native], 2), { x: 0, y: 48 });
  assert.equal(readyOrigin([{ ...native, frame: { x: 0 } }], 1), null);
  const click = { type: 'click', t: 1, trusted: true, sx: 110, cx: 10, sy: 70, cy: 20 };
  // the clicks win when they disagree with the window guess (a browser pane inside its window), the ready event when they agree
  assert.deepEqual(originFromEvents([click, ready], 1), { x: 100, y: 50 });
  const agree = { type: 'click', t: 1, trusted: true, sx: 10, cx: 10, sy: 62 + 20, cy: 20 };
  assert.deepEqual(originFromEvents([{ ...agree, sx: 14 }, ready], 1), { x: 0, y: 62 }, 'within a few points: the ready event');
  assert.deepEqual(originFromEvents([click, { ...ready, screenX: undefined }], 1), { x: 100, y: 50 });
  assert.deepEqual(originFromEvents([ready], 1), { x: 0, y: 62 });
  // the native fixture app's report is exact and is never overruled
  const native2 = { type: 'ready', t: 0, viewport: [1280, 800], frame: { x: 0, y: 24, width: 1280, height: 800 } };
  assert.deepEqual(originFromEvents([click, native2], 1), { x: 0, y: 24 });
  // a zoomed pane: 200 CSS px span 142 points, and the origin is the click minus its scaled page position
  const zoomed = [
    { type: 'click', t: 1, trusted: true, sx: 1295.58, cx: 398, sy: 580.21, cy: 551 },
    { type: 'click', t: 2, trusted: true, sx: 1437.58, cx: 598, sy: 580.21, cy: 551 },
  ];
  assert.ok(Math.abs(pageScale(zoomed) - 0.71) < 1e-9);
  assert.ok(Math.abs(pageScale([...zoomed].reverse()) - 0.71) < 1e-9, 'in any order');
  const o = originFromEvents(zoomed, 1);
  assert.ok(o && Math.abs(o.x - (1295.58 - 398 * 0.71)) < 1e-6);
  assert.equal(pageScale([]), 1, 'no click tells no scale');
  assert.equal(
    pageScale([
      { ...click, cx: undefined },
      { ...click, sx: undefined },
      { ...click, trusted: false },
    ]),
    1,
    'clicks without positions tell none',
  );
  assert.equal(pageScale([click]), 1, 'one point tells no scale');
  assert.equal(pageScale([click, { ...click, cx: 12, sx: 112 }]), 1, 'clicks closer than 50 px tell no scale');
  assert.equal(
    pageScale([
      { ...zoomed[0], sx: 1, cx: 1 },
      { ...zoomed[1], sx: 3000, cx: 600 },
    ]),
    1,
    'an impossible slope is ignored',
  );
  assert.equal(
    pageScale([
      { ...zoomed[0], sx: 100, cx: 100 },
      { ...zoomed[1], sx: 300, cx: 300 },
    ]),
    1,
    'a page at scale 1',
  );
});

test('analyzeCursor on a disc cursor run: the origin comes from the ready event and all moves match', () => {
  const { video, events } = fixtureRun(true);
  const a = analyzeCursor({ video, events, toVideo: (w) => w - WALL0, pxPerPoint: 1, marks: { send: 200 }, planner });
  assert.deepEqual([a.origin?.x, a.origin?.y], [ORIGIN.x, ORIGIN.y]);
  assert.equal(a.moves.expected, 8);
  assert.equal(a.moves.matched, 8, JSON.stringify(a.moves.list.map((m: any) => [m.key, m.matched])));
});

test('parkedBounds puts the agent window in the screen corner, on screen; the window action and crop follow', () => {
  assert.deepEqual(PARKED_SIZE, [440, 420]);
  assert.deepEqual(parkedBounds([0, 0, 2048, 1280]), [1592, 764, 440, 420]);
  assert.deepEqual(parkedBounds([0, 0, 300, 200]), [0, 0, 300, 200]);
  assert.deepEqual(parkedBounds([10, 20, 1000, 900], [100, 100], 0, 0), [910, 820, 100, 100]);
  assert.deepEqual(moveWindowLines('Electron', [1592.4, 764, 440, 420]).slice(1, 4), [
    'set p to first application process whose name is "Electron" or displayed name is "Electron"',
    'set size of window 1 of p to {440, 420}',
    'set position of window 1 of p to {1592, 764}',
  ]);
  assert.equal(cursorCrop({ screenX: 0, screenY: 30, outerWidth: 1280, outerHeight: 800 }), '1280x830');
  assert.equal(cursorCrop({ frame: { x: 0, y: 24, width: 1280, height: 800 } }), '1280x824');
  assert.equal(cursorCrop({ frame: { x: 0, y: 24, width: 1280, height: 800 } }, 2), '2560x1648');
  assert.equal(cursorCrop({ frame: { x: 0, y: 24, width: Number.NaN, height: 800 } }), '1280x800');
  assert.equal(cursorCrop({ screenX: 0, screenY: 30, outerWidth: 1280, outerHeight: 800 }, 2), '2560x1660');
  assert.equal(cursorCrop({ screenX: 0 }), '1280x800');
  assert.equal(cursorCrop(null), '1280x800');
});

test('measureRecording takes the recording pixels per point from the recording when it names them', () => {
  const { video } = fixtureRun();
  const moment = momentById('cursor-move-d100');
  const rec = {
    arm: 'desk-chatgpt',
    family: 'chatgpt',
    version: '1',
    moment: moment.id,
    surface: 'cu',
    window: [0, 0, 400, 300],
    regions: resolveRegions(moment, 'chatgpt', [0, 0, 400, 300]),
    sync: { clock: 'wall', originMs: WALL0 },
    marks: { send: WALL0 + 200, end: WALL0 + 21_000 },
    recordedAt: new Date(WALL0 + 22_000).toISOString(),
  };
  const named = measureRecording({ ...rec, pxPerPoint: 1, crop: '400x300' }, video);
  assert.deepEqual(named.results, measureRecording(rec, video).results);
});
