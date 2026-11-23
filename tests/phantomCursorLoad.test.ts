// The phantom cursor window shows only a page that has loaded (no flash of the previous page when it comes back), a click
// never goes before its cursor can be seen, and a window that is not finite is no window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { phantomRig } from './support/phantomRig.ts';

const require = createRequire(import.meta.url);
const { LOAD_WAIT_MS } = require('../electron/capabilities/phantomCursor.cjs');
const flush = () => new Promise<void>((r) => setImmediate(r));
const WIN = { x: 100, y: 50, width: 500, height: 400 };
const ACT = { chatId: 'c1', bundleId: 'com.apple.Notes', bounds: WIN, points: [{ x: 300, y: 250 }], kind: 'click' };

test('the window is shown once the page has loaded, not before: the previous page never flashes', async () => {
  const p = phantomRig('pending');
  const went = p.cursor.approach(ACT);
  await flush();
  assert.equal(p.windows[0].shown, false, 'the new page is still loading');
  p.release();
  await flush();
  assert.equal(p.windows[0].shown, true);
  p.cursor.hide();
  // coming back after a hide: hidden until the new page is in
  p.cursor.approach(ACT);
  await flush();
  assert.equal(p.windows[0].shown, false);
  p.release();
  await flush();
  assert.equal(p.windows[0].shown, true);
  p.cursor.dispose();
  await went;
});

test('a drag path is shown once it has loaded', async () => {
  const p = phantomRig('pending');
  p.cursor.show({
    bounds: WIN,
    points: [
      { x: 110, y: 60 },
      { x: 150, y: 90 },
    ],
  });
  await flush();
  assert.equal(p.windows[0].shown, false);
  p.release();
  await flush();
  assert.equal(p.windows[0].shown, true);
});

test('a page that has not loaded by the cap: the input goes on at once with no cursor, and a late load shows nothing', async () => {
  const p = phantomRig('pending');
  let went = false;
  const click = p.cursor.approach(ACT).then(() => (went = true));
  await flush();
  assert.equal(went, false, 'the click waits for the page to load');
  p.fire(LOAD_WAIT_MS);
  await click;
  assert.equal(went, true);
  assert.equal(p.windows[0].shown, false, 'the click did not go before a cursor was visible: nothing was shown at all');
  assert.equal(p.pending.size, 0, 'no clock was started');
  p.release();
  await flush();
  assert.equal(p.windows[0].shown, false, 'a page that loads after the cap shows nothing');
});

test('a window with no finite size is no window', async () => {
  const p = phantomRig();
  for (const bounds of [
    { ...WIN, width: Infinity },
    { ...WIN, height: Infinity },
    { ...WIN, x: Infinity },
  ]) {
    await p.cursor.approach({ ...ACT, bounds });
    assert.equal(p.cursor.show({ bounds, points: ACT.points }), false);
  }
  assert.equal(p.windows.length, 0);
});

test('a drag path whose page fails to load shows nothing', async () => {
  const p = phantomRig('reject');
  assert.equal(
    p.cursor.show({
      bounds: WIN,
      points: [
        { x: 110, y: 60 },
        { x: 150, y: 90 },
      ],
    }),
    true,
  );
  await flush();
  assert.equal(p.windows[0].shown, false);
});
