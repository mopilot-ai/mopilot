// Remote Control that keeps trying (electron/harness/claude/remoteControl.cjs): reconnects that climb from seconds to minutes for a day,
// a timeout or a 5xx retried like a lost network, the network returning or the computer waking cutting a wait short, a reattach that
// falls back to a new bridge, the day's deadline kept across a restart, and which links hold their CLI. The clock and the network are the test's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileOf, later, link, setup, tick } from './support/remote-control-kit.ts';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { RETRY_MS, RETRY_SLOW_MS, RECONNECT_WAIT_MS } = require('../electron/harness/claude/remoteControl.cjs');

const world = () => ({ net: { up: true }, clock: { t: 1_000_000 } });
const rejecting = (message: string) => (on: boolean) => (on ? Promise.reject(new Error(message)) : undefined);
const enables = (s: any) => s.q.calls.filter((c: any[]) => c[0] === true);
const written = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).choices;

async function until(ok: () => boolean) {
  await waitFor(ok, 'the condition');
}

test('reconnecting climbs from seconds to minutes, then gives up after a day and stays given up', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  const s = session();
  await rc.set(s, true);
  w.net.up = false;
  await rc.tick();
  w.net.up = true;
  s.q.answer = rejecting('read ECONNRESET');
  // the first try is at once, as the network is back; each later one waits longer, up to the slow pace
  await rc.tick();
  assert.equal(enables(s).length, 2);
  for (const wait of [RETRY_MS[1], RETRY_MS[2], RETRY_MS[3], RETRY_SLOW_MS, RETRY_SLOW_MS]) {
    const before = enables(s).length;
    w.clock.t += wait - 1;
    await rc.tick();
    assert.equal(enables(s).length, before, `not before ${wait}`);
    w.clock.t += 1;
    await rc.tick();
    assert.equal(enables(s).length, before + 1, `at ${wait}`);
    assert.equal(rc.view(s).state, 'offline');
  }
  // a day after it was lost the next failure is final, and nothing more is asked
  w.clock.t += RECONNECT_WAIT_MS;
  await rc.tick();
  assert.deepEqual(rc.view(s), { state: 'error', url: null, error: "Couldn't reconnect Remote Control", wanted: true });
  const asked = enables(s).length;
  w.clock.t += 10 * RETRY_SLOW_MS;
  await rc.tick();
  assert.equal(enables(s).length, asked);
  // asking again by hand starts a new wait, not the one that is over
  const again = await rc.set(s, true);
  assert.equal(again.state, 'offline');
});

test('a 5xx is retried, a refusal is an error', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  const s = session();
  s.q.answer = rejecting('503 Service Unavailable');
  assert.equal((await rc.set(s, true)).state, 'offline');
  w.clock.t += RETRY_MS[0];
  s.q.answer = () => link('a');
  await rc.tick();
  assert.equal(rc.view(s).state, 'on');
  const t = session({ sessionId: 't' });
  t.q.answer = rejecting('Remote Control is not allowed here');
  assert.equal((await rc.set(t, true)).state, 'error');
});

test('the network coming back, or the computer waking, cuts a long wait short and starts the climb again', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  const s = session();
  await rc.set(s, true);
  w.net.up = false;
  await rc.tick();
  w.net.up = true;
  s.q.answer = rejecting('read ECONNRESET');
  await rc.tick();
  for (const wait of [RETRY_MS[1], RETRY_MS[2], RETRY_MS[3]]) {
    w.clock.t += wait;
    await rc.tick();
  }
  const slow = enables(s).length;
  // far from its next try: the network going and returning is not waited out
  w.net.up = false;
  await rc.tick();
  assert.equal(enables(s).length, slow, 'nothing is asked while the network is down');
  w.net.up = true;
  await rc.tick();
  assert.equal(enables(s).length, slow + 1);
  // the same after a sleep, which no tick saw
  w.clock.t += 1;
  await rc.tick();
  assert.equal(enables(s).length, slow + 1, 'the wait after that try is back to the short one');
  await rc.wake();
  assert.equal(enables(s).length, slow + 2);
  // a link that is up is not asked about on waking
  const up = session({ sessionId: 'up' });
  await rc.set(up, true);
  await rc.wake();
  assert.equal(enables(up).length, 1);
});

test('the computer waking is listened for only while a link is watched', async () => {
  const hooks: Array<() => void> = [];
  let stopped = 0;
  const { rc, session } = setup({
    file: null,
    ticking: true,
    onResume: (fn) => (hooks.push(fn), () => void stopped++),
  });
  const a = session({ sessionId: 'a' });
  const b = session({ sessionId: 'b' });
  await rc.set(a, true);
  await rc.set(b, true);
  assert.equal(hooks.length, 1, 'one listener for all links');
  hooks[0]();
  await tick();
  rc.onEnd(a);
  assert.equal(stopped, 0);
  rc.onEnd(b);
  assert.equal(stopped, 1);
});

test('a link is held while it is wanted and on its way, and not once it is off, given up, or never was', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  const s = session();
  assert.equal(rc.holds(s), false);
  assert.equal(rc.holds(undefined), false);
  const pending = later();
  s.q.answer = () => pending.promise;
  const connecting = rc.set(s, true);
  await tick();
  assert.equal(rc.holds(s), true, 'connecting');
  pending.resolve(link('a'));
  await connecting;
  assert.equal(rc.holds(s), true, 'on');
  w.net.up = false;
  await rc.tick();
  assert.equal(rc.holds(s), true, 'offline');
  s.rc.phase = 'signin';
  assert.equal(rc.holds(s), true, 'waiting for a sign-in');
  s.rc.phase = 'error';
  assert.equal(rc.holds(s), false);
  s.rc.phase = 'on';
  await rc.set(s, false);
  assert.equal(rc.holds(s), false, 'off');
});

test('a reattach that fails with the network up is retried on a new bridge, and the old one is forgotten', async () => {
  const w = world();
  const f = fileOf();
  fs.writeFileSync(f, JSON.stringify({ connectNew: false, choices: { x: { on: true, bridge: 'cse_gone' } } }));
  const { rc, session } = setup({ ...w, file: f });
  const s = session();
  s.q.answer = rejecting('503 Service Unavailable');
  const v = await rc.set(s, true, { reattach: 'cse_gone' });
  assert.equal(v.state, 'offline');
  assert.equal(written(f).x.bridge, undefined);
  w.clock.t += RETRY_MS[0];
  s.q.answer = () => link('new');
  await rc.tick();
  assert.equal(rc.view(s).state, 'on');
  assert.deepEqual(enables(s).at(-1), [true, 'project', { keepSessionOnExit: true }]);
  assert.equal(written(f).x.bridge, 'cse_new');
});

test('the day for a link that keeps failing survives a restart, and a text that only mentions a 5xx number is a refusal', async () => {
  const w = world();
  const f = fileOf();
  const { rc, session } = setup({ ...w, file: f });
  const s = session({ account: 'acct-1' });
  s.q.answer = rejecting('read ECONNRESET');
  await rc.set(s, true);
  assert.equal(written(f).x.lostSince, w.clock.t);
  // a restart a day later: the new process knows when the link was lost, so its first failure is final
  w.clock.t += RECONNECT_WAIT_MS + 1;
  const again = setup({ ...w, file: f });
  const t = session({ account: 'acct-1' });
  again.live.add(t);
  t.q.answer = rejecting('read ECONNRESET');
  again.rc.onStart(t, { fresh: false });
  await until(() => t.rc.phase === 'error');
  assert.equal(t.rc.error, "Couldn't reconnect Remote Control");
  const u = session({ sessionId: 'u' });
  u.q.answer = rejecting('limit of 500 sessions reached');
  assert.equal((await rc.set(u, true)).state, 'error');
});

const shutdown = (reason?: string) => ({ type: 'system', subtype: 'worker_shutting_down', reason });

test('a bridge the CLI took down on purpose shows as reconnecting and is reattached at once', async () => {
  const w = world();
  const f = fileOf();
  const { rc, events, session } = setup({ ...w, file: f });
  const s = session();
  await rc.set(s, true);
  const seen = events.length;
  rc.onMessage(s, shutdown('worker_restart'), false);
  // the state went out before the reattach finished
  assert.equal(events[seen].state, 'offline');
  assert.equal(events[seen].error, 'Reconnecting Remote Control');
  await until(() => enables(s).length === 2 && rc.view(s).state === 'on');
  assert.deepEqual(enables(s).at(-1), [true, 'project', { keepSessionOnExit: true, reattachSessionId: 'cse_a' }]);
  assert.equal(written(f).x.bridge, 'cse_a');
});

test('a bridge that will not come back with the network up is retried, like any lost link', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  const s = session();
  await rc.set(s, true);
  s.q.answer = rejecting('503 Service Unavailable');
  rc.onMessage(s, shutdown(), false);
  await until(() => enables(s).length === 2 && rc.view(s).state === 'offline');
  w.clock.t += RETRY_MS[1];
  s.q.answer = () => link('b');
  await rc.tick();
  assert.equal(rc.view(s).state, 'on');
});

test('a bridge the server refuses to take back is replaced by a new one, as at a start', async () => {
  const w = world();
  const f = fileOf();
  const { rc, session } = setup({ ...w, file: f });
  const s = session();
  await rc.set(s, true);
  s.q.answer = (_on: boolean, _title: string, o: any) =>
    o.reattachSessionId ? Promise.reject(new Error('session not found')) : link('new');
  rc.onMessage(s, shutdown('worker_restart'), false);
  await until(() => rc.view(s).state === 'on' && enables(s).length === 3);
  assert.deepEqual(enables(s).at(-1), [true, 'project', { keepSessionOnExit: true }]);
  assert.equal(written(f).x.bridge, 'cse_new');
});

test('a teardown for the CLI exiting is left to its end; someone else turning the link off turns it off here for good', async () => {
  const w = world();
  const f = fileOf();
  const { rc, events, session } = setup({ ...w, file: f });
  const exiting = session({ sessionId: 'exiting' });
  await rc.set(exiting, true);
  rc.onMessage(exiting, shutdown('host_exit'), false);
  assert.equal(rc.view(exiting).state, 'on');
  assert.equal(enables(exiting).length, 1);
  const off = session({ sessionId: 'off' });
  await rc.set(off, true);
  const seen = events.length;
  rc.onMessage(off, shutdown('remote_control_disabled'), false);
  assert.deepEqual(rc.view(off), { state: 'off', url: null, error: null, wanted: false });
  assert.equal(events[seen].state, 'off');
  assert.deepEqual(written(f).off, { on: false });
  assert.equal(enables(off).length, 1);
  // the link is not watched any more: nothing brings it back
  w.net.up = false;
  await rc.tick();
  w.net.up = true;
  await rc.tick();
  assert.equal(enables(off).length, 1);
});

test('a teardown message leaves a link that is not up, not wanted or whose process ended alone', async () => {
  const w = world();
  const { rc, live, session } = setup({ ...w, file: null });
  // no link was ever asked for
  const plain = session({ sessionId: 'plain' });
  rc.onMessage(plain, shutdown('worker_restart'), false);
  assert.equal(plain.rc, undefined);
  // a connect under way answers for itself
  const busy = session({ sessionId: 'busy' });
  const answer = later();
  busy.q.answer = () => answer.promise;
  const connecting = rc.set(busy, true);
  await tick();
  rc.onMessage(busy, shutdown('worker_restart'), false);
  assert.equal(busy.rc.phase, 'connecting');
  answer.resolve(link('c'));
  await connecting;
  assert.equal(rc.view(busy).state, 'on');
  // a link the user no longer wants, and a process that ended
  const unwanted = session({ sessionId: 'unwanted' });
  await rc.set(unwanted, true);
  unwanted.rc.want = false;
  rc.onMessage(unwanted, shutdown('worker_restart'), false);
  assert.equal(unwanted.rc.phase, 'on');
  const gone = session({ sessionId: 'gone' });
  await rc.set(gone, true);
  live.delete(gone);
  rc.onMessage(gone, shutdown('worker_restart'), false);
  assert.equal(gone.rc.phase, 'on');
  assert.equal(enables(gone).length, 1);
});

test('only a start and a teardown are Remote Control news; a start passes on whether the chat is a new one', async () => {
  const { rc, session } = setup({ file: null });
  const s = session();
  rc.onMessage(s, { type: 'assistant' }, true);
  rc.onMessage(s, { type: 'system', subtype: 'commands_changed' }, true);
  assert.equal(s.rc, undefined);
  rc.onMessage(s, { type: 'system', subtype: 'init' }, false);
  assert.equal(s.rc.started, true);
});
