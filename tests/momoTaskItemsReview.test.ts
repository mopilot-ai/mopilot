// Review findings on the tasks core (#5488): each case fails on the code as first pushed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskRefusal } from '../shared/momoTasks/manager.ts';
import { createItemStore, createMemorySeam, parseItem } from '../shared/momoTasks/store.ts';
import { parseWatch } from '../shared/momoTasks/watch.ts';
import { ask, gate, REPORT, tick, world } from './support/momoTaskItems/world.ts';

const refusal = (code: string) => (e: unknown) => e instanceof TaskRefusal && e.code === code;
const sid = (item: { where: { sessionId: string | null } }) => item.where.sessionId as string;

test('a card owed for a task that was retried since is still delivered as it was, and never blocks the others', async () => {
  const { w, mgr } = world();
  const a = await mgr.create({ ...ask, title: 'A' });
  const b = await mgr.create({ ...ask, title: 'B' });
  w.postFails = 3;
  await mgr.onEvent('home', sid(a.item), { kind: 'failed', message: 'a broke' });
  await mgr.onEvent('home', sid(b.item), { kind: 'failed', message: 'b broke' });
  assert.equal(w.cards.length, 0);
  // A is retried (working, no result) and B is moved (no last error) before the chat is back
  await mgr.retry(a.item.id);
  await mgr.retry(b.item.id, { machineId: 'mini', harness: 'codex' });
  assert.equal(await mgr.flushCards(), 2);
  assert.deepEqual(w.cards.map((c) => [c.title, c.state]).sort(), [
    ['A', 'failed'],
    ['B', 'failed'],
  ]);
  assert.match(w.cards.find((c) => c.title === 'A')?.summary as string, /a broke/);
  assert.equal(await mgr.flushCards(), 0);
});

test('a card owed for a failure stays a failure card when the task is stopped before it is delivered', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  w.postFails = 1;
  await mgr.onEvent('home', sid(item), { kind: 'failed', message: 'broke' });
  const again = await mgr.retry(item.id);
  await mgr.stop(item.id);
  assert.equal(await mgr.flushCards(), 1);
  assert.equal(w.cards[0].state, 'failed');
  assert.equal(again.item.state, 'working');
});

test('Stop while the Host is still starting the session stops that session when it arrives', async () => {
  const { w, mgr, store } = world();
  const g = gate();
  w.startOutcome = async () => (await g.hold, { ok: true, sessionId: 'late' });
  const pending = mgr.create(ask);
  await tick();
  const [item] = await store.list();
  await mgr.stop(item.id);
  assert.deepEqual(w.stopped, []);
  g.release();
  const after = await pending;
  assert.equal(after.item.state, 'stopped');
  assert.deepEqual(w.stopped, [['home', 'late']]);
  // the machine cannot be reached to stop it: the task says so
  const second = world();
  const g2 = gate();
  second.w.startOutcome = async () => (await g2.hold, { ok: true, sessionId: 'late2' });
  second.w.stopThrows = true;
  const p2 = second.mgr.create(ask);
  await tick();
  await second.mgr.stop((await second.store.list())[0].id);
  g2.release();
  const out = await p2;
  assert.match(out.item.lastError?.message as string, /couldn't reach Studio to stop a session it had just started/);
});

test('a task that finishes while Stop is looking up its machine stays done', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  const g = gate();
  w.listGate = g.hold;
  const stopping = mgr.stop(item.id);
  await tick();
  w.listGate = null;
  await mgr.onEvent('home', sid(item), { kind: 'finished', report: REPORT });
  g.release();
  assert.equal((await stopping).state, 'done');
  assert.deepEqual(w.stopped, []);
});

test('a task waiting on an open gate card cannot be started again', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  await mgr.onEvent('home', sid(item), { kind: 'needs_you', line: 'Draft ready', cardId: 'c1' });
  await assert.rejects(mgr.retry(item.id), refusal('bad_state'));
  assert.equal(w.started.length, 1);
});

test('asking again after a task is done, stopped or failed starts a new one; a live one is still returned', async () => {
  const { w, mgr } = world();
  const first = await mgr.create(ask);
  assert.equal((await mgr.create(ask)).item.id, first.item.id);
  await mgr.onEvent('home', sid(first.item), { kind: 'finished', report: REPORT });
  const second = await mgr.create(ask);
  assert.notEqual(second.item.id, first.item.id);
  await mgr.stop(second.item.id);
  const third = await mgr.create(ask);
  assert.notEqual(third.item.id, second.item.id);
  assert.equal(w.started.length, 3);
});

test('a successful retry carries no old error, but a repeat of the same failure is still noticed', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  await mgr.onEvent('home', sid(item), { kind: 'failed', message: 'same words' });
  const retried = await mgr.retry(item.id);
  assert.deepEqual([retried.error, retried.item.lastError], [null, null]);
  const twice = await mgr.onEvent('home', sid(retried.item), { kind: 'failed', message: 'same words' });
  assert.equal(twice?.lastError?.code, 'same_failure');
  assert.equal(w.cards.length, 2);
});

test('after a restart a task with no session says it may already be running, and Start again reuses the same key', async () => {
  const { w, mgr, store } = world();
  const { item } = await mgr.create(ask);
  await store.update(item.id, (cur) => ({ ...cur, where: { ...cur.where, sessionId: null }, attempts: 0 }));
  await mgr.recover();
  const lost = await mgr.get(item.id);
  assert.doesNotMatch(lost?.lastError?.message as string, /Nothing ran/);
  assert.match(lost?.lastError?.message as string, /may already be running on Studio/);
  assert.deepEqual(
    lost?.lastError?.fixes.map((f) => f.action),
    ['startAgain'],
  );
  await mgr.retry(item.id);
  assert.deepEqual(
    w.started.map((r) => r.key),
    [`${item.id}:1`, `${item.id}:1`],
  );
});

test('a ledger written by a newer version is kept and refused, not read as empty and overwritten', async () => {
  const future = { v: 2, items: [{ anything: true }] };
  const seam = createMemorySeam(future);
  const store = createItemStore(seam, { now: () => 1 });
  await assert.rejects(store.list(), /newer version/);
  await assert.rejects(store.get('x'), /newer version/);
  await assert.rejects(store.bySession('m', 's'), /newer version/);
  await assert.rejects(
    store.update('x', (i) => i),
    /newer version/,
  );
  const { item } = await world().mgr.create(ask);
  await assert.rejects(store.insertOrGet(item, 5), /newer version/);
  assert.deepEqual(seam.snapshot(), future);
  // Reset MoMo is the way out
  await store.reset();
  assert.deepEqual(await store.list(), []);
  // a document that is not a ledger at all is refused the same way; no document yet is an empty ledger
  await assert.rejects(createItemStore(createMemorySeam('garbage'), { now: () => 1 }).list(), /damaged/);
  assert.deepEqual(await createItemStore(createMemorySeam(undefined), { now: () => 1 }).list(), []);
});

test('a stored error or result with missing parts is filled in, never left to crash a card or a row', () => {
  const base = {
    id: 'a',
    title: 't',
    doneMeans: 'd',
    state: 'failed',
    where: { machineId: 'm', harness: 'claude', sessionId: null },
    origin: 'asked',
    stableKey: 'k',
    attempts: 1,
    attemptCap: 3,
    createdAt: 1,
    updatedAt: 5,
  };
  const failed = parseItem({ ...base, lastError: { code: 'session_failed', message: 'boom' } });
  assert.deepEqual([failed?.lastError?.fixes, failed?.lastError?.retry, failed?.lastError?.at], [[], false, 5]);
  const lost = parseItem({ ...base, lastError: null });
  assert.match(lost?.lastError?.message as string, /details were lost/);
  const kept = parseItem({
    ...base,
    lastError: { code: 'x', message: 'm', fixes: [{ action: 'retry', label: 'Retry' }, { action: 1 }, 'x'], retry: true, at: 2 },
  });
  assert.deepEqual(kept?.lastError?.fixes, [{ action: 'retry', label: 'Retry' }]);
  const done = parseItem({ ...base, state: 'done', lastError: null, result: { summary: 's', files: 'a.xlsx', met: true } });
  assert.deepEqual(done?.result, { summary: 's', files: [], evidence: '', checked: '', met: true });
  const needs = parseItem({ ...base, state: 'needs_you', result: null });
  assert.deepEqual([needs?.result?.summary, needs?.result?.met], ['', false]);
  assert.equal(parseItem({ ...base, state: 'working', result: { summary: 1 } })?.result, null);
  const mixed = parseItem({ ...base, state: 'done', result: { summary: 's', files: ['a', 2], evidence: 'e', checked: 'c' } });
  assert.deepEqual([mixed?.result?.files, mixed?.result?.evidence, mixed?.result?.checked, mixed?.result?.met], [['a'], 'e', 'c', false]);
  assert.deepEqual([parseItem({ ...base, state: 'working' })?.card, parseItem({ ...base, state: 'working' })?.notice], [null, null]);
});

test('a watch cannot point at this machine, a private network, a link-local or a metadata address', () => {
  const refused = [
    'https://localhost/x',
    'https://app.localhost/x',
    'https://127.0.0.1/x',
    'https://127.1/x',
    'https://10.0.0.5/x',
    'https://172.16.0.1/x',
    'https://172.31.255.255/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://0.0.0.0/x',
    'https://100.64.0.1/x',
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://[fe80::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://metadata.google.internal/x',
    'https://printer.local/x',
    'https://db.internal/x',
    'https://2130706433/x',
    'https://localhost./x',
    'https://db.internal./x',
    'https://printer.local./x',
    'https://127.0.0.1./x',
    'https://[::127.0.0.1]/x',
    'https://[::7f00:1]/x',
    'https://[2002:7f00:1::]/x',
    'https://[2002:c0a8:101::1]/x',
  ];
  for (const url of refused) assert.match((parseWatch({ kind: 'http', url }) as { error: string }).error, /public HTTPS/, url);
  for (const url of ['https://status.example.com/x', 'https://8.8.8.8/x', 'https://172.32.0.1/x', 'https://[2606:4700::1111]/x'])
    assert.ok('watch' in parseWatch({ kind: 'http', url }), url);
});

test('a late failure cannot overwrite a finished-but-not-done result the user is looking at', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  w.answer = () => '{"met": false, "reason": "short", "checked": "c"}';
  await mgr.onEvent('home', sid(item), { kind: 'finished', report: REPORT });
  const after = await mgr.onEvent('home', sid(item), { kind: 'failed', message: 'late' });
  assert.deepEqual([after?.state, after?.result?.met, w.cards.length], ['needs_you', false, 1]);
  await mgr.onEvent('home', sid(item), { kind: 'lost', reason: 'machine_restarted' });
  assert.equal((await mgr.get(item.id))?.state, 'needs_you');
});

test('two finished events at once check the result once', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  const g = gate();
  w.answer = async () => (await g.hold, '{"met": true, "reason": "ok", "checked": "c"}');
  const a = mgr.onEvent('home', sid(item), { kind: 'finished', report: REPORT });
  const b = mgr.onEvent('home', sid(item), { kind: 'finished', report: REPORT });
  await tick();
  g.release();
  await Promise.all([a, b]);
  assert.equal(w.asked.length, 1);
  assert.equal(w.cards.length, 1);
});

test('the next check is counted from when the read ended, not when it began', async () => {
  const { w, mgr, advance } = world();
  const item = await mgr.createWatch({
    title: 'W',
    doneMeans: 'd',
    origin: 'matter',
    watch: { kind: 'tool', tool: 'x', everyMinutes: 30 },
  });
  advance(2000);
  const g = gate();
  w.readGate = g.hold;
  const ticking = mgr.tick();
  await tick();
  advance(120_000);
  g.release();
  await ticking;
  const cur = await mgr.get(item.id);
  assert.equal(cur?.nextCheck, item.createdAt + 2000 + 120_000 + 30 * 60_000);
  assert.equal(cur?.watch?.state?.checkedAt, new Date(item.createdAt + 2000 + 120_000).toISOString());
});

test('a watch change the chat could not be told about is told later, once, even after a restart', async () => {
  const { w, mgr, advance, store } = world();
  const item = await mgr.createWatch({ title: 'W', doneMeans: 'd', origin: 'matter', watch: { kind: 'tool', tool: 'x', everyMinutes: 5 } });
  w.readings.push({ fingerprint: 'a' }, { fingerprint: 'b' });
  advance(2000);
  await mgr.tick();
  advance(5 * 60_000);
  w.noticeFails = true;
  assert.equal((await mgr.tick()).undelivered, 1);
  assert.equal(w.notices.length, 0);
  w.noticeFails = false;
  assert.equal(await mgr.flushCards(), 1);
  assert.equal(await mgr.flushCards(), 0);
  assert.deepEqual(
    w.notices.map((n) => n.itemId),
    [item.id],
  );
  assert.equal((await store.get(item.id))?.notice, null);
});

test('a finished task that still owes its card is not pruned, however old', async () => {
  const day = 24 * 3_600_000;
  const { w, mgr, advance } = world();
  const { item } = await mgr.create(ask);
  w.postFails = 1;
  await mgr.onEvent('home', sid(item), { kind: 'finished', report: REPORT });
  advance(60 * day);
  await mgr.create({ ...ask, title: 'another' });
  assert.equal((await mgr.get(item.id))?.state, 'done');
  assert.equal(await mgr.flushCards(), 1);
  advance(60 * day);
  await mgr.create({ ...ask, title: 'a third' });
  assert.equal(await mgr.get(item.id), null);
});

test('when five tasks are working the sixth gets no Retry that would go nowhere', async () => {
  const { mgr } = world();
  for (let i = 0; i < 5; i++) await mgr.create({ ...ask, title: `Job ${i}` });
  const sixth = await mgr.create({ ...ask, title: 'Job 6' });
  assert.deepEqual([sixth.error?.code, sixth.error?.retry, sixth.error?.fixes], ['too_many_active', false, []]);
});

test('Reset MoMo stops the sessions of tasks that are running, and says when one cannot be reached', async () => {
  const { w, mgr } = world();
  const a = await mgr.create({ ...ask, title: 'A' });
  const b = await mgr.create({ ...ask, title: 'B' });
  const c = await mgr.create({ ...ask, title: 'C' });
  await mgr.onEvent('home', sid(c.item), { kind: 'finished', report: REPORT });
  w.stopThrows = true;
  assert.deepEqual(await mgr.reset(), { stopped: 0, unreachable: 2 });
  w.stopThrows = false;
  assert.deepEqual(w.stopped.map((s) => s[1]).sort(), [sid(a.item), sid(b.item)].sort());
  assert.deepEqual(await mgr.list(), []);
  const again = world();
  const d = await again.mgr.create(ask);
  assert.deepEqual(await again.mgr.reset(), { stopped: 1, unreachable: 0 });
  assert.deepEqual(again.w.stopped, [['home', sid(d.item)]]);
});

test('a task started again while its old session is still being stopped is not told the stop failed', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  const g = gate();
  w.stopGate = g.hold;
  w.stopThrows = true;
  const stopping = mgr.stop(item.id);
  await tick();
  w.stopGate = null;
  await mgr.retry(item.id);
  g.release();
  const after = await stopping;
  assert.deepEqual([after.state, after.lastError], ['working', null]);
});

test('Reset MoMo while the Host is still starting a session stops that session when it arrives', async () => {
  const { w, mgr } = world();
  const g = gate();
  w.startOutcome = async () => (await g.hold, { ok: true, sessionId: 'late' });
  const pending = mgr.create(ask);
  await tick();
  assert.deepEqual(await mgr.reset(), { stopped: 0, unreachable: 0 });
  g.release();
  const after = await pending;
  assert.equal(after.item.where.sessionId, null);
  assert.deepEqual(w.stopped, [['home', 'late']]);
  assert.deepEqual(await mgr.list(), []);
});

test('a replayed finished for a result already checked never reaches the model again', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  w.answer = () => '{"met": false, "reason": "short", "checked": "c"}';
  await mgr.onEvent('home', sid(item), { kind: 'finished', report: REPORT });
  assert.equal(w.asked.length, 1);
  await mgr.onEvent('home', sid(item), { kind: 'finished', report: REPORT });
  await mgr.onEvent('home', sid(item), { kind: 'finished', report: REPORT });
  assert.deepEqual([w.asked.length, w.cards.length, (await mgr.get(item.id))?.settled], [1, 1, 1]);
  // after a done result too
  const b = await mgr.create({ ...ask, title: 'B' });
  w.answer = () => '{"met": true, "reason": "ok", "checked": "c"}';
  await mgr.onEvent('home', sid(b.item), { kind: 'finished', report: REPORT });
  await mgr.onEvent('home', sid(b.item), { kind: 'finished', report: REPORT });
  assert.equal(w.asked.length, 2);
});

test('a task deleted while recovery reads its finished session is not checked', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  w.probes.set(`home/${sid(item)}`, { state: 'finished', report: REPORT });
  const g = gate();
  w.probeGate = g.hold;
  const recovering = mgr.recover();
  await tick();
  await mgr.reset();
  g.release();
  assert.deepEqual(await recovering, { running: 0, asleep: 0, finished: 1, interrupted: 0 });
  assert.deepEqual([w.asked.length, w.cards.length], [0, 0]);
});

test('a retry sent to a place MoMo cannot use is refused before the task, its attempts or its slot are touched', async () => {
  const { w, mgr, store } = world();
  const { item } = await mgr.create(ask);
  await mgr.stop(item.id);
  const before = await store.get(item.id);
  w.machines[1] = { ...w.machines[1]!, online: false };
  const targets = [
    { machineId: 'nowhere', harness: 'claude' },
    { machineId: 'mini|codex', harness: 'claude' },
    { machineId: 'mini', harness: 'codex|x' },
    { machineId: 'mini', harness: 'codex' },
  ];
  for (const where of targets) await assert.rejects(mgr.retry(item.id, where), refusal('bad_target'), JSON.stringify(where));
  assert.deepEqual(await store.get(item.id), before);
  // the one that can run it is taken
  w.machines[1] = { ...w.machines[1]!, online: true };
  const moved = await mgr.retry(item.id, { machineId: 'mini', harness: 'codex' });
  assert.deepEqual([moved.item.state, moved.item.where.machineId], ['working', 'mini']);
});
