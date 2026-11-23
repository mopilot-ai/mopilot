// Remote Control that outlasts trouble (electron/harness/claude/remoteControl.cjs): the network going and coming back, a connect
// that times out or meets a 5xx, both retried with a growing wait for up to a day (and at once when the network returns or the
// computer wakes), a sign-in that is waited for up to a day on the same login, and a /clear whose new chat takes the link over.
// The clock and the network are the test's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { clearIgnored, createRemoteControl, dir, fileOf, later, link, recentIgnored, setup, tick } from './support/remote-control-kit.ts';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { SIGNIN_WAIT_MS, RETRY_MS, CLEAR_WINDOW_MS } = require('../electron/harness/claude/remoteControl.cjs');

const world = () => ({ net: { up: true }, clock: { t: 1_000_000 } });
const rejecting = (message: string) => (on: boolean) => (on ? Promise.reject(new Error(message)) : undefined);
const enables = (s: any) => s.q.calls.filter((c: any[]) => c[0] === true);
const written = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).choices;

test('the network going shows the link as offline, and its return reconnects to the same bridge', async () => {
  const w = world();
  const { rc, events, session } = setup({ ...w, file: null });
  const s = session();
  await rc.set(s, true);
  await rc.tick();
  assert.equal(rc.view(s).state, 'on');
  w.net.up = false;
  await rc.tick();
  assert.deepEqual(rc.view(s), {
    state: 'offline',
    url: 'https://claude.ai/code/session_a',
    error: 'Offline: reconnecting when the network is back',
    wanted: true,
  });
  assert.equal(events.at(-1).state, 'offline');
  // still down: nothing is asked of the CLI
  await rc.tick();
  assert.equal(enables(s).length, 1);
  w.net.up = true;
  await rc.tick();
  assert.deepEqual(enables(s).at(-1), [true, 'project', { keepSessionOnExit: true, reattachSessionId: 'cse_a' }]);
  assert.equal(rc.view(s).state, 'on');
  assert.equal(rc.view(s).error, null);
});

test('a retry is not made before its wait is over', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  const s = session();
  await rc.set(s, true);
  w.net.up = false;
  await rc.tick();
  w.net.up = true;
  s.q.answer = rejecting('ENOTFOUND claude.ai');
  await rc.tick();
  assert.equal(enables(s).length, 2);
  w.clock.t += RETRY_MS[1] - 1;
  await rc.tick();
  assert.equal(enables(s).length, 2);
  w.clock.t += 1;
  s.q.answer = () => link('b');
  await rc.tick();
  assert.equal(rc.view(s).state, 'on');
  assert.equal(rc.view(s).url, 'https://claude.ai/code/session_b');
});

test('a connect that fails while the network is down waits for it; with the network up an ordinary failure is an error', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  w.net.up = false;
  const s = session();
  s.q.answer = rejecting('something odd');
  const v = await rc.set(s, true);
  assert.equal(v.state, 'offline');
  w.net.up = true;
  w.clock.t += RETRY_MS[0];
  s.q.answer = () => link('a');
  await rc.tick();
  assert.equal(rc.view(s).state, 'on');
  assert.deepEqual(enables(s).at(-1), [true, 'project', { keepSessionOnExit: true }]);
  const t = session();
  t.q.answer = rejecting('something odd');
  const e = await rc.set(t, true);
  assert.equal(e.state, 'error');
  assert.equal(e.error, 'something odd');
  await rc.tick();
  assert.equal(enables(t).length, 1);
});

test('the clock and the network are not asked about a link that is up and online', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  const s = session();
  await rc.set(s, true);
  w.clock.t += 10 * SIGNIN_WAIT_MS;
  await rc.tick();
  assert.equal(rc.view(s).state, 'on');
  assert.equal(enables(s).length, 1);
});

test('a failed sign-in is waited for, retried each minute on the same login, and restored when it works', async () => {
  const w = world();
  const f = fileOf();
  const { rc, events, session } = setup({ ...w, file: f });
  const s = session({ account: 'acct-1' });
  s.q.answer = rejecting('OAuth token has expired. Please sign in again');
  const v = await rc.set(s, true);
  assert.deepEqual(v, { state: 'signin', url: null, error: 'Sign in to Claude Code to reconnect Remote Control', wanted: true });
  assert.equal(events.at(-1).state, 'signin');
  assert.deepEqual(written(f).x, { on: true, account: 'acct-1', waitSince: w.clock.t });
  await rc.tick();
  assert.equal(enables(s).length, 1);
  w.clock.t += 61_000;
  await rc.tick();
  assert.equal(enables(s).length, 2);
  assert.equal(rc.view(s).state, 'signin');
  // signed in: the next try works, and what is remembered no longer waits
  w.clock.t += 61_000;
  s.q.answer = () => link('a');
  await rc.tick();
  assert.equal(rc.view(s).state, 'on');
  assert.deepEqual(written(f).x, { on: true, bridge: 'cse_a', account: 'acct-1' });
});

test('a sign-in that does not come within a day ends the wait and forgets the link', async () => {
  const w = world();
  const f = fileOf();
  const { rc, session } = setup({ ...w, file: f });
  const s = session({ account: 'acct-1' });
  s.q.answer = rejecting('401 Unauthorized');
  await rc.set(s, true);
  w.clock.t += SIGNIN_WAIT_MS + 1;
  await rc.tick();
  assert.deepEqual(rc.view(s), {
    state: 'error',
    url: null,
    error: 'Remote Control was not reconnected: no sign-in within a day',
    wanted: false,
  });
  assert.equal(written(f).x, undefined);
  const before = enables(s).length;
  w.clock.t += 1_000_000;
  await rc.tick();
  assert.equal(enables(s).length, before);
});

test('our own timeouts are not taken for a sign-in; they are retried like the network', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null, requestMs: 10 });
  const s = session();
  s.q.answer = () => new Promise(() => {});
  const v = await rc.set(s, true);
  assert.deepEqual(v, { state: 'offline', url: null, error: 'Reconnecting Remote Control', wanted: true });
  w.clock.t += RETRY_MS[0];
  s.q.answer = () => link('a');
  await rc.tick();
  assert.equal(rc.view(s).state, 'on');
});

test('a started process takes up a remembered sign-in wait on its own login only, and gives up one that is over', async () => {
  const w = world();
  const f = fileOf();
  const waiting = { on: true, bridge: 'cse_old', account: 'acct-1', waitSince: w.clock.t - 1000 };
  fs.writeFileSync(
    f,
    JSON.stringify({
      connectNew: false,
      choices: {
        same: waiting,
        other: waiting,
        old: { ...waiting, waitSince: w.clock.t - SIGNIN_WAIT_MS - 1 },
        unknown: { on: true, bridge: 'cse_u' },
      },
    }),
  );
  const { rc, session } = setup({ ...w, file: f });
  const same = session({ sessionId: 'same', account: 'acct-1' });
  rc.onStart(same, { fresh: false });
  await until(() => same.rc.phase === 'on');
  assert.deepEqual(enables(same)[0][2], { keepSessionOnExit: true, reattachSessionId: 'cse_old' });
  // another login is not linked in its place, and keeps the choice for the login it was made on
  const other = session({ sessionId: 'other', account: 'acct-2' });
  rc.onStart(other, { fresh: false });
  await tick();
  assert.equal(enables(other).length, 0);
  assert.equal(written(f).other.account, 'acct-1');
  // a wait over a day old is dropped
  const old = session({ sessionId: 'old', account: 'acct-1' });
  rc.onStart(old, { fresh: false });
  await tick();
  assert.equal(enables(old).length, 0);
  assert.equal(written(f).old, undefined);
  // a choice made before logins were recorded, or a session that names none, is taken as it is
  const unknown = session({ sessionId: 'unknown' });
  rc.onStart(unknown, { fresh: false });
  await until(() => unknown.rc.phase === 'on');
  // and a wait that is still on resumes as a wait when the sign-in still fails
  const again = session({ sessionId: 'again', account: 'acct-1' });
  fs.writeFileSync(f, JSON.stringify({ connectNew: false, choices: { again: waiting } }));
  const fresh = setup({ ...w, file: f });
  fresh.live.add(again);
  again.q.answer = rejecting('Please log in');
  fresh.rc.onStart(again, { fresh: false });
  await until(() => again.rc.phase === 'signin');
  assert.equal(again.rc.signin.since, waiting.waitSince);
});

test('the new chat after a /clear takes over the link of the chat it replaced, once and soon', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  const old = session({ sessionId: 'old' });
  await rc.set(old, true);
  await rc.release('old', old, { cleared: true });
  assert.equal(rc.view(old).state, 'off');
  // a resumed chat is not the new one
  const resumed = session({ sessionId: 'resumed' });
  rc.onStart(resumed, { fresh: false });
  await tick();
  assert.equal(enables(resumed).length, 0);
  const next = session({ sessionId: 'next' });
  rc.onStart(next, { fresh: true });
  await until(() => next.rc.phase === 'on');
  const later1 = session({ sessionId: 'later1' });
  rc.onStart(later1, { fresh: true });
  await tick();
  assert.equal(enables(later1).length, 0);
});

test('a /clear carries a link over only if the chat had one, and not after the window', async () => {
  const w = world();
  const f = fileOf();
  fs.writeFileSync(f, JSON.stringify({ connectNew: false, choices: { remembered: { on: true, bridge: 'cse_r' } } }));
  const { rc, session } = setup({ ...w, file: f });
  // a chat that had no link
  const plain = session({ sessionId: 'plain' });
  await rc.release('plain', plain, { cleared: true });
  const a = session({ sessionId: 'a' });
  rc.onStart(a, { fresh: true });
  await tick();
  assert.equal(enables(a).length, 0);
  // a chat whose link was remembered but not live
  await rc.release('remembered', undefined, { cleared: true });
  const b = session({ sessionId: 'b' });
  rc.onStart(b, { fresh: true });
  await until(() => b.rc.phase === 'on');
  // too late
  const c = session({ sessionId: 'c' });
  await rc.set(c, true);
  await rc.release('c', c, { cleared: true });
  w.clock.t += CLEAR_WINDOW_MS + 1;
  const d = session({ sessionId: 'd' });
  rc.onStart(d, { fresh: true });
  await tick();
  assert.equal(enables(d).length, 0);
});

test('the check runs on a timer while a link is wanted, and stops when none is', async () => {
  const { rc, session } = setup({ file: null, ticking: true });
  const a = session({ sessionId: 'a' });
  const b = session({ sessionId: 'b' });
  await rc.set(a, true);
  await rc.set(b, true);
  rc.onEnd(a);
  rc.onEnd(b);
  await rc.set(a, false);
  assert.equal(rc.view(a).state, 'off');
});

test('the check lets go of a session that ended, stopped wanting its link, or is no longer in a waiting phase', async () => {
  const w = world();
  const { rc, live, session } = setup({ ...w, file: null });
  const gone = session({ sessionId: 'gone' });
  const unwanted = session({ sessionId: 'unwanted' });
  const settled = session({ sessionId: 'settled' });
  for (const s of [gone, unwanted, settled]) await rc.set(s, true);
  live.delete(gone);
  unwanted.rc.want = false;
  settled.rc.phase = 'error';
  w.net.up = false;
  await rc.tick();
  for (const s of [unwanted, settled]) assert.notEqual(s.rc.phase, 'offline');
  assert.equal(gone.rc.phase, 'on');
  w.net.up = true;
  await rc.tick();
  assert.equal(enables(gone).length, 1);
});

test('a retry under way is not started again by the next check', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  const s = session();
  await rc.set(s, true);
  w.net.up = false;
  await rc.tick();
  w.net.up = true;
  const answer = later();
  s.q.answer = () => answer.promise;
  const first = rc.tick();
  await tick();
  assert.equal(s.rc.phase, 'connecting');
  await rc.tick();
  assert.equal(enables(s).length, 2);
  answer.resolve(link('a'));
  await first;
  assert.equal(rc.view(s).state, 'on');
});

test('releasing or turning off a session that waits stops the waiting', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null });
  const a = session({ sessionId: 'a' });
  await rc.set(a, true);
  w.net.up = false;
  await rc.tick();
  assert.equal(a.rc.phase, 'offline');
  await rc.release('a', a);
  assert.equal(rc.view(a).state, 'off');
  w.net.up = true;
  await rc.tick();
  assert.equal(enables(a).length, 1);
  const b = session({ sessionId: 'b' });
  b.q.answer = rejecting('please sign in');
  await rc.set(b, true);
  b.q.answer = () => undefined;
  await rc.set(b, false);
  w.clock.t += 10 * SIGNIN_WAIT_MS;
  await rc.tick();
  assert.equal(rc.view(b).state, 'off');
});

test('a disconnect that fails leaves the link watched, so it is not lost when the network goes', async () => {
  const w = world();
  const { rc, session } = setup({ ...w, file: null, requestMs: 20 });
  const s = session();
  await rc.set(s, true);
  s.q.answer = () => Promise.reject(new Error('bridge busy'));
  await assert.rejects(rc.set(s, false), /bridge busy/);
  w.net.up = false;
  await rc.tick();
  assert.equal(rc.view(s).state, 'offline');
});

test('a window that cannot hear the state does not stop a retry or the other sessions', async () => {
  clearIgnored();
  const w = world();
  let fails = false;
  const { rc, session } = setup({ ...w, file: null, emitFails: () => fails });
  const a = session({ sessionId: 'a' });
  const b = session({ sessionId: 'b' });
  await rc.set(a, true);
  await rc.set(b, true);
  w.net.up = false;
  await rc.tick();
  w.net.up = true;
  fails = true;
  await rc.tick();
  assert.ok(recentIgnored().some((e: any) => e.context === 'publish the state of a Remote Control link'));
  assert.equal(enables(b).length, 2);
  assert.equal(rc.view(b).state, 'on');
});

async function until(ok: () => boolean) {
  await waitFor(ok, 'the condition');
}
void dir;

test('a state that knows nothing of the network or a file takes the network as up and keeps its choices in memory', async () => {
  const live = new Set<any>();
  const rc = createRemoteControl({ emit: () => {} }, { lifetime: { active: (s: any) => live.has(s) }, note: () => {}, ticking: false });
  const s: any = { key: 'claude:x', sessionId: 'x', cwd: '/w', q: { enableRemoteControl: async () => link() } };
  live.add(s);
  assert.equal((await rc.set(s, true)).state, 'on');
  await rc.tick();
  assert.equal(rc.view(s).state, 'on');
});
