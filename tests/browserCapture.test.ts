// In-app browser screenshot sizing (IAB-07, electron/capabilities/browser/capture.cjs): the model-aware
// limits shared with desktop screenshots (desktopPolicy.cjs), the image-to-viewport coordinate mapping
// (a click on a scaled screenshot still lands), and the JPEG byte cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  captureSize,
  mapping,
  encodeJpeg,
  scaleOf,
  JPEG_QUALITY,
  MAX_JPEG_BYTES,
  FULL_PAGE_WIDTH,
} = require('../electron/capabilities/browser/capture.cjs');
const { screenshotLimits } = require('../electron/capabilities/contract/desktopPolicy.cjs');

test('captureSize: the cap follows the model (2000 px / 3.75 MP for high-resolution models, 1568 px / 1.15 MP otherwise and by default)', () => {
  const big = { w: 4000, h: 2000 };
  for (const model of ['claude-opus-4-7', 'claude-sonnet-5', 'opus', 'fable', 'us.anthropic.claude-opus-4-8-v1:0']) {
    assert.deepEqual(captureSize(big, { model }), { width: 2000, height: 1000, highRes: true }, model);
  }
  for (const model of ['claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'gpt-5-codex', null, undefined, '']) {
    assert.deepEqual(captureSize(big, { model }), { width: 1517, height: 758, highRes: false }, String(model));
  }
  // the default is the safe one
  assert.deepEqual(captureSize(big), captureSize(big, { model: null }));
  // the same limits the desktop screenshots use
  assert.equal(screenshotLimits('claude-opus-4-7').maxSide, 2000);
  assert.equal(screenshotLimits(null).maxSide, 1568);
});

test("captureSize: a screenshot never exceeds the viewport's CSS pixels; a zoom goes to device resolution within the zoom side", () => {
  // a viewport that fits: 1:1 whatever the DPR, so image pixels are the coordinate frame
  assert.deepEqual(captureSize({ w: 1200, h: 800 }, { model: 'opus', dpr: 2 }), { width: 1200, height: 800, highRes: true });
  // a zoom: up to the DPR (at least 1), within the zoom side (2000 for high-res, 2000 otherwise), no pixel budget
  assert.deepEqual(captureSize({ w: 400, h: 300 }, { model: 'opus', dpr: 3, zoom: true }), { width: 1200, height: 900, highRes: true });
  assert.deepEqual(captureSize({ w: 1600, h: 800 }, { model: 'opus', dpr: 2, zoom: true }), { width: 2000, height: 1000, highRes: true });
  assert.deepEqual(captureSize({ w: 1600, h: 800 }, { model: null, dpr: 2, zoom: true }), { width: 2000, height: 1000, highRes: false });
  assert.deepEqual(captureSize({ w: 400, h: 300 }, { dpr: undefined, zoom: true }), { width: 400, height: 300, highRes: false });
  assert.deepEqual(captureSize({ w: 400, h: 300 }, { dpr: 0.5, zoom: true }), { width: 400, height: 300, highRes: false });
  assert.deepEqual(
    captureSize({ w: 400, h: 300 }, { dpr: null, zoom: true }),
    { width: 400, height: 300, highRes: false },
    'an unknown DPR is 1',
  );
  // scale shrinks the result (0.1 to 1; a bad one is 1); never below one pixel
  assert.deepEqual(captureSize({ w: 800, h: 600 }, { scale: 0.5 }), { width: 400, height: 300, highRes: false });
  assert.deepEqual(captureSize({ w: 800, h: 600 }, { scale: 0.01 }), { width: 80, height: 60, highRes: false });
  assert.deepEqual(captureSize({ w: 1, h: 1 }, { scale: 0.1 }), { width: 1, height: 1, highRes: false });
  assert.deepEqual([scaleOf('x'), scaleOf(5), scaleOf(0), scaleOf(0.3)], [1, 1, 1, 0.3]);
});

/** Where an image pixel lands in the coordinate frame, by a mapping's factor and origin (what a model does with them). */
const toFrame = (m: any, [x, y]: number[]) => [m.x0 + x * m.kx, m.y0 + y * m.ky];
const near = (a: number[], b: number[]) => assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9, `${a} is ${b}`);

test('mapping: image pixels land on the viewport, for scaled screenshots and zooms', () => {
  // a 3000x1500 viewport scaled down for an older model
  const frame = { w: 3000, h: 1500 };
  const size = captureSize(frame, { model: null });
  const m = mapping({ ...size, rect: null }, frame);
  assert.ok(Math.abs(m.kx - frame.w / size.width) < 1e-9 && m.x0 === 0 && m.y0 === 0);
  // the image's corners are the viewport's corners
  near(toFrame(m, [size.width, size.height]), [3000, 1500]);
  near(toFrame(m, [0, 0]), [0, 0]);
  // the center of what the model sees is clicked at the center of the viewport
  near(toFrame(m, [size.width / 2, size.height / 2]), [1500, 750]);
  // a 1:1 screenshot maps identically
  const same = mapping({ width: 800, height: 600, rect: null }, { w: 800, h: 600 });
  assert.deepEqual(toFrame(same, [10, 20]), [10, 20]);
  // a zoom at 2x: pixel / 2 + the region origin
  const zoom = mapping({ width: 400, height: 200, rect: { x: 100, y: 50, width: 200, height: 100 } }, { w: 800, h: 600 });
  assert.deepEqual(toFrame(zoom, [0, 0]), [100, 50]);
  assert.deepEqual(toFrame(zoom, [400, 200]), [300, 150]);
});

/** A fake nativeImage whose JPEG size is bytesAt(width, height, quality). */
function image(bytesAt: (w: number, h: number, q: number) => number) {
  const calls: any[] = [];
  return {
    calls,
    resize: (o: any) => {
      calls.push(['resize', o]);
      return {
        getSize: () => ({ width: o.width, height: o.height }),
        toJPEG: (q: number) => (calls.push(['jpeg', q]), Buffer.alloc(bytesAt(o.width, o.height, q))),
      };
    },
  };
}

test('encodeJpeg: quality 75 when it fits; lower quality, then a smaller image, while it is over the byte cap', () => {
  assert.equal(JPEG_QUALITY, 75);
  assert.equal(MAX_JPEG_BYTES, 1_000_000);
  assert.equal(FULL_PAGE_WIDTH, 1280);
  // fits at once
  const small = image(() => 10);
  const a = encodeJpeg(small, { width: 800, height: 600 });
  assert.deepEqual([a.width, a.height, a.quality, Buffer.from(a.data, 'base64').length], [800, 600, 75, 10]);
  assert.deepEqual(small.calls, [
    ['resize', { width: 800, height: 600, quality: 'good' }],
    ['jpeg', 75],
  ]);
  // fits at a lower quality
  const mid = image((_w, _h, q) => (q > 50 ? 2000 : 900));
  assert.deepEqual(encodeJpeg(mid, { width: 800, height: 600 }, 1000).quality, 45);
  // needs a smaller image: 70% a side
  const shrink = image((w) => (w > 600 ? 5000 : 500));
  const b = encodeJpeg(shrink, { width: 800, height: 600 }, 1000);
  assert.deepEqual([b.width, b.height, b.quality], [560, 420, 75]);
  // never fits: the last try (three shrinks, lowest quality) comes back anyway, never below a pixel
  const huge = image(() => 10_000_000);
  const c = encodeJpeg(huge, { width: 2, height: 1 });
  assert.deepEqual([c.width, c.height, c.quality], [1, 1, 45]);
  assert.equal(huge.calls.filter((x) => x[0] === 'resize').length, 4);
});

test("IAB-11 guard: a mobile-emulated viewport (980x2122 CSS px at 3x) keeps the device image's aspect and maps edge to edge", () => {
  // the mobile preset is 375x812 @3x; a page without a viewport meta lays out at 980 CSS px, so the
  // visual viewport (the coordinate frame) is 980x2122 and CDP returns a 1125x2436 device image
  const frame = { w: 980, h: 2122 };
  for (const model of [null, 'opus']) {
    const size = captureSize(frame, { model, dpr: 3 });
    assert.ok(Math.abs(size.width / size.height - 1125 / 2436) < 0.001, `${model}: ${size.width}x${size.height}`);
    assert.ok(size.width <= frame.w && size.height <= frame.h, 'never more pixels than the viewport has CSS pixels');
    const m = mapping({ ...size, rect: null }, frame);
    near(toFrame(m, [size.width, size.height]), [980, 2122]);
    near(toFrame(m, [0, 0]), [0, 0]);
  }
  assert.deepEqual(captureSize(frame, { model: null, dpr: 3 }), { width: 724, height: 1568, highRes: false });
});
