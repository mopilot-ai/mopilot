// Core behaviour the Host work needs (shared/momoTasks): a session that speaks before its start is recorded, a lease lost mid-start, a session that ended while MoMo was away, entries kept aside, and a retry that supersedes the old session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createItemStore, createMemorySeam } from '../shared/momoTasks/store.ts';
import { ask, gate, REPORT, tick, world } from './support/momoTaskItems/world.ts';

const sid = (item: { where: { sessionId: string | null } }) => item.where.sessionId as string;

test('a session that fails before its start is recorded still fails the task, in order', async () => {
  const { w, mgr } = world();
  const g = gate();
  w.startOutcome = async (req) => {
    await g.hold;
    return { ok: true, sessionId: `s-${req.key}` };
  };
  const pending = mgr.create(ask);
  await tick();
  // the session says it failed (and an unrelated one speaks) while the Host is still answering the start
  const key = `${(await mgr.list())[0].id}:1`;
  assert.equal(await mgr.onEvent('home', `s-${key}`, { kind: 'progress', line: 'Starting' }), null);
  assert.equal(await mgr.onEvent('home', `s-${key}`, { kind: 'failed', message: 'crashed at once' }), null);
  for (let i = 0; i < 30; i++) await mgr.onEvent('home', `noise-${i}`, { kind: 'progress', line: 'x' });
  g.release();
  const { item } = await pending;
  assert.deepEqual([item.state, item.lastError?.code], ['failed', 'session_failed']);
  assert.match(item.lastError?.message as string, /crashed at once/);
  assert.equal(w.cards.length, 1);
  // events that were never anyone's are not kept
  assert.equal(await mgr.onEvent('home', 'later-noise', { kind: 'progress', line: 'x' }), null);
});

test('too many early events from one session keep only the first ones', async () => {
  const { w, mgr } = world();
  const g = gate();
  w.startOutcome = async (req) => (await g.hold, { ok: true, sessionId: `s-${req.key}` });
  const pending = mgr.create(ask);
  await tick();
  const key = `${(await mgr.list())[0].id}:1`;
  for (let i = 0; i < 25; i++) await mgr.onEvent('home', `s-${key}`, { kind: 'progress', line: `step ${i}` });
  g.release();
  const { item } = await pending;
  assert.equal(item.progress, 'step 19');
});

test('a start recorded while the lease is lost stops the session it started, and the error is told', async () => {
  const seam = createMemorySeam();
  let lost = false;
  const wrapped = { read: seam.read, change: <T>(fn: any) => (lost ? Promise.reject(new Error('momo_home_away')) : seam.change<T>(fn)) };
  const { w, mgr } = world({ seam: wrapped as any });
  w.startOutcome = async () => {
    lost = true;
    return { ok: true, sessionId: 'orphan' };
  };
  await assert.rejects(mgr.create(ask), /momo_home_away/);
  assert.deepEqual(w.stopped, [['home', 'orphan']]);
});

test('a session that ended while MoMo was away is read as if it had been seen', async () => {
  const { w, mgr } = world();
  const a = await mgr.create({ ...ask, title: 'a' });
  const b = await mgr.create({ ...ask, title: 'b' });
  w.probes.set(`home/${sid(a.item)}`, { state: 'ended', event: { kind: 'finished', report: REPORT } });
  w.probes.set(`home/${sid(b.item)}`, { state: 'ended', event: { kind: 'failed', signal: 'rate_limit', message: 'limit' } });
  assert.deepEqual(await mgr.recover(), { running: 0, asleep: 0, finished: 1, interrupted: 1 });
  assert.equal((await mgr.get(a.item.id))?.state, 'done');
  assert.equal((await mgr.get(b.item.id))?.lastError?.code, 'usage_limit');
  assert.equal(w.cards.length, 2);
});

test('entries that are not whole are kept aside, surfaced, and survive the next write', async () => {
  const junk = { id: 'x', title: 7 };
  const seam = createMemorySeam({ v: 1, items: [junk] });
  const store = createItemStore(seam, { now: () => 1 });
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.aside(), [junk]);
  const { mgr } = world({ seam });
  await mgr.create(ask);
  const doc = seam.snapshot() as { items: unknown[]; aside: unknown[] };
  assert.deepEqual([doc.items.length, doc.aside], [1, [junk]]);
  // a repeated aside is not duplicated, and the aside is bounded
  await store.update((await store.list())[0].id, (i) => ({ ...i, title: 'again' }));
  assert.deepEqual((seam.snapshot() as { aside: unknown[] }).aside, [junk]);
  const many = createItemStore(createMemorySeam({ v: 1, items: Array.from({ length: 80 }, (_, i) => ({ junk: i })) }), { now: () => 1 });
  assert.equal((await many.aside()).length, 50);
});

test('a retry supersedes the old session: its late report settles nothing', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  const old = sid(item);
  await mgr.onEvent('home', old, { kind: 'failed', message: 'broke' });
  const g = gate();
  w.startOutcome = async (req) => (await g.hold, { ok: true, sessionId: `s-${req.key}` });
  const retrying = mgr.retry(item.id);
  await tick();
  // the intent to start is recorded: the task has no session yet, and the old one's report is not its
  assert.equal((await mgr.get(item.id))?.where.sessionId, null);
  assert.equal(await mgr.onEvent('home', old, { kind: 'finished', report: REPORT }), null);
  g.release();
  assert.equal((await retrying).item.state, 'working');
  assert.equal(w.cards.length, 1);
});
