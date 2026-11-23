// The phantom cursor's clock starts when its page is really set going, not when it loaded: the click waits for that start, the arrival and the hover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { flush, approachRig, act, ACT, WIN, inputAtOf, playedAtOf } from './support/phantomFakes.ts';

const require = createRequire(import.meta.url);
const { approachHtml, FRAME_MS, RUN_CSS, LOAD_WAIT_MS } = require('../electron/capabilities/phantomCursor.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const { planApproach } = require('../shared/cursorApproach.mjs');
const plan = planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } });
const has = (t: { delays: Map<number, number>; pending: Map<number, Function> }, ms: number) =>
  [...t.pending.keys()].some((k) => t.delays.get(k) === ms);

test('the page is rendered paused and RUN_CSS is the only thing that sets it going (no script)', () => {
  const html = approachHtml({ plan, press: true });
  assert.match(html, /\.cur,\.arrow,\.disc\{animation-play-state:paused\}<\/style>/);
  assert.equal(RUN_CSS, '.cur,.arrow,.disc{animation-play-state:running !important}');
  assert.doesNotMatch(html, /<script|animation-play-state:running/);
});

test('the click is timed from the animation start: a late insertCSS delays arrival, hover and press with it', async () => {
  const { e, t, c } = approachRig();
  const { done } = act(c);
  const w = e.windows[0];
  w.cssMode = 'late';
  await flush();
  assert.equal(
    w.calls.some((x: any) => x[0] === 'insertCSS'),
    true,
  );
  assert.equal(w.cssWaiting.length, 1);
  // the page loaded and is shown, but not running: no frame wait, no press timer, so the click cannot go
  assert.equal(has(t, FRAME_MS), false);
  assert.equal(has(t, inputAtOf(plan)), false);
  let went = false;
  done.then(() => (went = true));
  await flush();
  assert.equal(went, false);
  // the animation starts a late while after load: only now do the frame and the plan's clock begin
  w.releaseCss();
  await flush();
  assert.equal(has(t, FRAME_MS), true);
  assert.equal(has(t, inputAtOf(plan)), false, 'one frame is still to pass');
  assert.equal(has(t, LOAD_WAIT_MS), true, 'the cap holds until the clock runs');
  t.fireAt(FRAME_MS);
  assert.equal(has(t, LOAD_WAIT_MS), false);
  assert.equal(has(t, inputAtOf(plan)), true);
  assert.equal(has(t, playedAtOf(plan)), true);
  await flush();
  assert.equal(went, false, 'arrival and hover are still to come');
  t.fireAt(inputAtOf(plan));
  await done;
  assert.equal(went, true);
});

test('a start that never comes, fails or throws ends with no cursor at the cap and the click goes on', async () => {
  for (const mode of ['pending', 'reject', 'throw'] as const) {
    const { e, t, c } = approachRig();
    const { done } = act(c);
    e.windows[0].cssMode = mode;
    const w = e.windows[0];
    await flush();
    assert.equal(has(t, inputAtOf(plan)), false, mode);
    assert.equal(has(t, FRAME_MS), false, mode);
    t.fireAt(LOAD_WAIT_MS);
    await done;
    assert.equal(c.active, null, mode);
    assert.equal(w.calls.at(-1)[0], 'hide', mode);
    assert.equal(t.pending.size, 0, mode);
  }
});

test('a Stop while the page is being set going starts no clock when the start answers', async () => {
  const { e, t, c } = approachRig();
  const { done } = act(c);
  const w = e.windows[0];
  w.cssMode = 'late';
  await flush();
  c.cancel('c1');
  await done;
  w.releaseCss();
  await flush();
  assert.equal(t.pending.size, 0);
  assert.equal(has(t, FRAME_MS), false);
});

test('a plain press-free action runs the same way: the arrow is told to go and the action does not wait', async () => {
  const { e, t, c } = approachRig();
  let went = false;
  c.approach({ ...ACT, kind: 'type' }).then(() => (went = true));
  await flush();
  assert.equal(went, true);
  assert.equal(e.windows[0].calls.at(-1)[0], 'insertCSS');
  t.fireAt(FRAME_MS);
  assert.equal(has(t, inputAtOf(plan)), false);
  assert.equal(has(t, plan.totalMs), true, 'a press-free action plays to the plan’s end');
});

test('each approach is its own document and its start goes to that document, never to an older page still settling', async () => {
  const { e, t, c } = approachRig();
  const first = act(c);
  const w = e.windows[0];
  await flush();
  const urls = () => w.calls.filter((x: any) => x[0] === 'loadURL').map((x: any) => x[1]);
  assert.equal(w.calls.filter((x: any) => x[0] === 'insertCSS').length, 1);
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(plan));
  await first.done;
  // the click is confirmed and the cursor hides; the next click comes and loadURL answers for the older navigation
  c.finish({ chatId: 'c1', confirmed: true, token: first.token });
  w.loadMode = 'stale';
  const second = act(c);
  await flush();
  assert.equal(urls().length, 2, 'approach, approach');
  assert.notEqual(urls()[0], urls()[1], 'the same target twice is still a new document');
  assert.equal(w.calls.filter((x: any) => x[0] === 'insertCSS').length, 1, 'no start while the new page is not the one showing');
  assert.equal(has(t, FRAME_MS), false);
  // an older page finishing is not this page: still no start
  w.committed = 'data:text/html,older';
  for (const f of [...w.listeners]) f();
  assert.equal(w.calls.filter((x: any) => x[0] === 'insertCSS').length, 1);
  w.commit();
  await flush();
  assert.equal(w.calls.filter((x: any) => x[0] === 'insertCSS').length, 2, 'the start goes once the new page is in');
  assert.equal(w.committed, urls()[1]);
  assert.equal(w.listeners.size, 0);
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(plan));
  await second.done;
});

test('a start that lands after another page took over is not timed, a Stop drops the wait, and an unreadable URL does not block', async () => {
  const { e, t, c } = approachRig();
  const { done } = act(c);
  const w = e.windows[0];
  w.cssMode = 'late';
  await flush();
  w.committed = 'data:text/html,other';
  w.releaseCss();
  await flush();
  assert.equal(has(t, FRAME_MS), false, 'the signal landed on a different page');
  t.fireAt(LOAD_WAIT_MS);
  await done;
  // a wait for a page that never comes is dropped by the hide
  const r2 = approachRig();
  r2.e.windows.length = 0;
  const a2 = act(r2.c);
  const w2 = r2.e.windows[0];
  w2.loadMode = 'stale';
  r2.c.cancel('c1');
  await a2.done;
  const b2 = act(r2.c);
  await flush();
  assert.equal(w2.listeners.size, 1);
  r2.c.cancel('c1');
  assert.equal(w2.listeners.size, 0);
  await b2.done;
  // getURL missing, throwing or non-string: the start goes on as before
  for (const getURL of [
    undefined,
    () => {
      throw new Error('gone');
    },
    () => 5,
  ]) {
    const r = approachRig();
    const a = act(r.c);
    const w3 = r.e.windows[0];
    (w3.webContents as any).getURL = getURL;
    await flush();
    assert.equal(
      w3.calls.some((x: any) => x[0] === 'insertCSS'),
      true,
      'an unreadable URL does not block the start',
    );
    assert.equal(has(r.t, FRAME_MS), true, 'and the clock runs');
    r.c.cancel('c1');
    await a.done;
  }
  // a readable URL without the nonce does not start: it waits for the cap
  const r5 = approachRig();
  const a5 = act(r5.c);
  const w5 = r5.e.windows[0];
  w5.loadMode = 'stale';
  w5.committed = 'data:text/html,other';
  await flush();
  assert.equal(
    w5.calls.some((x: any) => x[0] === 'insertCSS'),
    false,
  );
  assert.equal(has(r5.t, LOAD_WAIT_MS), true);
  r5.t.fireAt(LOAD_WAIT_MS);
  await a5.done;
  assert.equal(
    w5.calls.some((x: any) => x[0] === 'insertCSS'),
    false,
  );
  // wc.on throws: the wait is skipped, the cap ends the action
  const r4 = approachRig();
  const a4 = act(r4.c);
  const w4 = r4.e.windows[0];
  w4.loadMode = 'stale';
  w4.webContents.on = () => {
    throw new Error('no events');
  };
  r4.c.cancel('c1');
  await a4.done;
  clearIgnored();
  const b4 = act(r4.c);
  await flush();
  assert.equal(r4.c.listeners.length, 0, 'no listener was kept');
  assert.equal(r4.c.active !== null, true, 'the action waits');
  assert.equal(
    w4.calls.some((x: any) => x[0] === 'insertCSS'),
    false,
  );
  assert.equal(
    recentIgnored().some((x: any) => x.context === 'wait for the phantom cursor page'),
    true,
  );
  r4.t.fireAt(LOAD_WAIT_MS);
  await b4.done;
  assert.equal(r4.c.active, null);
});

test('a cap that fires while the start waits for its page marker is recorded (a URL head only), an unreadable URL is not', async () => {
  clearIgnored();
  const { e, t, c } = approachRig();
  const { done } = act(c);
  const w = e.windows[0];
  w.loadMode = 'stale';
  w.committed = `data:text/html,${'secret-user-text-'.repeat(10)}`;
  await flush();
  t.fireAt(LOAD_WAIT_MS);
  await done;
  const hit = recentIgnored().filter((x: any) => x.context === 'phantom cursor: the overlay page never showed its start marker');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].message.replace(/…$/, '').length <= 60, true);
  assert.equal(hit[0].message.includes('secret-user-text-secret-user-text-secret-user-text-secret'), false);
  clearIgnored();
  const r = approachRig();
  const a = act(r.c);
  r.e.windows[0].loadMode = 'stale';
  (r.e.windows[0].webContents as any).getURL = () => {
    throw new Error('gone');
  };
  await flush();
  r.t.fireAt(LOAD_WAIT_MS);
  await a.done;
  assert.equal(
    recentIgnored().some((x: any) => x.context.includes('start marker')),
    false,
  );
});

test('a nonce is not matched by a longer one that starts with it', async () => {
  const { e, t, c } = approachRig();
  const first = act(c);
  const w = e.windows[0];
  w.loadMode = 'stale';
  c.cancel('c1');
  await first.done;
  const { done } = act(c);
  await flush();
  const mine = /n[0-9a-z]+x[0-9a-z]+_?/.exec(decodeURIComponent(w.calls.filter((x: any) => x[0] === 'loadURL').at(-1)[1]))![0];
  const longer = mine.endsWith('_') ? `${mine.slice(0, -1)}0_` : `${mine}0`;
  w.committed = `data:text/html,/* ${longer} */`;
  for (const f of [...w.listeners]) f();
  await flush();
  assert.equal(
    w.calls.some((x: any) => x[0] === 'insertCSS'),
    false,
  );
  t.fireAt(LOAD_WAIT_MS);
  await done;
});

test('a drag shown over a waiting approach page drops the wait, and a wait that fires for an ended action starts nothing', async () => {
  const { e, c } = approachRig();
  const first = act(c);
  const w = e.windows[0];
  w.loadMode = 'stale';
  c.cancel('c1');
  await first.done;
  const { done } = act(c);
  await flush();
  assert.equal(w.listeners.size, 1);
  const listener = [...w.listeners][0];
  const was = c.active;
  const url = w.wanted;
  c.active.played = true;
  assert.equal(
    c.show({
      bounds: WIN,
      points: [
        { x: 300, y: 250 },
        { x: 320, y: 260 },
      ],
    }),
    true,
  );
  assert.equal(w.listeners.size, 0, 'show dropped the wait');
  await done;
  // the wait's callback re-checks its action: with none active nothing is revealed or started
  w.listeners.add(listener);
  c.active = null;
  w.calls.length = 0;
  w.wanted = url;
  w.commit();
  assert.equal(
    w.calls.some((x: any) => x[0] === 'showInactive' || x[0] === 'insertCSS'),
    false,
  );
  // and the same for a start whose generation moved on
  w.listeners.add(listener);
  c.active = was;
  c.generation++;
  w.wanted = url;
  w.commit();
  assert.equal(
    w.calls.some((x: any) => x[0] === 'showInactive' || x[0] === 'insertCSS'),
    false,
  );
});

test('a wait whose listener cannot be removed (the window went away) is dropped quietly', async () => {
  const { e, c } = approachRig();
  const a = act(c);
  const w = e.windows[0];
  w.loadMode = 'stale';
  c.cancel('c1');
  await a.done;
  const b = act(c);
  await flush();
  w.webContents.removeListener = () => {
    throw new Error('destroyed');
  };
  c.cancel('c1');
  await b.done;
  assert.equal(c.listeners.length, 0);
});
