// Host's gate (electron/host/access.cjs): every signed-in account while the host.enabled kill switch is on (no invite since it left the closed alpha), sign-out and account switches, the account timer, and the app's one instance; the invite mode stays MoMo's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const host = require('../electron/host/access.cjs');
const { decide, MomoAccess, REFRESH_MS } = require('../electron/momo/access.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-access-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => fs.mkdtempSync(path.join(dir, `d${++n}-`));

const T = 1_000_000_000;
const now = T + 1000;
const invited = { signedIn: true, user: { id: 'u1', features: ['host'] }, checkedAt: T };
const momoOnly = { signedIn: true, user: { id: 'u1', features: ['momo'] }, checkedAt: T };
const open = (o: any = {}) => host.openHostAccess({ dir: fresh(), refresh: () => {}, flagOn: () => true, ...o });
const decideHost = (o: any) => decide({ flagOn: true, now, cache: null, feature: host.FEATURE, ...o });

test('decide for Host: any signed-in account, whatever its invites, offline too; the kill switch, sign-out and no account close it', () => {
  assert.equal(host.FEATURE, null, 'no invite');
  assert.equal(decideHost({ status: invited }), true, 'the old invite');
  assert.equal(decideHost({ status: momoOnly }), true, 'another invite');
  assert.equal(decideHost({ status: { ...invited, user: { id: 'u1', features: [] } } }), true, 'none');
  assert.equal(
    decideHost({ status: { ...invited, checkedAt: null }, cache: { userId: 'u1', allowed: false, at: now - 1000 } }),
    true,
    'an old cached no',
  );
  assert.equal(decideHost({ status: invited, flagOn: false }), false, 'kill switch off');
  assert.equal(decideHost({ status: { ...invited, signedIn: false } }), false, 'signed out');
  assert.equal(decideHost({ status: { signedIn: true, user: { id: '' } } }), false, 'no account id');
  assert.equal(decideHost({ status: null }), false);
  // MoMo keeps its invite: the same account without it is not let in
  assert.equal(decide({ status: invited, cache: null, flagOn: true, now }), false);
  assert.equal(decide({ status: { ...invited, user: { id: 'u1', features: ['momo'] } }, cache: null, flagOn: true, now }), true);
});

test('the gate writes host-access.json, follows sign-out and a new account, and opens offline for the signed-in account', () => {
  const d = fresh();
  const heard: boolean[] = [];
  const g = open({ dir: d, broadcast: (a: boolean) => void heard.push(a) });
  assert.equal(g instanceof MomoAccess, true);
  host.updateHostAccess({ ...invited, user: { id: 'u1', features: [] } });
  assert.equal(host.hostAccess(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'host-access.json'), 'utf8')), { userId: 'u1', allowed: true, at: T });
  host.updateHostAccess({ signedIn: false, user: null });
  assert.equal(host.hostAccess(), false, 'signed out');
  assert.equal(fs.existsSync(path.join(d, 'host-access.json')), false, 'the answer is forgotten');
  host.updateHostAccess({ ...invited, user: { id: 'u2', features: [] } });
  assert.equal(host.hostAccess(), true, 'another account');
  assert.deepEqual(heard, [true, false, true]);
  g.dispose();
  // a restart that cannot reach the server: a signed-in account is enough
  const g2 = open({ dir: d, now: () => now });
  host.updateHostAccess({ signedIn: true, user: { id: 'u3', features: [] }, checkedAt: null });
  assert.equal(host.hostAccess(), true, 'offline');
  g2.dispose();
});

test('the kill switch removes Host live, and the dev invite stands in only through devInvite', () => {
  let flag = true;
  const g = open({ flagOn: () => flag, waitForFlags: true });
  host.updateHostAccess(invited);
  assert.equal(host.hostAccess(), false, 'waiting for the switches');
  host.recomputeHostAccess();
  assert.equal(host.hostAccess(), true);
  flag = false;
  host.recomputeHostAccess();
  assert.equal(host.hostAccess(), false, 'kill switch off');
  g.dispose();
  const dev = open({ devInvite: true });
  host.updateHostAccess(null);
  assert.equal(host.hostAccess(), true, 'dev invite');
  dev.dispose();
});

test('a revoke is found with no window open: the gate rereads the account on its timer', () => {
  const sets: (() => void)[] = [];
  let refreshes = 0;
  const g = open({
    refresh: () => void refreshes++,
    timers: { set: (fn: () => void, ms: number) => (assert.equal(ms, REFRESH_MS), sets.push(fn), {}), clear: () => {} },
  });
  host.updateHostAccess(invited);
  sets[0]();
  return Promise.resolve().then(() => {
    assert.equal(refreshes, 1);
    g.dispose();
  });
});

test('the app’s one gate: closed until opened; a service hears each change and one that throws stops no other', () => {
  host.openHostAccess({ dir: fresh(), refresh: () => {} }).dispose();
  host.recomputeHostAccess();
  assert.equal(host.hostAccess(), false);
  const heard: boolean[] = [];
  const off = host.onHostAccess(() => {
    throw new Error('broken service');
  });
  const stop = host.onHostAccess((a: boolean) => void heard.push(a));
  const g = open();
  host.updateHostAccess(invited);
  host.updateHostAccess({ signedIn: false, user: null });
  assert.deepEqual(heard, [true, false]);
  stop();
  off();
  host.updateHostAccess(invited);
  assert.deepEqual(heard, [true, false], 'unsubscribed');
  g.dispose();
});

test('before any gate is opened, Host is closed and updates are ignored', async () => {
  // a fresh module instance has no gate
  const p = require.resolve('../electron/host/access.cjs');
  delete require.cache[p];
  const clean = require('../electron/host/access.cjs');
  clean.updateHostAccess(invited);
  clean.recomputeHostAccess();
  assert.equal(clean.hostAccess(), false);
});
