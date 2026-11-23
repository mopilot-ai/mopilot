// The phantom cursor in the background desktop_app_* tools (#3810): a click waits for the cursor's approach before the input goes, on every
// harness the same way; Stop and a take-over end the approach without letting input through; a failing action takes its cursor away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';
import { rig, rejects } from './support/app-scoped-kit.ts';

import { inputAtOf } from './support/phantomFakes.ts';
const require = createRequire(import.meta.url);
const { AppVisibility } = require('../electron/capabilities/appVisibility.cjs');
const { PhantomCursor, FRAME_MS } = require('../electron/capabilities/phantomCursor.cjs');
const { planApproach } = require('../shared/cursorApproach.mjs');
const { SessionStore } = require('../electron/session/state.cjs');

/** A visibility whose approach stays pending until the test lets the cursor "arrive". */
function gated() {
  const log: any[] = [];
  const gates: (() => void)[] = [];
  const v = {
    log,
    gates,
    thumbnailDue: () => false,
    acted: (chatId: string, info: any) => log.push(['acted', chatId, info.action]),
    approach: (chatId: string, info: any) => {
      log.push(['approach', chatId, info.action, info.points, info.bounds, info.state, info.app.bundleId]);
      return new Promise<void>((resolve) => gates.push(resolve));
    },
    interrupted: (chatId: string) => {
      log.push(['interrupted', chatId]);
      for (const g of gates.splice(0)) g();
    },
  };
  return v;
}

test('a click waits for the cursor to arrive, then the input goes; the same for every harness', async () => {
  for (const harness of ['claude', 'codex', 'acp', 'claude-switched-to-codex']) {
    const v = gated();
    const r = rig({ apps: { visibility: v } });
    r.cu.harness = () => harness;
    await r.shoot();
    v.log.length = 0;
    const done = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
    await waitFor(() => v.gates.length === 1, 'the approach');
    assert.equal(r.callsOf('app.click').length, 0, `${harness}: no input while the cursor is on its way`);
    assert.deepEqual(v.log[0].slice(0, 3), ['approach', 'c1', 'click']);
    assert.deepEqual(v.log[0][3], [{ x: 220, y: 340 }]);
    assert.deepEqual(v.log[0].slice(4), [{ x: 100, y: 50, width: 500, height: 400 }, 'visible', 'com.apple.Notes']);
    v.gates.splice(0)[0]();
    await done;
    assert.equal(r.callsOf('app.click').length, 1, `${harness}: the input went after the arrival`);
    assert.deepEqual(
      v.log.map((x: any) => x[0]),
      ['approach', 'acted'],
    );
  }
});

test('a click carries the signal its visibility made to the helper, so the helper can say early that the mouse-down went out; with no signal it carries none', async () => {
  for (const signal of ['sig-1', null]) {
    const v = { ...gated(), signalFor: () => signal };
    const r = rig({ apps: { visibility: v } });
    await r.shoot();
    const done = r.call('desktop_app_click', { app: 'Notes', coordinate: [10, 10] });
    await waitFor(() => v.gates.length === 1, 'the approach');
    v.gates.splice(0)[0]();
    await done;
    const [click] = r.callsOf('app.click');
    assert.equal(click.params.signal, signal ?? undefined);
  }
});

test('a drag asks for its approach with every point of its path (the visibility decides what to show)', async () => {
  const v = gated();
  const r = rig({ apps: { visibility: v } });
  await r.shoot();
  v.log.length = 0;
  const done = r.call('desktop_app_drag', { app: 'Notes', coordinate: [0, 0], to_coordinate: [200, 100] });
  await waitFor(() => v.gates.length === 1, 'the approach');
  assert.deepEqual(v.log[0].slice(0, 4), [
    'approach',
    'c1',
    'drag',
    [
      { x: 100, y: 50 },
      { x: 200, y: 100 },
    ],
  ]);
  v.gates.splice(0)[0]();
  await done;
});

test('Stop during the approach: the wait ends and no input goes', async () => {
  const v = gated();
  const r = rig({ apps: { visibility: v } });
  await r.shoot();
  const done = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await waitFor(() => v.gates.length === 1, 'the approach');
  r.apps.interrupt('c1');
  await rejects(done, 'refused', /stopped/);
  assert.equal(r.callsOf('app.click').length, 0);
  assert.ok(v.log.some((x: any) => x[0] === 'interrupted'));
  // an interrupt for a chat that never acted tells the cursor too
  r.apps.interrupt('nobody');
  assert.deepEqual(v.log.at(-1), ['interrupted', 'nobody']);
});

test('the user takes the app over during the approach: the input waits for the hand back', async () => {
  const v = gated();
  const r = rig({ apps: { visibility: v, takeoverWaitMs: 10_000 } });
  await r.shoot();
  const done = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await waitFor(() => v.gates.length === 1, 'the approach');
  r.apps.takeOver('c1', 'com.apple.Notes');
  v.gates.splice(0)[0]();
  await waitFor(() => (r.apps.held.get('com.apple.notes')?.waiters.size ?? 0) === 1, 'the wait for the hand back');
  assert.equal(r.callsOf('app.click').length, 0, 'no input while the user has the app');
  r.apps.handBack('c1', 'com.apple.Notes');
  await done;
  assert.equal(r.callsOf('app.click').length, 1);
});

test('an action that fails takes its cursor away; one that never needed a visibility is fine', async () => {
  const v = gated();
  const r = rig({ apps: { visibility: v } });
  await r.shoot();
  r.helper.fail['app.click'] = new Error('boom');
  const done = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await waitFor(() => v.gates.length === 1, 'the approach');
  v.gates.splice(0)[0]();
  await assert.rejects(done);
  assert.deepEqual(v.log.at(-1), ['interrupted', 'c1']);
  const plain = rig();
  await plain.shoot();
  await plain.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  assert.equal(plain.callsOf('app.click').length, 1);
});

test('with the real cursor: the click goes when the plan says, from the line back to the previous click; Stop clears it', async () => {
  const windows: any[] = [];
  const pending = new Map<number, { fn: Function; ms: number }>();
  let id = 0;
  class BrowserWindow {
    calls: any[] = [];
    constructor() {
      windows.push(this);
    }
    webContents = { insertCSS: () => Promise.resolve('key') };
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    setBounds() {}
    showInactive() {}
    hide() {
      this.calls.push('hide');
    }
    isDestroyed() {
      return false;
    }
    loadURL(url: string) {
      this.calls.push(url);
      return Promise.resolve();
    }
  }
  const timers = {
    setTimeout: (fn: Function, ms: number) => (pending.set(++id, { fn, ms }), id),
    clearTimeout: (t: number) => pending.delete(t),
  };
  const sessions = new SessionStore();
  const cursor = new PhantomCursor({ electron: { BrowserWindow }, timers, reducedMotion: () => false });
  const visibility = new AppVisibility({
    sessions: { get: (i: string) => sessions.get(i), patch: (i: string, p: any) => sessions.patch(i, p) },
    cursor,
  });
  const r = rig({ apps: { visibility } });
  await r.shoot();
  const bounds = { x: 0, y: 0, width: 500, height: 400 };
  const first = planApproach({ to: { x: 120, y: 290 }, bounds });
  const fire = (ms: number) => {
    for (const [k, p] of [...pending]) if (p.ms === ms) pending.delete(k), p.fn();
  };
  const arrive = async (ms: number) => {
    // the plan's clock starts one frame after the page was set going
    await waitFor(() => (fire(FRAME_MS), [...pending.values()].some((p) => p.ms === ms)), `a timer at ${ms}`);
    for (const [k, p] of [...pending]) if (p.ms === ms) pending.delete(k), p.fn();
  };
  // 1: the first click of the chat in the app: the lower-left start, the input after press time
  const click1 = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await arrive(inputAtOf(first));
  await click1;
  assert.equal(r.callsOf('app.click').length, 1);
  assert.notEqual(
    windows[0].calls.at(-1),
    'hide',
    'the cursor stays on its point when the click reported (it leaves with the next action or the end of the turn)',
  );
  // 2: another point: it comes in along the line back to the first one
  const html2 = () =>
    decodeURIComponent(
      windows[0].calls
        .filter((c: string) => c.startsWith('data:'))
        .at(-1)
        .replace(/^data:text\/html;charset=utf-8,/, ''),
    );
  const click2 = r.call('desktop_app_click', { app: 'Notes', coordinate: [20, 20] });
  await waitFor(() => windows[0].calls.length > 1, 'the second page');
  assert.match(
    html2(),
    /@keyframes glide\{from\{transform:translate\(63px,148px\)\}/,
    'on the line back to the previous click (120, 290), clipped to 140 pt, direction kept',
  );
  // Stop mid-approach: the cursor is hidden and the click never goes
  r.apps.interrupt('c1');
  await rejects(click2, 'refused', /stopped/);
  assert.equal(r.callsOf('app.click').length, 1);
  assert.equal(windows[0].calls.at(-1), 'hide');
});
