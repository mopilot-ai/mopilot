// What keeps a notice pass honest on a Host (host/src/momoNotice.mjs): a lease lost mid-pass stops every write, reading that fails waits with a cause and a way out, the day has a reading budget, and a brief or catch-up is not delivered after a move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createMomoNotice } from '../host/src/momoNotice.mjs';
import { answer, mail, minutes, rig } from './support/host/momoNoticeRig.ts';

test('a lease lost while a pass reads: nothing more is written, not a matter, a decision, a seen mark or the pass time', async (t) => {
  const w = rig(t);
  await w.notice.tick();
  w.clock.at += minutes(10);
  w.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  w.world.threads.t2 = mail('t2', { date: '2026-11-24T12:06:00Z' });
  const before = w.store.lastRunAt();
  const reading = { name: 'fake', complete: async () => ((w.state.current = false), answer('tell_now')) };
  const cut = createMomoNotice({
    home: w.home,
    store: w.store,
    reader: async () => ({ client: w.client, versions: w.versions }),
    google: async () => ({ kind: 'connected_read_only', email: 'maya@x.com' }),
    model: () => reading,
    mode: () => 'tell_now',
    push: () => ({ tell: async () => ({ status: 'sent' }) }),
    machine: () => ({ machineId: 'm1', name: 'Studio' }),
    now: () => w.clock.at,
    report: () => undefined,
    everyMs: 0,
  });
  assert.deepEqual(await cut.tick(), { idle: 'not-home' });
  assert.deepEqual([await w.store.notice.listMatters(), w.store.decisions(), w.store.lastRunAt()], [[], [], before]);
  assert.equal(await w.versions.get('gmail:t1'), undefined);
  assert.deepEqual(w.reports, []);
});

test('reading that fails every time waits and doubles, says why with a way out, and a usage limit names the machine', async (t) => {
  const w = rig(t);
  await w.notice.tick();
  w.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  const failing: any = {
    name: 'fake',
    complete: async () => {
      throw new Error('You have hit your usage limit');
    },
  };
  const cut = createMomoNotice({
    home: w.home,
    store: w.store,
    reader: async () => ({ client: w.client, versions: w.versions }),
    google: async () => ({ kind: 'connected_read_only', email: 'maya@x.com' }),
    model: () => failing,
    mode: () => 'tell_now',
    push: () => undefined,
    machine: () => ({ machineId: 'm1', name: 'Studio' }),
    now: () => w.clock.at,
    report: () => undefined,
    everyMs: 0,
  });
  w.clock.at += minutes(10);
  assert.equal((await cut.tick()).did?.[0], 'pass');
  assert.deepEqual(cut.views.state().gaps, [
    { source: 'Reading', why: 'Reading is paused: usage limit on Studio.', fix: { action: 'retry', label: 'Try again' } },
  ]);
  assert.deepEqual(w.store.backoff(), { until: w.clock.at + minutes(5), tries: 1 });
  assert.deepEqual(await cut.tick(), { idle: 'backoff' });
  // the owner says try again: reading goes on at once, fails again, and waits twice as long
  assert.equal(await cut.actions.retry(), true);
  assert.deepEqual(w.store.backoff(), { until: 0, tries: 0 });
  await cut.tick();
  assert.equal(w.store.backoff().tries, 1);
  w.clock.at += minutes(6);
  await cut.tick();
  assert.deepEqual([w.store.backoff().tries, w.store.backoff().until - w.clock.at], [2, minutes(10)]);
  // other failures are worded without a cause that is not known
  failing.complete = async () => {
    throw new Error('socket hang up');
  };
  w.clock.at += minutes(11);
  await cut.tick();
  assert.equal(cut.views.state().gaps[0].why, 'Reading is paused: the reading model did not answer.');
  // reading that works clears the wait, and the unsorted mail is read
  failing.complete = async () => answer('quiet');
  w.clock.at += minutes(21);
  assert.equal((await cut.tick()).did?.[0], 'pass');
  assert.deepEqual(w.store.backoff(), { until: 0, tries: 0 });
  assert.deepEqual(w.store.unsorted(), []);
});

test('the day has a reading budget: past it mail waits unsorted and the owner can allow more', async (t) => {
  const w = rig(t);
  await w.notice.tick();
  w.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  w.world.threads.t2 = mail('t2', { date: '2026-11-24T12:06:00Z' });
  const reading = { name: 'fake', complete: async () => answer('quiet') };
  const cut = createMomoNotice({
    home: w.home,
    store: w.store,
    reader: async () => ({ client: w.client, versions: w.versions }),
    google: async () => ({ kind: 'connected_read_only', email: 'maya@x.com' }),
    model: () => reading,
    mode: () => 'brief',
    push: () => undefined,
    machine: () => ({ machineId: 'm1', name: 'Studio' }),
    now: () => w.clock.at,
    report: () => undefined,
    everyMs: 0,
    readsPerDay: 1,
  });
  w.clock.at += minutes(10);
  await cut.tick();
  assert.equal(w.store.unsorted().length, 1);
  assert.deepEqual(cut.views.state().gaps, [
    {
      source: 'Reading',
      why: 'Reading is paused for today: the limit of 1 reads was reached.',
      fix: { action: 'more_reads', label: 'Allow 100 more today' },
    },
  ]);
  assert.equal(await cut.actions.moreReads(), true);
  await cut.tick();
  assert.deepEqual(w.store.unsorted(), []);
});

test('a brief or a catch-up is not delivered once the lease has moved on', async (t) => {
  const w = rig(t);
  w.state.current = false;
  await assert.rejects(w.notice.seams.deliver({ id: 'brief:d', day: 'd', text: 't', built: null, stamp: w.state.stamp }), /not delivered/);
  await assert.rejects(w.notice.seams.catchUp({ id: 'c', from: 0, to: 1, stamp: w.state.stamp }), /not delivered/);
  assert.deepEqual(w.notice.views.cards(), []);
});
