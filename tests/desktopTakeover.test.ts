// The desktop_* tools while the user has taken over the screen (#1902, #1905): input waits for "Done, continue" outside the
// queue, an action cut short says the user took over, and an Allow on the chat's card hands the desktop back first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, NOTES } from './support/desktop-kit.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { DesktopTakeover, waitForHandBack, isTakeoverError, handedBack } = require('../electron/capabilities/tools/takeoverWait.cjs');

async function until(f: () => boolean) {
  await waitFor(f, 'the condition');
  assert.ok(f(), 'the condition never held');
}
const TAKEOVER = { reason: 'paused', message: 'paused by the user (takeover); resume first' };
const HANDED_BACK = /^The user took over the mouse and keyboard and handed it back\. Nothing more was done/;

/** A chat holding the screen with Notes granted, its screenshot taken, and the screen-control consent given. */
async function holding() {
  const r = rig();
  await r.ready([NOTES]);
  r.d.session('c1').consent = true;
  await r.call('desktop_mouse_move', { coordinate: [10, 10] });
  assert.equal(r.cu.controlling, 'c1');
  r.helper.calls.length = 0;
  return r;
}

test('DesktopTakeover: begin, end and wait for one chat; a hand back wakes every waiter; Stop, an abort and the cap', async () => {
  const t = new DesktopTakeover({ ms: 10_000 });
  assert.equal(await t.wait('c1', null), false, 'not taken over: no wait');
  t.begin('c1');
  assert.deepEqual([t.is('c1'), t.is('c2'), t.is('')], [true, false, false]);
  const a = t.wait('c1', null);
  const b = t.wait('c1', undefined);
  t.end('c2');
  assert.equal(t.waiters.size, 2, "another chat's end leaves it");
  t.end('c1');
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(t.is('c1'), false);
  t.begin('c1');
  const stopped = t.wait('c1', null);
  t.end('c1', new Error('stopped'));
  await assert.rejects(stopped, /stopped/);
  // an aborted call, before and during the wait
  const ac = new AbortController();
  t.begin('c1');
  const aborted = t.wait('c1', ac.signal);
  ac.abort();
  await assert.rejects(aborted, (e: any) => e.code === 'refused' && /Stopped by the user/.test(e.message));
  await assert.rejects(t.wait('c1', ac.signal), (e: any) => e.code === 'refused');
  assert.equal(t.waiters.size, 0);
  // the cap
  await assert.rejects(waitForHandBack(new Set(), { ms: 1, capMessage: 'cap' }), (e: any) => e.code === 'busy' && e.message === 'cap');
  const capped = new DesktopTakeover({ ms: 1 });
  capped.begin('c1');
  await assert.rejects(capped.wait('c1'), (e: any) => e.code === 'busy' && /hasn't handed them back/.test(e.message));
  assert.equal(new DesktopTakeover().ms, 600_000);
  // what counts as a take-over: the guard's pause (not Esc's) and an action it cut short
  assert.deepEqual(
    [
      TAKEOVER,
      { reason: 'paused', message: 'paused by the user (escape); resume first' },
      { reason: 'aborted' },
      { reason: 'busy' },
      null,
    ].map(isTakeoverError),
    [true, false, true, false, false],
  );
  assert.equal(handedBack('Notes').code, 'changed');
});

test('desktop input while the user has taken over waits for Done, continue outside the queue, then runs (#1905)', async () => {
  const r = await holding();
  r.cu.paused('takeover');
  assert.deepEqual(r.activity.at(-1), ['c1', { app: r.cu.app, state: 'takeover' }]);
  const click = r.call('desktop_left_click', { coordinate: [100, 100] });
  await until(() => r.cu.takeover.waiters.size === 1);
  // looking still works meanwhile: the wait does not hold the queue
  await r.call('desktop_screenshot');
  assert.equal(r.callsOf('click').length, 0);
  assert.equal(await r.cu.resume('c1'), true);
  assert.deepEqual(
    r.methods().filter((m: string) => m === 'resumeControl'),
    ['resumeControl'],
  );
  await click;
  assert.equal(r.callsOf('click').length, 1);
});

test('a desktop click cut short by a take-over waits, then says the user took over; a batch stops at the next step (#1905)', async () => {
  const r = await holding();
  const click = r.helper.click;
  let cut = true;
  r.helper.click = async (...a: any[]) => {
    if (!cut) return click(...a);
    cut = false;
    throw TAKEOVER;
  };
  const once = r.call('desktop_left_click', { coordinate: [100, 100] });
  await until(() => r.cu.takeover.waiters.size === 1);
  assert.equal(r.activity.at(-1)[1].state, 'takeover');
  await r.cu.resume('c1');
  await assert.rejects(once, (e: any) => e.code === 'changed' && HANDED_BACK.test(e.message));
  // in a batch: the user takes over after the first click; the second waits, and the batch ends there with a screenshot
  r.helper.click = async (...a: any[]) => {
    const out = await click(...a);
    if (r.callsOf('click').length === 1) r.cu.paused('takeover');
    return out;
  };
  r.helper.calls.length = 0;
  const batch = r.call('desktop_batch', {
    actions: [
      { action: 'left_click', coordinate: [100, 100] },
      { action: 'left_click', coordinate: [120, 100] },
    ],
  });
  await until(() => r.cu.takeover.waiters.size === 1);
  await r.cu.resume('c1');
  const out = await batch;
  const summary = JSON.parse(out[0].text);
  assert.deepEqual([summary.completed, summary.stoppedAt], [1, 1]);
  assert.match(summary.results[1].reason, HANDED_BACK);
  assert.equal(r.callsOf('click').length, 1);
  assert.ok(
    out.some((c: any) => c.type === 'image'),
    'the screenshot after the batch',
  );
  // Stop while it waits: stopped, never "took over"
  r.cu.paused('takeover');
  const stopped = r.call('desktop_left_click', { coordinate: [100, 100] });
  await until(() => r.cu.takeover.waiters.size === 1);
  await r.cu.stop('c1');
  await assert.rejects(stopped, /stopped/);
});

test('an Allow on the confirm card or the access card while taken over hands the desktop back before the action (#1902)', async () => {
  const r = await holding();
  r.cu.paused('takeover');
  // the Send button: confirmed every time
  await r.call('desktop_left_click', { element_index: 1 });
  const m = r.methods();
  assert.ok(m.indexOf('resumeControl') >= 0 && m.indexOf('resumeControl') < m.indexOf('axPress'), m.join());
  assert.equal(r.cu.takeover.is('c1'), false);
  // declined: still the user's, and the action fails as declined
  r.cu.paused('takeover');
  r.answers.computerConfirm = { decision: 'deny' };
  await assert.rejects(r.call('desktop_left_click', { element_index: 1 }), (e: any) => e.code === 'denied');
  assert.equal(r.cu.takeover.is('c1'), true);
  // a second app's access card, raised mid-turn
  const before = r.callsOf('resumeControl').length;
  await r.grant([{ ...NOTES, name: 'Mail', bundleId: 'com.apple.mail', pid: 9 }]);
  assert.equal(r.callsOf('resumeControl').length, before + 1);
  assert.equal(r.cu.takeover.is('c1'), false);
  // nothing granted: nothing handed back
  r.cu.paused('takeover');
  r.answers.computerAccessSet = { decision: 'deny' };
  await r.grant([{ ...NOTES, name: 'Maps', bundleId: 'com.apple.maps', pid: 11 }]);
  assert.equal(r.cu.takeover.is('c1'), true);
});

test('the screen-control card: its Allow hands back a take-over too', async () => {
  const r = await holding();
  r.d.session('c1').consent = false;
  r.cu.paused('takeover');
  await r.call('desktop_left_click', { coordinate: [100, 100] });
  assert.ok(r.asks.some((a: any) => a.kind === 'computerTakeover'));
  assert.equal(r.cu.takeover.is('c1'), false);
  assert.equal(r.callsOf('click').length, 1);
});
