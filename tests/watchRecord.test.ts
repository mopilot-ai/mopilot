// electron/capabilities/watchRecord.cjs, watchRecordPill.cjs and electron/capabilities/watchRecordService.cjs: Record a skill. One recording at a time, owned by the chat that
// started it; the helper's events are kept while the pill shows; Done, Discard, the time limit, the helper quitting or the app quitting end it once.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WatchRecorder, MAX_EVENTS, MAX_MS, WARN_MS, NEEDS_ACCESSIBILITY } = require('../electron/capabilities/watchRecord.cjs');
const { isHistoryBlock } = await import('../shared/computerHistory.mjs');

const MAIL = { bundleId: 'com.apple.mail', name: 'Mail' };

/** The computer-use helper as the recorder uses it: requests it was sent, and events it can emit. */
function fakeHelper(fail: Record<string, any> = {}) {
  const h: any = Object.assign(new EventEmitter(), {
    calls: [] as string[],
    call: async (method: string) => {
      h.calls.push(method);
      if (fail[method]) throw fail[method];
      return { ok: true };
    },
  });
  return h;
}

function setup(o: { helper?: any; pill?: any; maxMs?: number; warnMs?: number } = {}) {
  const clock = { t: 1_000_000 };
  const helper = o.helper === undefined ? fakeHelper() : o.helper;
  const log: any = { shown: 0, hidden: 0, updates: [] as any[], done: [] as any[], changes: 0, notes: [] as string[] };
  const pill = o.pill ?? {
    available: true,
    show: () => log.shown++,
    hide: () => log.hidden++,
    update: (c: string, w: string) => log.updates.push([c, w]),
  };
  const recorder = new WatchRecorder({
    helper,
    pill,
    onDone: (r: any) => log.done.push(r),
    onChange: () => log.changes++,
    note: (what: string) => log.notes.push(what),
    now: () => clock.t,
    maxMs: o.maxMs,
    warnMs: o.warnMs,
  });
  return { recorder, helper, log, clock };
}

test('start: the helper records, the pill shows, the state names the chat; a second start is refused', async () => {
  const { recorder, helper, log, clock } = setup();
  assert.deepEqual(recorder.state, { recording: false, chatId: null, startedAt: null });
  assert.deepEqual(await recorder.start('c1'), { ok: true });
  assert.deepEqual(helper.calls, ['record.start']);
  assert.equal(log.shown, 1);
  assert.deepEqual(recorder.state, { recording: true, chatId: 'c1', startedAt: clock.t });
  assert.deepEqual(log.updates[0], ['0:00', ''], 'the clock starts at once');
  assert.equal(log.changes, 1);
  assert.deepEqual(await recorder.start('c2'), { ok: false, error: 'A recording is already running' });
  await recorder.discard();
});

test('start: two starts at once record once', async () => {
  const { recorder } = setup();
  const [a, b] = await Promise.all([recorder.start('c1'), recorder.start('c2')]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  await recorder.discard();
});

test('start: no pill, a helper without the permission, a helper that fails, and a pill that cannot show', async () => {
  const noPill = setup({ pill: { available: false } });
  assert.equal((await noPill.recorder.start('c1')).ok, false);

  const denied = setup({
    helper: fakeHelper({
      'record.start': Object.assign(new Error('accessibility permission not granted'), { reason: 'permission_denied' }),
    }),
  });
  assert.deepEqual(await denied.recorder.start('c1'), { ok: false, error: NEEDS_ACCESSIBILITY });
  assert.equal(denied.helper.listenerCount('record'), 0, 'no listener is left behind');
  assert.equal(denied.helper.listenerCount('exit'), 0);
  assert.equal(denied.recorder.state.recording, false);

  const broken = setup({ helper: fakeHelper({ 'record.start': new Error('the helper is gone') }) });
  const r = await broken.recorder.start('c1');
  assert.equal(r.ok, false);
  assert.match(r.error, /helper is gone/);

  const failing: any = {
    available: true,
    show: () => {
      throw new Error('no window');
    },
    hide: () => {},
    update: () => {},
  };
  const noShow = setup({ pill: failing });
  const s = await noShow.recorder.start('c1');
  assert.equal(s.ok, false);
  assert.equal(noShow.recorder.state.recording, false);
  assert.deepEqual(noShow.helper.calls, ['record.start', 'record.stop'], 'the helper is told to stop');
  assert.deepEqual(noShow.log.done, []);
});

test('done: the events become a block for the chat that started it; the pill and listeners go; the helper is told to stop', async () => {
  const { recorder, helper, log, clock } = setup();
  await recorder.start('c1');
  helper.emit('record', {
    t: 100,
    kind: 'click',
    app: MAIL,
    button: 'left',
    count: 1,
    x: 1,
    y: 2,
    element: { role: 'AXButton', label: 'Send' },
  });
  helper.emit('record', { t: 900, kind: 'key', app: MAIL, text: 'hi' });
  helper.emit('record', null);
  helper.emit('record', { kind: 'click' });
  clock.t += 65_000;
  await recorder.done();
  assert.deepEqual(helper.calls, ['record.start', 'record.stop']);
  assert.equal(log.hidden, 1);
  assert.equal(helper.listenerCount('record'), 0);
  assert.equal(helper.listenerCount('exit'), 0);
  assert.equal(recorder.state.recording, false);
  const [result] = log.done;
  assert.equal(result.chatId, 'c1');
  assert.equal(result.steps, 2);
  assert.equal(result.durationMs, 65_000);
  assert.equal(result.limit, false);
  assert.ok(isHistoryBlock(result.block));
  assert.match(result.block, /over 1 min 5 s/);
  assert.match(result.block, /Click button "Send" in Mail/);
  // events after the end are ignored, and a second Done does nothing
  helper.emit('record', { t: 2000, kind: 'key', app: MAIL, text: 'late' });
  await recorder.done();
  assert.equal(log.done.length, 1);
  assert.equal(log.changes, 2);
});

test('done: a recording with nothing in it has no block', async () => {
  const { recorder, log } = setup();
  await recorder.start('c1');
  await recorder.done();
  assert.equal(log.done[0].block, null);
  assert.equal(log.done[0].steps, 0);
});

test('discard: nothing is kept or sent, whether the helper still answers or not', async () => {
  const { recorder, helper, log } = setup();
  await recorder.start('c1');
  helper.emit('record', { t: 1, kind: 'key', app: MAIL, text: 'x' });
  await recorder.discard();
  assert.deepEqual(log.done, []);
  assert.deepEqual(helper.calls, ['record.start', 'record.stop']);
  await recorder.discard();
  // the helper is not running any more: quiet; any other failure is noted
  const gone = setup({ helper: fakeHelper({ 'record.stop': Object.assign(new Error('x'), { reason: 'helper_not_running' }) }) });
  await gone.recorder.start('c1');
  await gone.recorder.discard();
  assert.deepEqual(gone.log.notes, []);
  const odd = setup({ helper: fakeHelper({ 'record.stop': new Error('boom') }) });
  await odd.recorder.start('c1');
  await odd.recorder.discard();
  assert.deepEqual(odd.log.notes, Array(3).fill('stop the recording in the helper'));
});

test('the helper quitting ends the recording with an error for the chat, without launching it again', async () => {
  const { recorder, helper, log } = setup();
  await recorder.start('c1');
  helper.emit('exit');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(helper.calls, ['record.start'], 'no record.stop is sent to a helper that is gone');
  assert.equal(recorder.state.recording, false);
  assert.deepEqual(log.done, [{ chatId: 'c1', error: 'The recording stopped because the computer-use helper quit' }]);
  assert.equal(helper.listenerCount('record'), 0);
});

test('the clock ticks every second, warns near the limit and ends the recording at it', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const { recorder, helper, log, clock } = setup({ maxMs: 60_000, warnMs: 10_000 });
    await recorder.start('c1');
    helper.emit('record', { t: 5, kind: 'key', app: MAIL, text: 'a' });
    clock.t += 5000;
    mock.timers.tick(1000);
    clock.t += 46_000;
    mock.timers.tick(1000);
    assert.deepEqual(log.updates.slice(-2), [
      ['0:05', ''],
      ['0:51', '9 s left'],
    ]);
    clock.t += 9000;
    mock.timers.tick(1000);
    await new Promise((r) => setImmediate(r));
    assert.equal(log.done.length, 1);
    assert.equal(log.done[0].limit, 'time');
    assert.equal(log.done[0].steps, 1);
    assert.equal(recorder.state.recording, false);
    // a tick after the end does nothing
    mock.timers.tick(5000);
    assert.equal(log.done.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('events past the cap are dropped and the recording says it was cut', async () => {
  const { recorder, helper, log } = setup();
  await recorder.start('c1');
  for (let i = 0; i < MAX_EVENTS + 5; i++) helper.emit('record', { t: i, kind: 'click', app: MAIL, button: 'left', count: 1, x: 1, y: 1 });
  await new Promise((r) => setImmediate(r));
  // the recording ended itself at the cap, with what it has, and says why
  assert.equal(recorder.state.recording, false);
  assert.equal(log.done.length, 1);
  assert.equal(log.done[0].limit, 'size');
  assert.equal(log.done[0].steps, MAX_EVENTS);
});

test('dispose hides the pill and discards the recording', async () => {
  const { recorder, log } = setup();
  await recorder.start('c1');
  await recorder.dispose();
  assert.equal(recorder.state.recording, false);
  assert.deepEqual(log.done, []);
  assert.ok(log.hidden >= 1);
});

test('a helper still recording from before is stopped and started again; one that will not stop is an error', async () => {
  let starts = 0;
  const stale = fakeHelper();
  stale.call = async (method: string) => {
    stale.calls.push(method);
    return method === 'record.start' ? { started: ++starts > 1 } : { stopped: true };
  };
  const a = setup({ helper: stale });
  assert.deepEqual(await a.recorder.start('c1'), { ok: true });
  assert.deepEqual(stale.calls, ['record.start', 'record.stop', 'record.start']);
  await a.recorder.discard();
  const stuck = fakeHelper();
  stuck.call = async (method: string) => (method === 'record.start' ? { started: false } : { stopped: true });
  const b = setup({ helper: stuck });
  const r = await b.recorder.start('c1');
  assert.equal(r.ok, false);
  assert.match(r.error, /still recording/);
  assert.equal(b.recorder.state.recording, false);
});

test('a stop that fails is tried again, then noted, and a pill that cannot show does not tell the chat', async () => {
  let tries = 0;
  const flaky = fakeHelper();
  flaky.call = async (method: string) => {
    flaky.calls.push(method);
    if (method === 'record.stop' && ++tries < 3) throw new Error('timed out');
    return { ok: true };
  };
  const a = setup({ helper: flaky });
  await a.recorder.start('c1');
  await a.recorder.discard();
  assert.equal(tries, 3);
  assert.deepEqual(a.log.notes, ['stop the recording in the helper', 'stop the recording in the helper']);
  const failing: any = {
    available: true,
    show: () => {
      throw new Error('no window');
    },
    hide: () => {},
    update: () => {},
  };
  const b = setup({ pill: failing });
  assert.equal((await b.recorder.start('c1')).ok, false);
  assert.deepEqual(b.log.done, [], 'the dialog says why; the chat has nothing to hear');
});

test('the recorder defaults: the real clock, the 10 minute limit and a warning 30 s before it, and no one following its state', async () => {
  const helper = fakeHelper();
  const updates: string[][] = [];
  const recorder = new WatchRecorder({
    helper,
    pill: { available: true, show: () => {}, hide: () => {}, update: (c: string, w: string) => updates.push([c, w]) },
    onDone: () => {},
    note: () => {},
  });
  assert.equal(recorder.maxMs, MAX_MS);
  assert.equal(recorder.warnMs, WARN_MS);
  assert.deepEqual(await recorder.start('c1'), { ok: true });
  assert.ok(Math.abs(recorder.state.startedAt! - Date.now()) < 5000);
  assert.deepEqual(updates[0], ['0:00', '']);
  await recorder.discard();
});
