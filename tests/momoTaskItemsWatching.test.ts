// MoMo watching items (shared/momoTasks/watching.ts): a model-free check with a next time, a change that tells the user once, busy and broken sources, and a stop during a read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskRefusal } from '../shared/momoTasks/manager.ts';
import { readItems, WatchRetryError } from '../shared/momoTasks/watch.ts';
import { ask, world } from './support/momoTaskItems/world.ts';

const refusal = (code: string) => (e: unknown) => e instanceof TaskRefusal && e.code === code;
const WATCH = {
  title: 'AWS invoice due today',
  doneMeans: 'Tell me when it changes',
  origin: 'matter' as const,
  watch: { kind: 'tool', tool: 'gmail.search', track: ['id', 'status'], everyMinutes: 30 },
};

const gate = () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  return { hold, release };
};
const tick = () => new Promise((r) => setImmediate(r));

test('a watch is made with a next check, refuses what it cannot check, and stays out of the session path', async () => {
  const { w, mgr, store } = world();
  const item = await mgr.createWatch(WATCH);
  assert.deepEqual(
    [item.state, item.nextCheck, item.where.sessionId, item.watch?.watch.everyMinutes],
    ['watching', item.createdAt + 2000, null, 30],
  );
  assert.equal(w.started.length, 0);
  assert.equal((await mgr.createWatch(WATCH)).id, item.id);
  await assert.rejects(mgr.createWatch({ ...WATCH, watch: { kind: 'command' } }), refusal('bad_watch'));
  w.readOnly = false;
  await assert.rejects(
    mgr.createWatch({ ...WATCH, title: 'x' }),
    (e: unknown) => e instanceof TaskRefusal && e.code === 'bad_watch' && /cannot ask for approval/.test(e.message),
  );
  await assert.rejects(mgr.createWatch({ ...WATCH, callerItemId: 'task1' }), refusal('nested'));
  await assert.rejects(mgr.start(item.id), refusal('bad_state'));
  // an HTTPS page needs no tool check; a tool with no reader wired is refused
  assert.equal(
    (await mgr.createWatch({ ...WATCH, title: 'page', watch: { kind: 'http', url: 'https://status.example.com/x' } })).state,
    'watching',
  );
  const bare = world({ withReader: false });
  await assert.rejects(bare.mgr.createWatch(WATCH), refusal('bad_watch'));
  assert.equal((await store.list()).length, 2);
});

test('checking: baseline, unchanged with the next time, then a change tells the user once and waits for them', async () => {
  const { w, mgr, advance } = world();
  const item = await mgr.createWatch(WATCH);
  const reading = (status: string) => readItems({ rows: [{ id: 'inv1', status, subject: 'AWS invoice' }] }, ['id', 'status']);
  w.readings.push(reading('open'), reading('open'), reading('due'));
  assert.deepEqual(await mgr.tick(), { checked: 0, changed: 0, failed: 0, retrying: 0, undelivered: 0 });
  advance(2000);
  assert.deepEqual(await mgr.tick(), { checked: 1, changed: 0, failed: 0, retrying: 0, undelivered: 0 });
  let cur = await mgr.get(item.id);
  assert.deepEqual([cur?.state, cur?.watch?.state?.outcome, cur?.nextCheck], ['watching', 'baseline', cur!.updatedAt + 30 * 60_000]);
  advance(30 * 60_000);
  await mgr.tick();
  assert.equal((await mgr.get(item.id))?.watch?.state?.outcome, 'unchanged');
  advance(30 * 60_000);
  assert.deepEqual(await mgr.tick(), { checked: 1, changed: 1, failed: 0, retrying: 0, undelivered: 0 });
  cur = await mgr.get(item.id);
  assert.deepEqual([cur?.state, cur?.progress, cur?.nextCheck], ['needs_you', 'Updated: AWS invoice', null]);
  assert.deepEqual(w.notices, [{ itemId: item.id, title: 'AWS invoice due today', detail: 'Updated: AWS invoice', machineId: 'home' }]);
  assert.equal(w.reads, 3);
  // nothing more is read while it waits for the user; Keep watching schedules the next check
  advance(60 * 60_000);
  assert.equal((await mgr.tick()).checked, 0);
  assert.equal((await mgr.resume(item.id)).state, 'watching');
  assert.equal((await mgr.get(item.id))?.nextCheck, (await mgr.get(item.id))!.updatedAt + 2000);
});

test('a change with nothing to describe still says what changed; a chat that cannot be told does not lose the change', async () => {
  const { w, mgr, advance } = world();
  const item = await mgr.createWatch({ ...WATCH, title: 'Page', watch: { kind: 'tool', tool: 'x', everyMinutes: 5 } });
  w.readings.push({ fingerprint: 'a' }, { fingerprint: 'b' });
  advance(2000);
  await mgr.tick();
  advance(5 * 60_000);
  w.noticeFails = true;
  assert.deepEqual(await mgr.tick(), { checked: 1, changed: 1, failed: 0, retrying: 0, undelivered: 1 });
  const cur = await mgr.get(item.id);
  assert.deepEqual([cur?.state, cur?.progress], ['needs_you', 'x changed.']);
});

test('a busy source is read again in a minute without a failure; a broken check pauses the watch and says why', async () => {
  const { w, mgr, advance } = world();
  const item = await mgr.createWatch(WATCH);
  advance(2000);
  w.readings.push(new WatchRetryError('busy'));
  assert.deepEqual(await mgr.tick(), { checked: 0, changed: 0, failed: 0, retrying: 1, undelivered: 0 });
  let cur = await mgr.get(item.id);
  assert.deepEqual(
    [cur?.state, cur?.nextCheck, cur?.watch?.retryAt],
    ['watching', 2000 + item.createdAt + 60_000, 2000 + item.createdAt + 60_000],
  );
  advance(60_000);
  w.readings.push(new Error('Gmail refused the request'));
  assert.deepEqual(await mgr.tick(), { checked: 0, changed: 0, failed: 1, retrying: 0, undelivered: 0 });
  cur = await mgr.get(item.id);
  assert.deepEqual([cur?.state, cur?.nextCheck, cur?.lastError?.code], ['failed', null, 'watch_failed']);
  assert.equal(cur?.lastError?.message, 'I stopped watching "AWS invoice due today": Gmail refused the request');
  assert.deepEqual([w.cards[0].state, w.cards[0].actions], ['failed', ['retry']]);
  assert.equal((await mgr.resume(item.id)).state, 'watching');
  // an error with no words, and a tool that stopped being read-only
  advance(60_000);
  w.readings.push(new Error(''));
  await mgr.tick();
  assert.match((await mgr.get(item.id))?.lastError?.message as string, /The check could not run\./);
  await mgr.resume(item.id);
  advance(60_000);
  w.readOnly = false;
  await mgr.tick();
  assert.match((await mgr.get(item.id))?.lastError?.message as string, /can change things/);
  // no reader wired (the home is not ready yet): the check waits, nothing fails
  const bare = world({ withReader: false });
  await bare.store.insertOrGet({ ...item, id: 'w', stableKey: 'w', state: 'watching', nextCheck: 0, lastError: null }, 5);
  assert.deepEqual(await bare.mgr.tick(), { checked: 0, changed: 0, failed: 0, retrying: 1, undelivered: 0 });
});

test('two ticks at once read a due watch once', async () => {
  const { w, mgr, advance } = world();
  await mgr.createWatch(WATCH);
  advance(2000);
  let release!: () => void;
  w.readGate = new Promise<void>((r) => (release = r));
  const a = mgr.tick();
  const b = mgr.tick();
  await new Promise((r) => setImmediate(r));
  release();
  const sums = await Promise.all([a, b]);
  assert.equal(w.reads, 1);
  assert.equal(
    sums.reduce((n, s) => n + s.checked, 0),
    1,
  );
});

test('stopping a watch removes its row; resume brings back a stopped or paused watch only', async () => {
  const { mgr } = world();
  const item = await mgr.createWatch(WATCH);
  const stopped = await mgr.stop(item.id);
  assert.deepEqual([stopped.state, stopped.nextCheck], ['stopped', null]);
  // a watch the user stopped can be watched again
  const again = await mgr.resume(item.id);
  assert.deepEqual([again.state, again.lastError], ['watching', null]);
  await assert.rejects(mgr.resume(item.id), refusal('bad_state'));
  await assert.rejects(mgr.resume('nope'), refusal('unknown_item'));
  const { item: session } = await mgr.create(ask);
  await assert.rejects(mgr.resume(session.id), refusal('bad_state'));
  assert.equal((await mgr.tick()).checked, 0);
});

test('a watch stopped while it is being read records nothing and tells nobody, whether the read changed or was busy', async () => {
  for (const reading of [{ fingerprint: 'b' }, new WatchRetryError('busy')]) {
    const { w, mgr, advance } = world();
    const item = await mgr.createWatch(WATCH);
    advance(2000);
    w.readings.push({ fingerprint: 'a' });
    await mgr.tick();
    advance(30 * 60_000);
    w.readings.push(reading);
    const g = gate();
    w.readGate = g.hold;
    const ticking = mgr.tick();
    await tick();
    await mgr.stop(item.id);
    g.release();
    const out = await ticking;
    assert.equal(out.changed, 0);
    assert.deepEqual([(await mgr.get(item.id))?.state, w.notices.length], ['stopped', 0]);
  }
});
