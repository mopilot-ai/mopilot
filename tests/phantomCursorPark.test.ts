// A click's cursor stays parked on its point until the chat's next action, the end of its turn, Stop or a take-over (Sky's does, ChatGPT 26.1103, #3810); nothing else hides it early, and it never outlives its chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { flush, approachRig, act, ACT, inputAtOf, WIN } from './support/phantomFakes.ts';

const require = createRequire(import.meta.url);
const { planApproach } = require('../shared/cursorApproach.mjs');
const { FRAME_MS, PARK_MS } = require('../electron/capabilities/phantomCursor.cjs');

const plan = () => planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: WIN.width, height: WIN.height } });
const hides = (w: any) => w.calls.filter((x: any) => x[0] === 'hide').length;
/** A click that has played its press and whose input has gone. */
async function pressed(c: any, t: any, o: object = {}) {
  const a = act(c, o);
  await flush();
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(plan()));
  await a.done;
  return a;
}

test('a click parked by its report stays up: no timer but the backstop, no hide; the backstop hides it after PARK_MS', async () => {
  const { e, t, c } = approachRig();
  const a = await pressed(c, t);
  const w = e.windows[0];
  assert.equal(c.finish({ chatId: 'c1', confirmed: true, token: a.token }), true);
  assert.equal(hides(w), 0);
  assert.equal(t.pending.size, 1);
  assert.deepEqual([...t.delays.values()].slice(-1), [PARK_MS]);
  t.fireAt(PARK_MS);
  assert.equal(hides(w), 1, 'the window closed or the app quit with no signal: it does not stay for ever');
  assert.equal(c.parked, null);
  assert.equal(t.pending.size, 0);
});

test('the chat’s next action takes the overlay from its parked cursor: the new page replaces it, the backstop is dropped, and nothing hides in between', async () => {
  const { e, t, c } = approachRig();
  const a = await pressed(c, t);
  const w = e.windows[0];
  c.finish({ chatId: 'c1', confirmed: true, token: a.token });
  const loads = () => w.calls.filter((x: any) => x[0] === 'loadURL').length;
  const before = loads();
  const next = act(c, { points: [{ x: 400, y: 300 }] });
  await flush();
  assert.equal(loads(), before + 1, 'its own page loads over the parked one');
  assert.equal(c.parked, null);
  assert.equal(hides(w), 0, 'the parked cursor is not hidden first: the page replaces it');
  assert.ok(![...t.delays.values()].includes(PARK_MS) || t.pending.size > 0);
  c.cancel('c1');
  await next.done;
  assert.equal(hides(w), 1);
  assert.equal(t.pending.size, 0);
});

test('the end of the turn, Stop, a take-over, the chat releasing the app and an archived chat end only that chat’s parked cursor; another chat’s calls do nothing to it', async () => {
  const { e, t, c } = approachRig();
  const a = await pressed(c, t);
  const w = e.windows[0];
  c.finish({ chatId: 'c1', confirmed: true, token: a.token });
  c.cancel('c2');
  c.forgetPositions('c2');
  c.forget('c2');
  assert.equal(hides(w), 0, "another chat's signals leave it");
  assert.ok(c.parked);
  c.forgetPositions('c1');
  assert.equal(hides(w), 1, 'the end of its chat’s turn');
  assert.equal(c.parked, null);
  assert.equal(c.previous.size, 0, 'and the points its next actions come from are forgotten');
  // the same for forget (an archived or deleted chat) and cancel (Stop, take-over, releasing the app)
  for (const end of ['forget', 'cancel'] as const) {
    const b = await pressed(c, t);
    c.finish({ chatId: 'c1', confirmed: true, token: b.token });
    c[end]('c1');
    assert.equal(c.parked, null, end);
  }
});

test('a drag shows its path over a parked cursor and takes the overlay; dispose and hide drop the park', async () => {
  const { e, t, c } = approachRig();
  const a = await pressed(c, t);
  const w = e.windows[0];
  c.finish({ chatId: 'c1', confirmed: true, token: a.token });
  assert.equal(
    c.show({
      bounds: WIN,
      points: [
        { x: 120, y: 90 },
        { x: 220, y: 140 },
      ],
      chatId: 'c1',
      bundleId: ACT.bundleId,
    }),
    true,
  );
  assert.equal(c.parked, null);
  const b = await pressed(c, t);
  c.finish({ chatId: 'c1', confirmed: true, token: b.token });
  assert.ok(c.parked);
  c.dispose();
  assert.equal(c.parked, null);
  assert.equal(t.pending.size, 0);
  assert.ok(hides(w) >= 1);
});

test('a queued action starts when its predecessor parks: a parked cursor never holds the overlay', async () => {
  const { e, t, c } = approachRig();
  const first = act(c);
  const second = act(c, { chatId: 'c2', points: [{ x: 350, y: 300 }] });
  await flush();
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(plan()));
  await first.done;
  const w = e.windows[0];
  const loads = () => w.calls.filter((x: any) => x[0] === 'loadURL').length;
  const before = loads();
  c.dispatched({ chatId: 'c1', token: first.token });
  await flush();
  assert.equal(loads(), before + 1, 'the queued action’s page loaded as the first parked');
  assert.equal(c.active.chatId, 'c2');
  assert.equal(c.parked, null, 'the new action owns the overlay');
  c.cancel('c2');
  await second.done;
});

test('a next page that fails to load takes the parked cursor away with it: no cursor is left on screen with no owner', async () => {
  const { e, t, c } = approachRig();
  const a = await pressed(c, t);
  const w = e.windows[0];
  c.finish({ chatId: 'c1', confirmed: true, token: a.token });
  w.loadMode = 'reject';
  const next = act(c, { chatId: 'c2', points: [{ x: 350, y: 300 }] });
  await flush();
  await next.done;
  assert.equal(w.calls.at(-1)[0], 'hide', 'the old page does not stay');
  assert.equal(c.parked, null);
  assert.equal(c.active, null);
  assert.equal(t.pending.size, 0);
  // a page that throws while loading ends the same way
  w.loadMode = 'resolve';
  const b = await pressed(c, t);
  c.finish({ chatId: 'c1', confirmed: true, token: b.token });
  w.loadMode = 'throw';
  const after = act(c, { chatId: 'c2', points: [{ x: 350, y: 300 }] });
  await flush();
  await after.done;
  assert.equal(w.calls.at(-1)[0], 'hide');
  assert.equal(c.parked, null);
});

test('a click whose page was never set going has nothing to park: its report or dispatch hides the overlay', async () => {
  const { e, t, c } = approachRig();
  const a = act(c);
  await flush();
  // the page is loaded and shown, but the start (insertCSS and one frame) has not happened yet
  const w = e.windows[0];
  assert.equal(c.dispatched({ chatId: 'c1', token: a.token }), true);
  assert.equal(c.parked, null);
  assert.equal(w.calls.at(-1)[0], 'hide');
  assert.equal(t.pending.size, 0);
  await a.done;
});

test('the press keyframe of a page that lives PARK_MS past the press lands within a millisecond of the press', () => {
  const { approachHtml } = require('../electron/capabilities/phantomCursorPages.cjs');
  for (const pressAtMs of [1, 120, 300, 641.7]) {
    const plan = { ...plan0(), pressAtMs, totalMs: pressAtMs + 6 };
    const html = approachHtml({ plan, press: true, holdMs: PARK_MS });
    const at = Number(/@keyframes disc\{0%\{opacity:0\}([\d.]+)%/.exec(html)![1]);
    assert.ok(Math.abs((at / 100) * (pressAtMs + PARK_MS) - pressAtMs) < 1, `${pressAtMs}: ${at} %`);
  }
});
function plan0() {
  return planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: WIN.width, height: WIN.height } });
}
