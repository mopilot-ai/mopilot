// MoMo tasks after a restart (shared/momoTasks/runs.ts `recover`, `lost` events): running tasks keep going, finished ones are checked, lost ones are interrupted, and nothing runs again by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask, gate, REPORT, tick, world } from './support/momoTaskItems/world.ts';

test('after the home restarts: running tasks keep going, finished ones are checked, lost ones are interrupted, nothing runs again', async () => {
  const { w, mgr } = world();
  const mk = async (title: string) => (await mgr.create({ ...ask, title })).item;
  const waiting = await mk('waiting');
  await mgr.onEvent('home', waiting.where.sessionId as string, { kind: 'needs_you', line: 'Draft ready', cardId: 'c1' });
  const done = await mk('done already');
  await mgr.onEvent('home', done.where.sessionId as string, { kind: 'finished', report: REPORT });
  const running = await mk('running');
  const finished = await mk('finished');
  const gone = await mk('gone');
  const asleep = await mk('asleep');
  const dropped = await mk('dropped');
  const watch = await mgr.createWatch({
    title: 'AWS invoice',
    doneMeans: 'due',
    origin: 'matter',
    watch: { kind: 'tool', tool: 'gmail.search' },
  });
  w.probes.set(`home/${finished.where.sessionId}`, { state: 'finished', report: REPORT });
  w.probes.set(`home/${gone.where.sessionId}`, { state: 'gone' });
  w.probes.set(`home/${asleep.where.sessionId}`, { state: 'unreachable' });
  w.probes.set(`home/${dropped.where.sessionId}`, new Error('timeout'));
  w.probes.set(`home/${waiting.where.sessionId}`, { state: 'running' });
  const startedBefore = w.started.length;
  const counts = await mgr.recover();
  assert.deepEqual(counts, { running: 2, asleep: 2, finished: 1, interrupted: 1 });
  assert.equal(w.started.length, startedBefore);
  assert.equal((await mgr.get(running.id))?.state, 'working');
  assert.equal((await mgr.get(finished.id))?.state, 'done');
  const lost = await mgr.get(gone.id);
  assert.deepEqual(
    [lost?.state, lost?.lastError?.code, lost?.lastError?.fixes.map((x) => x.action)],
    ['failed', 'interrupted', ['openSession', 'startAgain']],
  );
  assert.match((await mgr.get(asleep.id))?.progress as string, /Studio is asleep or offline\. This keeps running there/);
  assert.equal((await mgr.get(dropped.id))?.state, 'working');
  assert.equal((await mgr.get(waiting.id))?.state, 'needs_you');
  assert.equal((await mgr.get(watch.id))?.state, 'watching');
  // an interrupted task is never started by itself; the user's Start again is
  assert.equal((await mgr.recover()).interrupted, 0);
  assert.equal((await mgr.retry(gone.id)).item.state, 'working');
});

test('a task with no session after a restart was never started: it is interrupted, not run', async () => {
  const { w, mgr, store } = world();
  await store.insertOrGet(
    {
      id: 'orphan',
      title: 'Orphan',
      doneMeans: 'd',
      state: 'working',
      where: { machineId: 'home', harness: 'claude', sessionId: null },
      origin: 'asked',
      stableKey: 'k',
      attempts: 0,
      attemptCap: 3,
      lastError: null,
      result: null,
      progress: null,
      cardId: null,
      watch: null,
      nextCheck: null,
      createdAt: 1,
      startedAt: null,
      updatedAt: 1,
      settled: 0,
      posted: 0,
      card: null,
      notice: null,
      failedWith: null,
    },
    5,
  );
  assert.equal((await mgr.recover()).interrupted, 1);
  const item = await mgr.get('orphan');
  assert.deepEqual(
    [item?.state, item?.lastError?.message, w.started.length],
    ['failed', 'MoMo restarted while this was starting, so it may already be running on Studio. Start again reconnects to it if so.', 0],
  );
  // the user's Start again then starts it
  assert.equal((await mgr.retry('orphan')).item.where.sessionId, 'sess1');
});

test('the machine restarted while the task ran: the adapter says so, and the task is interrupted with Start again', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create({ ...ask, where: { machineId: 'mini', harness: 'codex' } });
  const lost = await mgr.onEvent('mini', item.where.sessionId as string, { kind: 'lost', reason: 'machine_restarted' });
  assert.deepEqual(
    [lost?.state, lost?.lastError?.code, lost?.lastError?.message],
    ['failed', 'interrupted', 'Mac mini restarted while this ran. It may have partly finished.'],
  );
  assert.deepEqual(w.cards[0].actions, ['openSession', 'startAgain']);
  assert.equal(w.started.length, 1);
});

test('recovery names a machine that is gone as the task last knew it', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  w.machines = [];
  w.probes.set(`home/${item.where.sessionId}`, { state: 'unreachable' });
  await mgr.recover();
  assert.match((await mgr.get(item.id))?.progress as string, /^Studio is asleep or offline/);
});

test('a task stopped while recovery asks about it is not given a progress line', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  w.probes.set(`home/${item.where.sessionId}`, { state: 'unreachable' });
  const g = gate();
  w.probeGate = g.hold;
  const recovering = mgr.recover();
  await tick();
  await mgr.stop(item.id);
  g.release();
  assert.equal((await recovering).asleep, 1);
  assert.equal((await mgr.get(item.id))?.progress, null);
});
