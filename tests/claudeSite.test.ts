// Whether the built-in browser's shared profile is signed in to claude.ai (electron/capabilities/browser/claudeSite.cjs):
// the cookie that counts, the change filter, latest-read-wins under overlapping changes, failed reads, the expiry
// re-read, the pushes' seq, and start/stop/start with and without IPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ClaudeSiteSignIn,
  registerClaudeSignIn,
  readAnswer,
  claudeDomain,
  isSignInCookie,
  CHANNEL,
  COOKIE,
} = require('../electron/capabilities/browser/claudeSite.cjs');

const NOW = 1_800_000_000_000;
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const cookie = (o: any = {}) => ({
  name: COOKIE,
  domain: '.claude.ai',
  value: 'sk-1',
  session: false,
  expirationDate: NOW / 1000 + 3600,
  ...o,
});

/** A session whose cookies.get answers in the order the test resolves them; `changed` is an EventEmitter's. */
function fakeSession() {
  const reads: { query: any; resolve: (v: any) => void; reject: (e: any) => void }[] = [];
  const cookies = Object.assign(new EventEmitter(), {
    get: (query: any) => new Promise((resolve, reject) => reads.push({ query, resolve, reject })),
  });
  const change = (c: any, removed = false) => cookies.emit('changed', {}, c, removed ? 'explicit' : 'inserted', removed);
  return { cookies, reads, change };
}

/** Timers the test fires by hand. */
function fakeTimers() {
  const pending = new Set<any>();
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, ms, unref: () => (t.unrefd = true), unrefd: false };
      pending.add(t);
      return t;
    },
    clearTimeout: (t: any) => pending.delete(t),
    fire: (t: any) => (pending.delete(t), t.fn()),
  };
}

function make(o: any = {}) {
  const ses = fakeSession();
  const timers = fakeTimers();
  const pushes: any[] = [];
  const signIn = new ClaudeSiteSignIn({
    session: () => ses,
    broadcast: (ch: string, payload: any) => pushes.push([ch, payload]),
    now: () => o.now?.() ?? NOW,
    timers,
    ...o,
  });
  return { signIn, ses, timers, pushes };
}

test('claudeDomain and isSignInCookie: claude.ai and its subdomains, never a lookalike or another name', () => {
  for (const d of ['claude.ai', '.claude.ai', 'CLAUDE.AI', 'www.claude.ai', '.api.claude.ai']) assert.equal(claudeDomain(d), true, d);
  for (const d of ['claude.ai.evil.com', '.claude.ai.evil.com', 'evilclaude.ai', 'claude.aix', 'anthropic.com', '', undefined, null])
    assert.equal(claudeDomain(d), false, String(d));
  assert.equal(isSignInCookie(cookie()), true);
  assert.equal(isSignInCookie(cookie({ name: 'other' })), false);
  assert.equal(isSignInCookie(cookie({ domain: 'claude.ai.evil.com' })), false);
  assert.equal(isSignInCookie(null), false);
});

test('readAnswer: a sessionKey with a value counts while unexpired or as a session cookie; until is the soonest expiry', () => {
  assert.deepEqual(readAnswer([cookie()], NOW), { signedIn: true, until: NOW + 3_600_000 });
  assert.deepEqual(readAnswer([cookie({ session: true, expirationDate: undefined })], NOW), { signedIn: true, until: Infinity });
  // no expirationDate at all reads as a session cookie
  assert.deepEqual(readAnswer([cookie({ session: undefined, expirationDate: undefined })], NOW), { signedIn: true, until: Infinity });
  // expired, exactly at expiry, empty, another name, another site, nothing, not a list
  assert.deepEqual(readAnswer([cookie({ expirationDate: NOW / 1000 - 1 })], NOW), { signedIn: false, until: Infinity });
  assert.deepEqual(readAnswer([cookie({ expirationDate: NOW / 1000 })], NOW), { signedIn: false, until: Infinity });
  assert.equal(readAnswer([cookie({ value: '' })], NOW).signedIn, false);
  assert.equal(readAnswer([cookie({ name: 'lastActiveOrg' })], NOW).signedIn, false);
  assert.equal(readAnswer([cookie({ domain: 'claude.ai.evil.com' })], NOW).signedIn, false);
  assert.equal(readAnswer([], NOW).signedIn, false);
  assert.equal(readAnswer(undefined, NOW).signedIn, false);
  // malformed: an expiry that is not a number, a value that is not a string
  for (const expirationDate of ['9999999999', null, NaN, Infinity])
    assert.equal(readAnswer([cookie({ expirationDate })], NOW).signedIn, false, String(expirationDate));
  assert.equal(readAnswer([cookie({ value: 123 })], NOW).signedIn, false);
  // two that count: the sooner expiry re-reads
  const two = readAnswer([cookie({ expirationDate: NOW / 1000 + 50 }), cookie({ expirationDate: NOW / 1000 + 10 })], NOW);
  assert.deepEqual(two, { signedIn: true, until: NOW + 10_000 });
});

test('start reads claude.ai sessionKey, publishes it with seq 1, and runs with no window (broadcast reaches nobody)', async () => {
  const { signIn, ses, pushes } = make();
  // no read yet: unknown
  assert.deepEqual(await signIn.state(), { signedIn: null, seq: 0 });
  signIn.start();
  await flush();
  assert.equal(ses.reads.length, 1);
  assert.deepEqual(ses.reads[0].query, { url: 'https://claude.ai', name: 'sessionKey' });
  const snapshot = signIn.state();
  ses.reads[0].resolve([cookie()]);
  // state() waits for the read in flight
  assert.deepEqual(await snapshot, { signedIn: true, seq: 1 });
  assert.deepEqual(pushes, [[CHANNEL, { signedIn: true, seq: 1 }]]);
  assert.equal(CHANNEL, 'browser:claudeSignIn');
  // a second start does nothing
  signIn.start();
  await flush();
  assert.equal(ses.reads.length, 1);
  assert.equal(ses.cookies.listenerCount('changed'), 1);
});

test('a change during a read in flight: the stale answer is discarded and one coalesced re-read publishes the newer one', async () => {
  const { signIn, ses, pushes } = make();
  signIn.start();
  await flush();
  // two changes while the first read is out: one re-read after it, not two
  ses.change(cookie());
  ses.change(cookie());
  ses.reads[0].resolve([]); // stale: read before the sign-in landed
  await flush();
  assert.deepEqual(pushes, [], 'the stale answer is never published');
  assert.equal(ses.reads.length, 2);
  ses.reads[1].resolve([cookie()]);
  await flush();
  assert.deepEqual(pushes, [[CHANNEL, { signedIn: true, seq: 1 }]]);
  assert.equal(ses.reads.length, 2);
  assert.deepEqual(await signIn.state(), { signedIn: true, seq: 1 });
});

test('only claude.ai sessionKey changes re-read; a removed cookie signs out; an unchanged answer is not pushed again', async () => {
  const { signIn, ses, pushes } = make();
  signIn.start();
  await flush();
  ses.reads[0].resolve([cookie()]);
  await flush();
  // another cookie, another site, a lookalike: no read
  ses.change(cookie({ name: 'lastActiveOrg' }));
  ses.change(cookie({ domain: '.anthropic.com' }));
  ses.change(cookie({ domain: 'claude.ai.evil.com' }));
  ses.change(null);
  await flush();
  assert.equal(ses.reads.length, 1);
  // a refresh of the same cookie: re-read, still signed in, no push
  ses.change(cookie({ value: 'sk-2' }));
  await flush();
  ses.reads[1].resolve([cookie({ value: 'sk-2' })]);
  await flush();
  assert.equal(pushes.length, 1);
  // sign-out removes it
  ses.change(cookie(), true);
  await flush();
  ses.reads[2].resolve([]);
  await flush();
  assert.deepEqual(pushes.at(-1), [CHANNEL, { signedIn: false, seq: 2 }]);
});

test('an expired cookie reads as signed out', async () => {
  const { signIn, ses, pushes } = make();
  signIn.start();
  await flush();
  ses.reads[0].resolve([cookie({ expirationDate: NOW / 1000 - 60 })]);
  await flush();
  assert.deepEqual(pushes, [[CHANNEL, { signedIn: false, seq: 1 }]]);
});

test('a rejected read keeps null while nothing was decided, and the last answer after one was', async () => {
  const { signIn, ses, pushes } = make();
  signIn.start();
  await flush();
  ses.reads[0].reject(new Error('cookie store gone'));
  await flush();
  assert.deepEqual(await signIn.state(), { signedIn: null, seq: 0 });
  assert.deepEqual(pushes, []);
  ses.change(cookie());
  await flush();
  ses.reads[1].resolve([cookie()]);
  await flush();
  ses.change(cookie(), true);
  await flush();
  ses.reads[2].reject(new Error('busy'));
  await flush();
  assert.deepEqual(await signIn.state(), { signedIn: true, seq: 1 });
  assert.equal(pushes.length, 1);
});

test('the soonest expiry re-reads (unref, capped at the longest delay), and a session cookie cancels it', async () => {
  let now = NOW;
  const { signIn, ses, timers, pushes } = make({ now: () => now });
  signIn.start();
  await flush();
  ses.reads[0].resolve([cookie({ expirationDate: NOW / 1000 + 30 })]);
  await flush();
  const [early] = timers.pending;
  assert.equal(early.ms, 30_000);
  assert.equal(early.unrefd, true);
  // the timer fires with the clock held still: the re-read keeps the answer, pushes nothing and waits again
  timers.fire(early);
  await flush();
  ses.reads[1].resolve([cookie({ expirationDate: NOW / 1000 + 30 })]);
  await flush();
  assert.equal(pushes.length, 1);
  const [t] = timers.pending;
  assert.equal(t.ms, 30_000);
  // Chromium never announced the expiry: the timer re-reads
  now += 30_000;
  timers.fire(t);
  await flush();
  ses.reads[2].resolve([cookie({ expirationDate: NOW / 1000 + 30 })]);
  await flush();
  assert.deepEqual(pushes.at(-1), [CHANNEL, { signedIn: false, seq: 2 }]);
  assert.equal(timers.pending.size, 0, 'nothing counts: no expiry to wait for');
  // a far expiry waits setTimeout's longest delay, then reads again
  ses.change(cookie());
  await flush();
  ses.reads[3].resolve([cookie({ expirationDate: now / 1000 + 100 * 86_400 })]);
  await flush();
  assert.equal([...timers.pending][0].ms, 2 ** 31 - 1);
  // a session cookie needs no timer: the pending one goes
  ses.change(cookie());
  await flush();
  ses.reads[4].resolve([cookie({ session: true })]);
  await flush();
  assert.equal(timers.pending.size, 0);
});

test('stop discards the read in flight and the expiry, keeps the last answer; start again follows the profile anew', async () => {
  const { signIn, ses, timers, pushes } = make();
  signIn.start();
  await flush();
  ses.reads[0].resolve([cookie()]);
  await flush();
  assert.equal(timers.pending.size, 1);
  ses.change(cookie(), true);
  await flush();
  signIn.stop();
  assert.equal(ses.cookies.listenerCount('changed'), 0);
  assert.equal(timers.pending.size, 0);
  ses.reads[1].resolve([]);
  await flush();
  assert.deepEqual(pushes.length, 1, 'the read stop() overtook is discarded');
  assert.deepEqual(await signIn.state(), { signedIn: true, seq: 1 });
  // a change after stop is not followed; a second stop does nothing
  ses.change(cookie(), true);
  signIn.stop();
  await flush();
  assert.equal(ses.reads.length, 2);
  // setup again: one listener, a fresh read, seq keeps counting
  signIn.start();
  await flush();
  assert.equal(ses.cookies.listenerCount('changed'), 1);
  ses.reads[2].resolve([]);
  await flush();
  assert.deepEqual(pushes.at(-1), [CHANNEL, { signedIn: false, seq: 2 }]);
});

test('stop then start while a read is out: the one read loop carries on against the session started again', async () => {
  const { signIn, ses, pushes } = make();
  signIn.start();
  await flush();
  signIn.stop();
  signIn.start();
  ses.reads[0].resolve([]);
  await flush();
  // the first answer was overtaken by stop/start: read again, once
  assert.equal(ses.reads.length, 2);
  ses.reads[1].resolve([cookie()]);
  await flush();
  assert.deepEqual(pushes, [[CHANNEL, { signedIn: true, seq: 1 }]]);
});

test('a session without cookie events or reads: the answer stays unknown, and stop has nothing to remove', async () => {
  const pushes: any[] = [];
  const signIn = new ClaudeSiteSignIn({ session: () => ({}), broadcast: (...a: any[]) => pushes.push(a) });
  signIn.start();
  await flush();
  assert.deepEqual(await signIn.state(), { signedIn: null, seq: 0 });
  signIn.stop();
  assert.deepEqual(pushes, []);
  // defaults: the real clock and timers
  assert.equal(signIn.now, Date.now);
  assert.equal(signIn.timers.setTimeout, setTimeout);
});

test('a read that throws before it waits never leaves a later change without a read', async () => {
  let calls = 0;
  const cookies = Object.assign(new EventEmitter(), {
    get: () => {
      calls++;
      if (calls === 1) throw new Error('sync failure');
      return Promise.resolve([cookie()]);
    },
  });
  const pushes: any[] = [];
  const signIn = new ClaudeSiteSignIn({ session: () => ({ cookies }), broadcast: (...a: any[]) => pushes.push(a), now: () => NOW });
  signIn.start();
  await flush();
  assert.equal(signIn.reading, null);
  cookies.emit('changed', {}, cookie(), 'inserted', false);
  await flush();
  assert.deepEqual(pushes, [[CHANNEL, { signedIn: true, seq: 1 }]]);
  signIn.stop();
});

test('a push that throws keeps the answer, the snapshot and the expiry re-read', async () => {
  const { signIn, ses, timers } = make({
    broadcast: () => {
      throw new Error('Render frame was disposed');
    },
  });
  signIn.start();
  await flush();
  ses.reads[0].resolve([cookie()]);
  assert.deepEqual(await signIn.state(), { signedIn: true, seq: 1 });
  assert.equal(timers.pending.size, 1);
  signIn.stop();
});

test('registerClaudeSignIn: the invoke answers the state; dispose removes it, and setup works again', async () => {
  const handlers = new Map<string, Function>();
  const ipcMain = {
    handle: (ch: string, f: Function) => {
      if (handlers.has(ch)) throw new Error(`second handler for ${ch}`);
      handlers.set(ch, f);
    },
    removeHandler: (ch: string) => handlers.delete(ch),
  };
  const ses = fakeSession();
  const pushes: any[] = [];
  const reg = registerClaudeSignIn({ ipcMain, session: () => ses, broadcast: (...a: any[]) => pushes.push(a), now: () => NOW });
  await flush();
  const answer = handlers.get(CHANNEL)!();
  ses.reads[0].resolve([cookie({ session: true })]);
  assert.deepEqual(await answer, { signedIn: true, seq: 1 });
  reg.dispose();
  assert.equal(handlers.has(CHANNEL), false);
  assert.equal(ses.cookies.listenerCount('changed'), 0);
  const again = registerClaudeSignIn({ ipcMain, session: () => ses, broadcast: (...a: any[]) => pushes.push(a), now: () => NOW });
  await flush();
  ses.reads[1].resolve([]);
  assert.deepEqual(await handlers.get(CHANNEL)!(), { signedIn: false, seq: 1 });
  assert.equal(ses.cookies.listenerCount('changed'), 1);
  again.dispose();
});
