// A MoMo grant backed by the server-signed entitlement (#5474) through the home: sealed beside the grant, kept across a restart, refused when forged, replayed, withdrawn or run out, and the wiring's mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createMomoHome } from '../host/src/momoHome.mjs';
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { createEntitlementKeep } from '../host/src/momoEntitlementKeep.mjs';
import { requireHome } from '../host/src/momoHomeGuard.mjs';
import { createEntitlementGate } from '../host/src/momoEntitlementGate.mjs';
import { entitlementGateFor } from '../host/src/momoWiring.mjs';
import { ENTITLEMENT_GRACE_MS, ENTITLEMENT_TTL_MS, entitlementKeyId, signEntitlement } from '../shared/host/momoEntitlement.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const kid = entitlementKeyId(pem);
const HOST = 'd'.repeat(32);
const T0 = 1_800_000_000_000;
const MOMO = ['momo'];
const token = (o: object = {}) =>
  signEntitlement({ kid, sub: 'a1', features: MOMO, aud: HOST, iat: T0, exp: T0 + ENTITLEMENT_TTL_MS, ...o }, privateKey);

function world(t: any, mode: 'off' | 'warn' | 'required' = 'required') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { at: T0 + 1000, now: () => clock.at };
  const reports: string[] = [];
  const make = (as: 'off' | 'warn' | 'required' = mode) =>
    createMomoHome({
      hostId: HOST,
      dataDir: path.join(dir, 'data'),
      safeStorage: createFileSafeStorage(path.join(dir, 'config')),
      clock,
      report: (m: string) => reports.push(m),
      entitlement: createEntitlementGate({ hostId: HOST, keys: [{ id: kid, pem }], mode: as, now: clock.now }),
    });
  return { dir, clock, reports, make, file: path.join(dir, 'data', 'momo', 'entitlement.json') };
}
const refusal = (code: string) => (e: any) => e.code === code;

test('a signed grant is taken, sealed on the disk and remembered by the next process: an older token is a replay', async (t) => {
  const w = world(t);
  const home = w.make();
  assert.equal((await home.grant({ account: 'a1', features: [], entitlement: token() })).granted, true);
  assert.equal(home.granted(), true);
  assert.doesNotMatch(fs.readFileSync(w.file, 'utf8'), /"floorIat"/, 'sealed');
  const restarted = w.make();
  await assert.rejects(
    restarted.grant({ account: 'a1', features: MOMO, entitlement: token({ iat: T0 - 5 }) }),
    refusal('entitlement_stale'),
  );
  assert.equal((await restarted.grant({ account: 'a1', features: MOMO, entitlement: token() })).granted, true);
});

test('refused: no entitlement when required, a forged one, and one made for another Host; nothing is granted', async (t) => {
  const w = world(t);
  const home = w.make();
  await assert.rejects(home.grant({ account: 'a1', features: MOMO }), refusal('entitlement_missing'));
  const forged = signEntitlement(
    { kid, sub: 'a1', features: MOMO, aud: HOST, iat: T0, exp: T0 + 1000 },
    generateKeyPairSync('ed25519').privateKey,
  );
  await assert.rejects(home.grant({ account: 'a1', features: MOMO, entitlement: forged }), refusal('entitlement_invalid'));
  await assert.rejects(
    home.grant({ account: 'a1', features: MOMO, entitlement: token({ aud: 'e'.repeat(32) }) }),
    refusal('entitlement_wrong_host'),
  );
  assert.equal(home.granted(), false);
});

test('a withdrawn entitlement erases the grant; the run-out one pauses MoMo and its late grant erases it', async (t) => {
  const w = world(t);
  const home = w.make();
  await home.grant({ account: 'a1', features: MOMO, entitlement: token() });
  await assert.rejects(
    home.grant({ account: 'a1', features: MOMO, entitlement: token({ features: [], iat: T0 + 500 }) }),
    refusal('entitlement_revoked'),
  );
  assert.equal(home.granted(), false);
  assert.equal(fs.existsSync(path.join(w.dir, 'data', 'momo', 'grant.json')), false);

  const w2 = world(t);
  const h2 = w2.make();
  await h2.grant({ account: 'a1', features: MOMO, entitlement: token() });
  w2.clock.at = T0 + ENTITLEMENT_TTL_MS + 1000;
  assert.equal(h2.granted(), true, 'the grace holds');
  w2.clock.at = T0 + ENTITLEMENT_TTL_MS + ENTITLEMENT_GRACE_MS + 1;
  assert.equal(h2.granted(), false, 'paused without the client');
  await assert.rejects(h2.grant({ account: 'a1', features: MOMO, entitlement: token() }), refusal('entitlement_expired'));
  assert.equal(fs.existsSync(path.join(w2.dir, 'data', 'momo', 'grant.json')), false);
});

test('off takes an unsigned grant, warn says so, and once a signed one was taken an unsigned one is a downgrade', async (t) => {
  const off = world(t, 'off');
  const h = off.make();
  assert.equal((await h.grant({ account: 'a1', features: MOMO })).granted, true);
  assert.equal(fs.existsSync(off.file), false, 'nothing kept for an unsigned grant');
  await h.grant({ account: 'a1', features: MOMO, entitlement: token() });
  await assert.rejects(h.grant({ account: 'a1', features: MOMO }), refusal('entitlement_missing'));

  const warn = world(t, 'warn');
  await warn.make().grant({ account: 'a1', features: MOMO });
  assert.match(warn.reports.join('\n'), /grant without an entitlement/);
});

test('an unreadable entitlement record is never a fresh one: unsigned grants are refused and the cause is reported', async (t) => {
  const w = world(t, 'off');
  const home = w.make();
  await home.grant({ account: 'a1', features: MOMO, entitlement: token() });
  fs.rmSync(w.file);
  fs.mkdirSync(w.file);
  const again = w.make();
  assert.equal(again.granted(), false);
  assert.match(w.reports.join('\n'), /entitlement could not be read/);
  await assert.rejects(again.grant({ account: 'a1', features: MOMO }), refusal('entitlement_missing'));
  assert.equal(again.granted(), false, 'still paused');
  // and a token that cannot be kept is refused rather than taken on trust
  await assert.rejects(
    again.grant({ account: 'a1', features: MOMO, entitlement: token({ iat: T0 + 50 }) }),
    refusal('entitlement_unwritable'),
  );
  assert.match(w.reports.join('\n'), /could not be kept/);
});

test('the wiring: off by default, the environment moves it, and required without a pinned key keeps MoMo off and says why, never stopping the Host', async (t) => {
  assert.equal(entitlementGateFor(HOST, {}).mode, 'off');
  // no report given: the default says nothing and the gate is still built
  assert.equal(entitlementGateFor(HOST, { MOPILOT_MOMO_ENTITLEMENT: 'required' }).mode, 'required');
  assert.equal(entitlementGateFor(HOST, { MOPILOT_MOMO_ENTITLEMENT: 'warn' }).mode, 'warn');
  const said: string[] = [];
  // a Host built before any key was pinned
  const gate = entitlementGateFor(HOST, { MOPILOT_MOMO_ENTITLEMENT: 'required' }, (m: string) => said.push(m), []);
  // this build pins the account service's key: required says nothing
  const pinned: string[] = [];
  entitlementGateFor(HOST, { MOPILOT_MOMO_ENTITLEMENT: 'required' }, (m: string) => pinned.push(m));
  assert.deepEqual(pinned, []);
  assert.equal(gate.mode, 'required');
  assert.match(said.join(), /trusts no key: MoMo stays off/);
  const w = world(t);
  const home = createMomoHome({
    hostId: HOST,
    dataDir: path.join(w.dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(w.dir, 'config')),
    clock: w.clock,
    entitlement: gate,
  });
  await assert.rejects(home.grant({ account: 'a1', features: MOMO, entitlement: token() }), refusal('entitlement_unknown_key'));
  assert.equal(home.granted(), false);
  assert.equal(home.status().access?.code, 'entitlement_missing');
});

test('a withdrawal and an older granted token sent together: the account stays withdrawn whichever lands first', async (t) => {
  for (const order of ['revoke-first', 'old-first'] as const) {
    const w = world(t);
    const home = w.make();
    await home.grant({ account: 'a1', features: MOMO, entitlement: token({ iat: T0 + 10 }) });
    const revoke = home.grant({ account: 'a1', features: MOMO, entitlement: token({ features: [], iat: T0 + 20 }) });
    const old = home.grant({ account: 'a1', features: MOMO, entitlement: token({ iat: T0 + 15 }) });
    const calls = order === 'revoke-first' ? [revoke, old] : [old, revoke];
    await Promise.allSettled(calls);
    assert.equal(home.granted(), false, order);
    assert.equal(w.make().granted(), false, `${order}, after a restart`);
    await assert.rejects(home.grant({ account: 'a1', features: MOMO, entitlement: token({ iat: T0 + 16 }) }), refusal('entitlement_stale'));
  }
});

test("turning required on pauses an alpha grant; the client's token brings it back and a bare grant is erased", async (t) => {
  const w = world(t, 'off');
  await w.make().grant({ account: 'a1', features: MOMO });
  const required = w.make('required');
  assert.equal(required.granted(), false, 'the alpha grant does not stand once entitlements are required');
  assert.equal(fs.existsSync(path.join(w.dir, 'data', 'momo', 'grant.json')), true);
  await assert.rejects(required.grant({ account: 'a1', features: MOMO }), refusal('entitlement_missing'));
  assert.equal(fs.existsSync(path.join(w.dir, 'data', 'momo', 'grant.json')), false, 'a missing token erases it');
  assert.equal((await required.grant({ account: 'a1', features: MOMO, entitlement: token() })).granted, true);
  assert.equal(required.granted(), true);
});

test('a home that moves here from one that required entitlements keeps requiring them', async (t) => {
  const w = world(t, 'off');
  const home = w.make();
  assert.equal(home.entitlement!.required(), false);
  await home.entitlement!.require();
  assert.equal(home.entitlement!.required(), true);
  await assert.rejects(home.grant({ account: 'a1', features: MOMO }), refusal('entitlement_missing'));
  assert.equal((await home.grant({ account: 'a1', features: MOMO, entitlement: token() })).granted, true);
  // a home without a gate never requires, and marking it does nothing
  const bare = createMomoHome({
    hostId: HOST,
    dataDir: path.join(w.dir, 'bare'),
    safeStorage: createFileSafeStorage(path.join(w.dir, 'bareconf')),
    clock: w.clock,
  });
  assert.equal(bare.entitlement, null);
});

test('a key the Host was not given: required says update, off goes on as the alpha did', async (t) => {
  const rotated = signEntitlement(
    {
      kid: entitlementKeyId(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()),
      sub: 'a1',
      features: MOMO,
      aud: HOST,
      iat: T0,
      exp: T0 + ENTITLEMENT_TTL_MS,
    },
    privateKey,
  );
  await assert.rejects(world(t).make().grant({ account: 'a1', features: MOMO, entitlement: rotated }), refusal('entitlement_unknown_key'));
  assert.equal((await world(t, 'off').make().grant({ account: 'a1', features: MOMO, entitlement: rotated })).granted, true);
});

test('a write that finds a newer floor stored (another process) keeps it and only moves the clock mark forward', async () => {
  const stored = { floorIat: T0 + 999, clockMark: 5, signedSince: 1, account: 'a1', features: MOMO, exp: 0 };
  const file = { read: () => stored, change: async (edit: (e: any) => void) => edit(stored) };
  const keep = createEntitlementKeep({
    gate: createEntitlementGate({ hostId: HOST, keys: [{ id: kid, pem }], mode: 'off', now: () => T0 + 1000 }),
    sealed: () => file,
    dir: path.join(os.tmpdir(), 'momo-ent-nowhere'),
    report: () => undefined,
  } as any);
  const features = await keep.admit({ account: 'a1', features: MOMO, entitlement: token() }, async () => undefined);
  assert.deepEqual(features, MOMO);
  assert.equal(stored.floorIat, T0 + 999, 'the newer floor stays');
  assert.equal(stored.clockMark, T0 + 1000, 'and the clock mark moves on');
});

const DAY = 24 * 3_600_000;

test('a clock that jumped forward and was set back: nothing is kept from the wrong time, so the next fresh token is taken after a restart', async (t) => {
  const w = world(t);
  assert.equal((await w.make().grant({ account: 'a1', features: MOMO, entitlement: token() })).granted, true);
  w.clock.at = T0 + 10 * DAY;
  // the held token sent again, and a newer one, while the clock is wrong: both refused, MoMo off; neither remembers the time
  const wrong = w.make();
  assert.equal(wrong.granted(), false);
  await assert.rejects(wrong.grant({ account: 'a1', features: MOMO, entitlement: token() }), refusal('entitlement_expired'));
  await assert.rejects(
    wrong.grant({ account: 'a1', features: MOMO, entitlement: token({ iat: T0 + 3_600_000, exp: T0 + 3_600_000 + ENTITLEMENT_TTL_MS }) }),
    refusal('clock_skew'),
  );
  w.clock.at = T0 + 2 * 3_600_000;
  const fixed = w.make();
  assert.equal(fixed.status().access, null, 'the clock is back: the stored token stands again');
  const fresh = token({ iat: w.clock.at, exp: w.clock.at + ENTITLEMENT_TTL_MS });
  assert.equal((await fixed.grant({ account: 'a1', features: MOMO, entitlement: fresh })).granted, true);
  assert.equal(fixed.granted(), true);
});

test('a guarded call says why the entitlement does not stand: withdrawn, run out, or never invited, with the grant erased where it is withdrawn', async (t) => {
  const w = world(t, 'off');
  const home = w.make();
  await home.grant({ account: 'a1', features: MOMO, entitlement: token() });
  assert.doesNotThrow(() => requireHome({ ...home, stamp: () => ({}) }));
  w.clock.at = T0 + ENTITLEMENT_TTL_MS + ENTITLEMENT_GRACE_MS + 1000;
  assert.throws(() => requireHome({ ...home, stamp: () => ({}) }), refusal('entitlement_expired'));
  assert.equal(home.status().access?.code, 'entitlement_expired');
  // withdrawn: the newest signed token has no momo; the held grant goes
  w.clock.at = T0 + 1000;
  const out = w.make();
  await assert.rejects(
    out.grant({ account: 'a1', features: MOMO, entitlement: token({ features: [], iat: T0 + 500 }) }),
    refusal('entitlement_revoked'),
  );
  assert.equal(out.granted(), false);
  assert.throws(() => requireHome({ ...out, stamp: () => ({}) }), refusal('entitlement_revoked'));
  // a grant that is just old, with no entitlement involved, keeps its own words
  const plain = createMomoHome({
    hostId: HOST,
    dataDir: path.join(w.dir, 'plain'),
    safeStorage: createFileSafeStorage(path.join(w.dir, 'plain-config')),
    clock: w.clock,
  });
  assert.throws(() => requireHome({ ...plain, stamp: () => ({}) }), refusal('momo_grant_lapsed'));
  // never invited
  const w2 = world(t, 'off');
  const never = w2.make();
  await assert.rejects(
    never.grant({ account: 'a2', features: MOMO, entitlement: token({ sub: 'a2', features: [] }) }),
    refusal('not_invited'),
  );
  assert.equal(never.status().access?.code, 'not_invited');
});
