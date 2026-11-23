// What the clients' task intents do on the home (shared/momoIntents.mjs, lane `tasks`), through the registry's own checks: stop, retry, run on another machine, stop a watch, and start an offer of the brief. (host/src/momoServices/tasks.mjs `intents`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createIntentRegistry } from '../shared/momoIntents.mjs';
// @ts-ignore
import { IntentError } from '../shared/momoHomeApi.mjs';
import { A } from './support/host/momoMoveWorld.ts';
import { ask, tasksWorld, until } from './support/host/momoTasksWorld.ts';

async function intents(t: any) {
  const w = await tasksWorld(t);
  const registry = createIntentRegistry({ running: () => !!w.home.stamp() });
  registry.register('tasks', w.tasks.intents);
  return { w, run: registry.intents() as Record<string, (i: any) => Promise<any>> };
}
const states = async (w: any) => (await w.tasks.view()).map((v: any) => v.state);

test('the lane registers every kind the table gives it, and the registry checks the arguments before a handler runs', async (t) => {
  const { w, run } = await intents(t);
  assert.deepEqual(Object.keys(run).sort(), [
    'brief.start',
    'task.act',
    'task.check',
    'task.retry',
    'task.runElsewhere',
    'task.snooze',
    'task.stop',
    'task.stopWatching',
  ]);
  assert.throws(() => run['task.stop']!({}), /not something MoMo can do/);
  assert.throws(() => run['task.runElsewhere']!({ id: 'x' }), /not something MoMo can do/);
  assert.deepEqual(await states(w), []);
});

test('stop, then retry, act on the task the client names; a task that is not there or not running is told as it is', async (t) => {
  const { w, run } = await intents(t);
  const { item } = await w.tasks.create(ask);
  await run['task.stop']!({ id: item.id });
  assert.deepEqual(await states(w), ['stopped']);
  await assert.rejects(run['task.stop']!({ id: item.id }), (e: any) => e instanceof IntentError && /not running/.test(e.message));
  await assert.rejects(run['task.stop']!({ id: 'nope' }), (e: any) => e instanceof IntentError && /No such task/.test(e.message));
  await run['task.retry']!({ id: item.id });
  assert.deepEqual(await states(w), ['working']);
  assert.equal(w.sessions.sent.length, 2);
});

test('run elsewhere retries on the machine named, with the same agent; a machine MoMo does not list, or one smuggling a fix id, leaves the task as it was', async (t) => {
  const { w, run } = await intents(t);
  const { item } = await w.tasks.create(ask);
  await w.tasks.stop(item.id);
  await run['task.runElsewhere']!({ id: item.id, machineId: A.homeId });
  assert.deepEqual(await states(w), ['working']);
  await assert.rejects(run['task.runElsewhere']!({ id: 'nope', machineId: A.homeId }), /No such task/);
  await w.tasks.stop(item.id);
  const before = (await w.tasks.view())[0];
  // a machine that is not listed, and ids that carry the separator of a fix id (a harness of the client's choosing): refused before the task is touched
  for (const machineId of ['unknown-machine', 'x|codex', `${A.homeId}|codex`, '', 'a b'])
    await assert.rejects(run['task.runElsewhere']!({ id: item.id, machineId }), /isn't one of yours/, machineId);
  const after = (await w.tasks.view())[0];
  assert.deepEqual(
    [after.state, after.attempts, after.attemptCap, after.where, after.failure],
    [before.state, before.attempts, before.attemptCap, before.where, before.failure],
  );
  assert.equal(w.sessions.sent.length, 2);
});

test("a result card's button sends its fix id: Retry acts, one the task offers comes back by name, one it does not offer is refused", async (t) => {
  const { w, run } = await intents(t);
  const { item } = await w.tasks.create(ask);
  await w.tasks.stop(item.id);
  // a stopped task offers no fix of its own; Retry and Start again are always the client's fallback
  await assert.rejects(run['task.act']!({ id: item.id, fixId: 'signIn' }), /not something this task offers/);
  await assert.rejects(run['task.act']!({ id: item.id, fixId: 'runElsewhere|x|codex' }), /not something this task offers/);
  await assert.rejects(run['task.act']!({ id: item.id, fixId: 'retry|x|codex' }), /not something this task offers/);
  assert.deepEqual(await states(w), ['stopped']);
  const done = await run['task.act']!({ id: item.id, fixId: 'startAgain' });
  assert.equal(done.done.item.state, 'working');
  await assert.rejects(run['task.act']!({ id: 'nope', fixId: 'retry' }), /No such task/);
  assert.throws(() => run['task.act']!({ id: item.id }), /not something MoMo can do/);
  // a task that is running has no failure, so it offers no button of its own
  const running = await w.tasks.create({ ...ask, title: 'c' });
  await assert.rejects(run['task.act']!({ id: running.item.id, fixId: 'install' }), /not something this task offers/);
  // a failure's own button is the one that comes back by name
  w.sessions.sendFails = Object.assign(new Error('Spend limit'), { code: 'spend_limit' });
  const failed = await w.tasks.create({ ...ask, title: 'b' });
  w.sessions.sendFails = null;
  assert.deepEqual(await run['task.act']!({ id: failed.item.id, fixId: 'runElsewhere' }), { client: 'runElsewhere' });
});

test('run elsewhere and act are refused with words while this Host is not the running home', async (t) => {
  const { w } = await intents(t);
  const { item } = await w.tasks.create(ask);
  w.home.stamp = () => null;
  await assert.rejects(w.tasks.runElsewhere(item.id, A.homeId), /not running on this machine/);
  await assert.rejects(w.tasks.act(item.id, 'retry'), /not running on this machine/);
});

test('two devices tapping Retry at once start one session, and the second is told the task is starting or running', async (t) => {
  const { w, run } = await intents(t);
  const { item } = await w.tasks.create(ask);
  await w.tasks.stop(item.id);
  const before = w.sessions.sent.length;
  const taps = await Promise.allSettled([run['task.retry']!({ id: item.id }), run['task.retry']!({ id: item.id })]);
  assert.deepEqual(taps.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(String((taps.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason?.message), /already (starting|running)/);
  assert.equal(w.sessions.sent.length, before + 1);
});

test('a watch is stopped by the same intent that stops a task', async (t) => {
  const { w, run } = await intents(t);
  const watch = await w.tasks.createWatch({
    title: 'Status page',
    doneMeans: 'Tell me when it changes',
    origin: 'matter',
    watch: { kind: 'http', url: 'https://status.example.com/x', everyMinutes: 5 },
  });
  assert.deepEqual(await states(w), ['watching']);
  await run['task.stopWatching']!({ id: watch.id });
  assert.deepEqual(await states(w), ['stopped']);
});

test('an offer of the brief that the user starts becomes a task they asked for; one that is gone is told so', async (t) => {
  const { w, run } = await intents(t);
  await assert.rejects(run['brief.start']!({ offerId: 'o1' }), /not there anymore/);
  w.tasks.bind({
    ...w.binding,
    offers: { get: async (id: string) => (id === 'o1' ? { title: 'Book the dentist', why: 'The appointment is booked' } : null) },
  });
  await assert.rejects(run['brief.start']!({ offerId: 'o2' }), /not there anymore/);
  const started = await run['brief.start']!({ offerId: 'o1' });
  assert.equal(started.item.origin, 'suggestion');
  await until(async () => (await states(w))[0] === 'working', 'the task to start');
  assert.equal(w.sessions.sent.length, 1);
});

test('the intents are refused with words while this Host is not the running home, and a failure that is not a refusal is not hidden', async (t) => {
  const { w, run } = await intents(t);
  const stamp = w.home.stamp.bind(w.home);
  w.home.stamp = () => null;
  assert.throws(() => run['task.stop']!({ id: 'x' }), /isn’t running on this machine/);
  w.home.stamp = stamp;
  // an unexpected failure reaches the caller as it is
  w.tasks.bind({ ...w.binding, offers: { get: async () => Promise.reject(new TypeError('boom')) } });
  await assert.rejects(run['brief.start']!({ offerId: 'o1' }), /boom/);
});

test('a second bind adds its parts to the first: the notice lane binding the offers keeps the home’s brain, chat and watch reader', async (t) => {
  const { w, run } = await intents(t);
  w.tasks.bind({ offers: { get: async () => ({ title: 'Book the dentist', why: 'It is booked' }) }, check: undefined });
  const { item } = await run['brief.start']!({ offerId: 'o1' });
  assert.equal(item.state, 'working');
  w.sessions.say(item.where.sessionId, 'Booked.');
  w.sessions.end(item.where.sessionId);
  // the brain and the chat bound before still work
  await until(async () => w.cards.length === 1 && (await states(w))[0] === 'done', 'the card');
  assert.equal(w.asked.length, 1);
});

const watchSpec = {
  title: 'Status page',
  doneMeans: 'Tell me when it changes',
  origin: 'matter' as const,
  watch: { kind: 'http', url: 'https://status.example.com/x', everyMinutes: 60 },
};

test('Check now reads the watch at once and tells a change; Snooze moves the next check, and both refuse what is not being watched', async (t) => {
  const { w, run } = await intents(t);
  const watch = await w.tasks.createWatch(watchSpec);
  w.readings.push({ fingerprint: 'a' }, { fingerprint: 'b' });
  const first = await run['task.check']!({ id: watch.id });
  assert.equal(first.round.checked, 1);
  const second = await run['task.check']!({ id: watch.id });
  assert.equal(second.round.changed, 1);
  assert.equal((await states(w))[0], 'needs_you');
  // a change waits for the user: it is not being watched now
  await assert.rejects(run['task.check']!({ id: watch.id }), /not being watched/);
  await assert.rejects(run['task.snooze']!({ id: watch.id, forMs: 3_600_000 }), /not being watched/);
  await assert.rejects(run['task.check']!({ id: 'nope' }), /No such task/);
  const again = await w.tasks.createWatch({ ...watchSpec, title: 'Other' });
  // the Host counts the length from its own clock, whatever time a device thinks it is
  const snoozed = await run['task.snooze']!({ id: again.id, forMs: 3 * 3_600_000 });
  assert.equal(snoozed.nextCheck, w.clock.at + 3 * 3_600_000);
  const [, view] = await w.tasks.view();
  assert.equal(view.nextCheck, w.clock.at + 3 * 3_600_000);
  // a snoozed watch is not read before its time
  w.clock.at += 3_600_000;
  assert.equal((await w.tasks.tickNow()).watches.checked, 0);
  for (const bad of [0, -1, 400 * 86_400_000, Number.NaN])
    await assert.rejects(run['task.snooze']!({ id: again.id, forMs: bad }), /not a time to snooze for/);
  // a task that is working is not a watch
  const { item } = await w.tasks.create(ask);
  await assert.rejects(run['task.check']!({ id: item.id }), /not being watched/);
});
