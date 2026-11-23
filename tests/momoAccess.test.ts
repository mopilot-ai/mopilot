// MoMo's closed-alpha gate (electron/momo/access.cjs): the server's invite, the kill switch, the offline week, sign-out and account switches, the revoke timer, and the app's one instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const access = require('../electron/momo/access.cjs');
const { MomoAccess, decide, MAX_OFFLINE_MS, REFRESH_MS } = access;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-access-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `access-${++n}.json`);

const T = 1_000_000_000;
const invited = { signedIn: true, user: { id: 'u1', features: ['momo'] }, checkedAt: T };
const uninvited = { signedIn: true, user: { id: 'u1', features: [] }, checkedAt: T };

function rig(o: { file?: string; flagOn?: boolean; now?: number; refresh?: () => unknown } = {}) {
  const sets: { fn: () => void; ms: number; unrefd: boolean }[] = [];
  const cleared: unknown[] = [];
  const broadcasts: boolean[] = [];
  let now = o.now ?? T;
  let flag = o.flagOn ?? true;
  const refreshes: number[] = [];
  const gate = new MomoAccess({
    file: o.file ?? file(),
    refresh: o.refresh ?? (() => void refreshes.push(now)),
    broadcast: (a: boolean) => void broadcasts.push(a),
    flagOn: () => flag,
    now: () => now,
    timers: {
      set: (fn: () => void, ms: number) => {
        const t = { fn, ms, unrefd: false, unref: () => (t.unrefd = true) };
        sets.push(t);
        return t;
      },
      clear: (t: unknown) => void cleared.push(t),
    },
  });
  return {
    gate,
    sets,
    cleared,
    broadcasts,
    refreshes,
    at: (t: number) => (now = t),
    flag: (on: boolean) => (flag = on),
  };
}

test('decide: only a signed-in account the server invited, with the switch on', () => {
  const now = T;
  assert.equal(decide({ status: invited, cache: null, flagOn: true, now }), true);
  assert.equal(decide({ status: invited, cache: null, flagOn: false, now }), false, 'the kill switch wins');
  assert.equal(decide({ status: uninvited, cache: null, flagOn: true, now }), false);
  assert.equal(decide({ status: { ...invited, signedIn: false }, cache: null, flagOn: true, now }), false, 'signed out');
  assert.equal(decide({ status: null, cache: null, flagOn: true, now }), false);
  assert.equal(decide({ status: { signedIn: true, user: { id: '' } }, cache: null, flagOn: true, now }), false, 'no account id');
  assert.equal(
    decide({ status: { signedIn: true, user: { id: 'u1', features: ['momo', 3] }, checkedAt: T }, cache: null, flagOn: true, now }),
    true,
    'non-string features are ignored',
  );
  // no answer in this run: a week-old answer for this same account still counts
  const stale = { signedIn: true, user: { id: 'u1', features: ['momo'] }, checkedAt: null };
  const cache = { userId: 'u1', allowed: true, at: T - 1000 };
  assert.equal(
    decide({ status: stale, cache, flagOn: true, now }),
    true,
    'features saved with the sign-in alone do not count, the cache does',
  );
  assert.equal(decide({ status: stale, cache: null, flagOn: true, now }), false, 'saved features without a server answer do not count');
  assert.equal(decide({ status: stale, cache: { ...cache, userId: 'u2' }, flagOn: true, now }), false, 'another account');
  assert.equal(decide({ status: stale, cache: { ...cache, allowed: false }, flagOn: true, now }), false);
  assert.equal(decide({ status: stale, cache: { ...cache, at: T - MAX_OFFLINE_MS }, flagOn: true, now }), false, 'older than a week');
  assert.equal(decide({ status: stale, cache: { ...cache, at: T + 1 }, flagOn: true, now }), false, 'from the future');
  assert.equal(
    decide({ status: { ...stale, checkedAt: T, user: { id: 'u1', features: 'momo' } }, cache, flagOn: true, now }),
    true,
    'a malformed answer falls back to the cache',
  );
  // an unpackaged build's stand-in for the invite still obeys the kill switch
  assert.equal(decide({ status: null, cache: null, flagOn: true, now, devInvite: true }), true);
  assert.equal(decide({ status: null, cache: null, flagOn: false, now, devInvite: true }), false);
});

test('waiting for the remote switches: closed until they are loaded', () => {
  const gate = new MomoAccess({
    file: file(),
    refresh: () => {},
    waitForFlags: true,
    flagOn: () => true,
    timers: { set: () => ({}), clear: () => {} },
  });
  gate.update(invited);
  assert.equal(gate.allowed(), false, 'a killed switch may not be read yet');
  gate.flagsLoaded = true;
  gate.recompute();
  assert.equal(gate.allowed(), true);
  gate.dispose();
});

test('signed out with nothing saved: nothing to remove', () => {
  const f = file();
  const r = rig({ file: f });
  r.gate.update({ signedIn: false, user: null });
  fs.writeFileSync(f, 'left by hand');
  r.gate.update({ signedIn: false, user: null });
  assert.equal(fs.readFileSync(f, 'utf8'), 'left by hand', 'no cache in memory: the file is not touched again');
});

test('a development build may stand in for the invite', () => {
  const gate = new MomoAccess({
    file: file(),
    refresh: () => {},
    devInvite: true,
    flagOn: () => true,
    timers: { set: () => ({}), clear: () => {} },
  });
  gate.update(null);
  assert.equal(gate.allowed(), true);
  gate.dispose();
});

test('an invite opens the gate, is kept for the account, and a revoke closes it', () => {
  const f = file();
  const r = rig({ file: f });
  assert.equal(r.gate.allowed(), false);
  const seen: boolean[] = [];
  const off = r.gate.onChange((a: boolean) => void seen.push(a));
  r.gate.update(invited);
  assert.equal(r.gate.allowed(), true);
  assert.deepEqual(r.broadcasts, [true]);
  assert.deepEqual(seen, [true]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { userId: 'u1', allowed: true, at: T });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'owner-only');
  // the same answer again: nothing new to save or tell
  const mtime = fs.statSync(f).mtimeMs;
  r.gate.update(invited);
  assert.equal(fs.statSync(f).mtimeMs, mtime);
  assert.deepEqual(r.broadcasts, [true]);
  r.gate.update(uninvited);
  assert.equal(r.gate.allowed(), false);
  assert.deepEqual(r.broadcasts, [true, false]);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).allowed, false);
  off();
  r.gate.update(invited);
  assert.deepEqual(seen, [true, false], 'unsubscribed');
});

test('offline at launch: last week’s answer for the same account holds; sign-out forgets it', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ userId: 'u1', allowed: true, at: T - 1000 }));
  const r = rig({ file: f });
  r.gate.update({ signedIn: true, user: { id: 'u1' }, checkedAt: null });
  assert.equal(r.gate.allowed(), true);
  r.gate.update({ signedIn: true, user: { id: 'u2' }, checkedAt: null });
  assert.equal(r.gate.allowed(), false, 'another account on this Mac');
  r.gate.update({ signedIn: false, user: null });
  assert.equal(r.gate.allowed(), false);
  assert.equal(fs.existsSync(f), false, 'signing out removes the saved answer');
  r.gate.update({ signedIn: true, user: { id: 'u1' }, checkedAt: null });
  assert.equal(r.gate.allowed(), false, 'and it does not come back');
});

test('the week runs out; a cache file that is not one is ignored', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ userId: 'u1', allowed: true, at: T }));
  const r = rig({ file: f });
  r.gate.update({ signedIn: true, user: { id: 'u1' }, checkedAt: null });
  assert.equal(r.gate.allowed(), true);
  r.at(T + MAX_OFFLINE_MS);
  r.gate.recompute();
  assert.equal(r.gate.allowed(), false);
  for (const bad of ['not json', JSON.stringify({ userId: 'u1', allowed: 'yes', at: T }), 'null']) {
    const g = file();
    fs.writeFileSync(g, bad);
    const q = rig({ file: g });
    q.gate.update({ signedIn: true, user: { id: 'u1' }, checkedAt: null });
    assert.equal(q.gate.allowed(), false, bad);
  }
});

test('the kill switch closes the gate and reopens it', () => {
  const r = rig();
  r.gate.update(invited);
  r.flag(false);
  r.gate.recompute();
  assert.equal(r.gate.allowed(), false);
  r.flag(true);
  r.gate.recompute();
  assert.equal(r.gate.allowed(), true);
  assert.deepEqual(r.broadcasts, [true, false, true]);
});

test('while open, the account is read again every 30 minutes; closing stops it', async () => {
  const r = rig();
  r.gate.update(invited);
  assert.equal(r.sets.length, 1);
  assert.equal(r.sets[0].ms, REFRESH_MS);
  assert.equal(r.sets[0].unrefd, true, 'never keeps the app alive');
  r.gate.update(invited);
  assert.equal(r.sets.length, 1, 'one timer');
  r.sets[0].fn();
  await new Promise((res) => setImmediate(res));
  assert.equal(r.refreshes.length, 1);
  r.gate.update(uninvited);
  assert.deepEqual(r.cleared, [r.sets[0]]);
  r.gate.dispose();
  assert.equal(r.cleared.length, 1, 'nothing left to clear');
  // a refresh that fails is noted, not thrown
  const failing = rig({ refresh: () => Promise.reject(new Error('offline')) });
  failing.gate.update(invited);
  failing.sets[0].fn();
  await new Promise((res) => setImmediate(res));
  failing.gate.dispose();
  assert.equal(failing.cleared.length, 1);
});

test('a cache that cannot be written keeps this run’s answer', () => {
  const blocked = path.join(dir, 'blocked');
  fs.mkdirSync(blocked);
  const r = rig({ file: blocked });
  r.gate.update(invited);
  assert.equal(r.gate.allowed(), true);
  r.gate.dispose();
});

test('the app’s one gate: closed until opened, a new one replaces the old', () => {
  assert.equal(access.momoAllowed(), false);
  access.updateMomoAccess(invited);
  access.recomputeMomoAccess();
  assert.equal(access.momoAllowed(), false, 'no gate yet');
  const broadcasts: boolean[] = [];
  const first = access.openMomoAccess({ file: file(), refresh: () => {}, broadcast: (a: boolean) => void broadcasts.push(a) });
  access.updateMomoAccess(invited);
  assert.equal(access.momoAllowed(), true);
  assert.deepEqual(broadcasts, [true]);
  const second = access.openMomoAccess({ file: file(), refresh: () => {}, waitForFlags: true });
  assert.notEqual(first, second);
  assert.equal(first.timer, null, 'the old gate stopped');
  assert.equal(access.momoAllowed(), false);
  access.updateMomoAccess(invited);
  assert.equal(access.momoAllowed(), false, 'waiting for the switches');
  access.recomputeMomoAccess();
  assert.equal(access.momoAllowed(), true, 'loaded: the default kill switch is on');
  second.dispose();
});

test('main’s MoMo services hear each change of whichever gate is open, and one that throws stops no other', () => {
  const heard: boolean[] = [];
  const off = access.onMomoAccess(() => {
    throw new Error('broken service');
  });
  const stop = access.onMomoAccess((a: boolean) => void heard.push(a));
  const gate = access.openMomoAccess({ file: file(), refresh: () => {}, flagOn: () => true });
  access.updateMomoAccess(invited);
  access.updateMomoAccess(uninvited);
  assert.deepEqual(heard, [true, false]);
  stop();
  off();
  access.updateMomoAccess(invited);
  assert.deepEqual(heard, [true, false], 'unsubscribed');
  gate.dispose();
});
