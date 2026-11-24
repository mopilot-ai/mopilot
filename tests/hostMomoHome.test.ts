// MoMo's home on a Host, H1 (host/src/momoHome.mjs, host/src/methods/momo.mjs): the grant of an invited account (a paired client's, kept sealed, good for 7 days, renewed by its client), the home record and its refusal of a second home, MoMo's stores opened through the seams, and nothing on disk or on the wire for a client with no grant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHome, GRANT_MAX_AGE_MS } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import { createMomoHidden, momoHomeFor } from '../host/src/momoWiring.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { act } from './support/momo-trust.ts';

const DAY = 86_400_000;
const MOMO = ['momo'];
const scratch = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A home over `dir` with its own key file and a clock the test moves. */
function world(t: any, dir = scratch(t), keys = path.join(dir, 'config')) {
  const clock = { at: 1_700_000_000_000, now: () => clock.at };
  const reports: string[] = [];
  const make = (o: object = {}) =>
    createMomoHome({
      hostId: 'home-aaaa-1111',
      dataDir: path.join(dir, 'data'),
      safeStorage: createFileSafeStorage(keys),
      clock,
      report: (m: string) => reports.push(m),
      isMomoChat: (id: string) => id === 'momo-chat',
      ...o,
    });
  return { dir, clock, reports, make, momoDir: path.join(dir, 'data', 'momo') };
}
const start = { homeId: 'home-aaaa-1111', name: 'Studio' };

test('B4: a client with no grant leaves no trace: nothing is granted, read or made on the disk', (t) => {
  const w = world(t);
  const home = w.make();
  assert.equal(home.granted(), false);
  assert.equal(home.stores(), null);
  assert.equal(fs.existsSync(w.momoDir), false, 'no folder, so no trace');
  assert.deepEqual(home.status(), { version: 1, keys: 'key-file', grantExpiresAt: GRANT_MAX_AGE_MS, access: null, home: null });
});

test('a grant without the momo feature is a revoke: erased, and answered as a request no Host knows', async (t) => {
  const w = world(t);
  const home = w.make();
  await assert.rejects(home.grant({ account: 'a1', features: ['other'] }), /Unknown request: host.momoGrant/);
  assert.equal(fs.existsSync(w.momoDir), false);
  assert.equal((await home.grant({ account: 'a1', features: MOMO })).granted, true);
  assert.equal(home.granted(), true);
  assert.doesNotMatch(fs.readFileSync(path.join(w.momoDir, 'grant.json'), 'utf8'), /"account"/, 'the grant is sealed on the disk');
  await assert.rejects(home.grant({ account: 'a1', features: [] }), /Unknown request/);
  assert.equal(home.granted(), false);
  assert.equal(fs.existsSync(path.join(w.momoDir, 'grant.json')), false);
});

test('a grant lasts 7 days from its last renewal; after that nothing runs, and the next one says how long it was out', async (t) => {
  const w = world(t);
  const home = w.make();
  const first = await home.grant({ account: 'a1', features: MOMO });
  assert.deepEqual([first.lapsedForMs, first.expiresAt], [null, w.clock.at + GRANT_MAX_AGE_MS]);
  w.clock.at += 6 * DAY;
  await home.grant({ account: 'a1', features: MOMO });
  w.clock.at += 6 * DAY;
  assert.equal(home.granted(), true, 'twelve days after the first, six after the renewal');
  await home.start(start);
  assert.notEqual(home.stores(), null);
  w.clock.at += 2 * DAY;
  assert.equal(home.granted(), false);
  assert.equal(home.stores(), null, 'no scheduled run reaches the stores');
  const back = await home.grant({ account: 'a1', features: MOMO });
  assert.equal(back.lapsedForMs, DAY);
  assert.equal(home.granted(), true);
  await home.close();
});

test('a second home is refused naming the first; the same home asking again is answered as it is; another account is not granted', async (t) => {
  const w = world(t);
  const home = w.make();
  await home.grant({ account: 'a1', features: MOMO });
  const at = w.clock.at;
  assert.deepEqual((await home.start(start)).home, {
    homeId: start.homeId,
    leaseEpoch: 1,
    state: 'running',
    stateSince: at,
    lastSeenAt: at,
    moveId: null,
    bundleHash: null,
    moveDeadline: null,
    moveExpired: false,
    movedTo: null,
    name: 'Studio',
  });
  w.clock.at += 5_000;
  const again = (await home.start(start)).home;
  assert.equal(again?.leaseEpoch, 1, 'the same home is not a new epoch');
  assert.equal(again?.stateSince, at, 'and its state did not restart');
  assert.equal(again?.lastSeenAt, at + 5_000, 'but it was seen');
  await assert.rejects(
    // a data folder that is another machine's home (copied or shared by mistake) is not taken over: the Host is named by its own id
    w.make({ hostId: 'home-bbbb-2222' }).start({ name: 'Laptop' }),
    (e: any) => e.code === 'home_exists' && e.details.name === 'Studio',
  );
  // the home belongs to the account that made it: another account can neither take it over nor switch it off
  await assert.rejects(home.grant({ account: 'a2', features: MOMO }), /Unknown request: host.momoGrant/);
  await assert.rejects(home.grant({ account: 'a2', features: [] }), /Unknown request: host.momoGrant/);
  assert.equal(home.granted(), true, 'a1’s grant is untouched');
  await assert.rejects(home.grant({ account: 'a1', features: [] }), /Unknown request/);
  assert.equal(home.granted(), false, 'its own account can revoke it');
  await assert.rejects(home.grant({ account: 'a2', features: MOMO }), /Unknown request/, 'and a revoked home is still a1’s');
  await home.grant({ account: 'a1', features: MOMO });
  assert.equal(home.granted(), true);
  await home.close();
});

test('W3: a home record or a grant sealed with another key is left as it is: the home says unavailable, refuses to start and nobody is granted', async (t) => {
  const w = world(t);
  const home = w.make();
  await home.grant({ account: 'a1', features: MOMO });
  await home.start(start);
  await home.close();
  const before = fs.readFileSync(path.join(w.momoDir, 'home.json'), 'utf8');
  // the same folder under another Host's key
  const other = world(t, w.dir, path.join(w.dir, 'other-config'));
  const stranger = other.make();
  assert.equal(stranger.granted(), false);
  assert.deepEqual(stranger.status().home, { state: 'unavailable' });
  await assert.rejects(stranger.start(start), (e: any) => e.code === 'home_unavailable');
  assert.equal(fs.readFileSync(path.join(w.momoDir, 'home.json'), 'utf8'), before, 'not started over');
  assert.ok(other.reports.some((m) => /grant could not be read/.test(m)));
  assert.ok(other.reports.some((m) => /home record could not be read/.test(m)));
});

test('W4: MoMo’s stores open under the Host’s data dir through the seams, and a restart finds what was written', async (t) => {
  const w = world(t);
  const home = w.make();
  assert.equal(home.stores(), null, 'no home yet');
  await home.grant({ account: 'a1', features: MOMO });
  assert.equal(home.stores(), null, 'a grant is not a home');
  await home.start(start);
  const s = home.stores()!;
  assert.equal(home.stores(), s, 'made once');
  await s.memory.save({ text: 'Lives in Berlin', source: { chatId: 'momo-chat', harness: 'claude' } });
  const { id } = await s.audit.intent(act);
  await s.audit.outcome(id, { result: 'done', note: 'ok' });
  await home.close();
  // the Host starts again over the same folders
  const again = w.make();
  assert.equal(again.status().home?.leaseEpoch, 1);
  const s2 = again.stores()!;
  assert.deepEqual(
    s2.memory.list().facts.map((f: any) => f.text),
    ['Lives in Berlin'],
  );
  assert.equal((await s2.audit.verify()).ok, true);
  assert.deepEqual(s2.loops.open(), []);
  await again.close();
  await again.close();
});

test('on the wire, through the server: to an unpaired client and to one without a grant every host.momo* is byte for byte the answer of a request no Host knows, and a hello names no momo; with a live grant the client sees the feature and uses it', async (t) => {
  const w = world(t);
  const home = w.make();
  const host = await servedHost(t, { momo: home });
  /** The whole reply to one request, without its numbering. */
  const reply = async (conn: any, method: string, params?: any) => {
    const { id: _id, ...rest } = await conn.call(method, params);
    return JSON.stringify(rest);
  };
  const sameAsUnknown = async (conn: any) => {
    const unknown = await reply(conn, 'host.zzz', {});
    for (const [method, params] of [
      ['host.momoStatus', {}],
      ['host.momoHomeStart', start],
      ['host.momoGrant', { account: 'a1', features: ['other'] }],
      ['host.momoGrant', { account: '', features: [] }],
      ['host.momoGrant', { account: 'a1', features: 'momo' }],
      ['host.momoGrant', { account: 'a1', features: [1] }],
    ] as const)
      assert.equal(await reply(conn, method, params), unknown.replace('host.zzz', method), `${method} ${JSON.stringify(params)}`);
  };
  const hello = async (conn: any) => JSON.stringify(await conn.call('host.hello', helloParams()));
  const stranger = host.line();
  assert.doesNotMatch(await hello(stranger), /momo/i);
  await sameAsUnknown(stranger);
  // an unpaired client cannot grant itself MoMo: not with a valid grant either, and nothing is made or changed by trying
  assert.equal(
    await reply(stranger, 'host.momoGrant', { account: 'a1', features: MOMO }),
    await reply(stranger, 'host.zzz', {}).then((r) => r.replace('host.zzz', 'host.momoGrant')),
  );
  assert.equal(home.granted(), false);
  assert.equal(fs.existsSync(w.momoDir), false);
  const { conn } = await host.paired('mac', 'Mac');
  // the one deliberate exception: a paired owner device is told this Host can say what it holds (presence only, no MoMo data), so it never reads a missing grant as "no home"
  assert.doesNotMatch((await hello(conn)).replaceAll('momoLook', ''), /momo/i);
  await sameAsUnknown(conn);
  assert.equal(fs.existsSync(w.momoDir), false, 'and no trace on the disk');
  // the invited account's client: its grant, a new hello that now names the feature, then the status and a home
  assert.equal((await conn.request('host.momoGrant', { account: 'a1', features: MOMO })).granted, true);
  assert.match(await hello(conn), /momo/);
  assert.doesNotMatch(await hello(stranger), /momo/i, 'an unpaired client still sees nothing');
  await sameAsUnknown(stranger);
  assert.equal((await conn.request('host.momoStatus')).home, null);
  assert.equal((await conn.request('host.momoHomeStart', start)).home.leaseEpoch, 1);
  // the home is this Host: a homeId a client sends names nothing, so no client can name another machine
  const named = await conn.request('host.momoHomeStart', { homeId: 'home-bbbb-2222', name: 'Laptop' });
  assert.equal(named.home.homeId, 'home-aaaa-1111');
  assert.equal(named.home.leaseEpoch, 1);
  await assert.rejects(conn.request('host.momoHomeStart', { homeId: start.homeId, name: '' }), /machine name/);
  // revoked: it is all unknown again, and the hello forgets the feature
  await assert.rejects(conn.request('host.momoGrant', { account: 'a1', features: [] }), /Unknown request/);
  assert.doesNotMatch((await hello(conn)).replaceAll('momoLook', ''), /momo/i);
  await sameAsUnknown(conn);
  await home.close();
});

test('a Host built with no MoMo home answers every momo.* as unknown, the grant too', async (t) => {
  const host = await servedHost(t);
  const { conn } = await host.paired('mac', 'Mac');
  for (const [method, params] of [
    ['host.momoGrant', { account: 'a1', features: MOMO }],
    ['host.momoStatus', {}],
    ['host.momoHomeStart', start],
  ] as const)
    await assert.rejects(conn.request(method, params), /Unknown request/);
});

test('the serve entry builds the home over the Host’s data dir and key file; defaults need no chats and no report', async (t) => {
  const dir = scratch(t);
  const paths = { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') };
  const reported: string[] = [];
  const applied: unknown[][] = [];
  const sessions: any = {
    chats: { records: new Map(), patchMeta: () => undefined },
    isolated: () => true,
    isolate: (...a: unknown[]) => applied.push(a),
  };
  const home = momoHomeFor({
    hostId: 'home-aaaa-1111',
    paths,
    report: (m: string) => reported.push(m),
    sessions,
    epochs: { current: () => 0 },
    hidden: createMomoHidden(),
  });
  // the isolation is applied at boot, before any chat, to MoMo's chats by the home's own registry
  assert.equal(applied.length, 1);
  assert.equal(typeof applied[0][0], 'function');
  assert.equal(applied[0][1], home.chats?.workspace);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start(start);
  assert.ok(fs.existsSync(path.join(paths.configDir, 'safe-storage.key')), 'sealed with this Host’s own key file');
  assert.equal(home.stores()?.memory.list().facts.length, 0);
  await home.close();
  // no isMomoChat and no report given: no chat may be a fact's source, and a problem is not reported anywhere
  const bare = createMomoHome({ hostId: 'home-aaaa-1111', dataDir: paths.dataDir, safeStorage: createFileSafeStorage(paths.configDir) });
  const stores = bare.stores()!;
  await assert.rejects(stores.memory.save({ text: 'x', source: { chatId: 'momo-chat', harness: 'claude' } }));
  // another key and no report: unreadable, nobody granted, nothing to say it to
  const stranger = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: paths.dataDir,
    safeStorage: createFileSafeStorage(path.join(dir, 'other')),
  });
  assert.equal(stranger.granted(), false);
  fs.writeFileSync(path.join(paths.dataDir, 'momo', 'grant.json'), 'not sealed');
  await bare.close();
  const unsealed = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: paths.dataDir,
    safeStorage: createFileSafeStorage(paths.configDir),
  });
  assert.equal(unsealed.granted(), false, 'a grant that is not a sealed file is no grant');
});

test('without a home, a live grant belongs to its account; once it has run out another account may take its place', async (t) => {
  const w = world(t);
  const home = w.make();
  await home.grant({ account: 'a1', features: MOMO });
  await assert.rejects(home.grant({ account: 'a2', features: MOMO }), /Unknown request/);
  await assert.rejects(home.grant({ account: 'a2', features: [] }), /Unknown request/);
  assert.equal(home.granted(), true);
  w.clock.at += 8 * DAY;
  assert.equal(home.granted(), false);
  assert.equal((await home.grant({ account: 'a2', features: MOMO })).granted, true);
  assert.equal(home.granted(), true);
});

test('a Host clock that moved back does not make a grant last: from the future it is not live until the clock is back', async (t) => {
  const w = world(t);
  const home = w.make();
  await home.grant({ account: 'a1', features: MOMO });
  w.clock.at -= 1000;
  assert.equal(home.granted(), false, 'received one second in the future');
  assert.equal(home.stores(), null);
  w.clock.at += 1000;
  assert.equal(home.granted(), true);
  // the clock moved back a week and the grant is renewed: the renewal is what counts, and the one that ran out reads as no time out
  w.clock.at += 9 * DAY;
  w.clock.at -= 20 * DAY;
  assert.equal(home.granted(), false);
  const back = await home.grant({ account: 'a1', features: MOMO });
  assert.equal(back.lapsedForMs, 0);
  assert.equal(home.granted(), true);
});

test('the lease epoch fences the home: stamps carry it, a stale or foreign one is refused, a moving home takes none, and the record changes only by compare-and-swap', async (t) => {
  const w = world(t);
  const home = w.make();
  assert.equal(home.stamp(), null, 'no home, no stamp');
  assert.equal(home.current({ homeId: start.homeId, leaseEpoch: 1 }), false);
  await home.grant({ account: 'a1', features: MOMO });
  await home.start(start);
  const stamp = home.stamp()!;
  assert.deepEqual(stamp, { homeId: start.homeId, leaseEpoch: 1 });
  assert.equal(home.current(stamp), true);
  for (const bad of [
    null,
    undefined,
    {},
    { homeId: 'other-home', leaseEpoch: 1 },
    { homeId: start.homeId, leaseEpoch: 2 },
    { homeId: start.homeId, leaseEpoch: 0 },
  ])
    assert.equal(home.current(bad), false);
  // a writer that read an older epoch loses; the record is untouched
  await assert.rejects(
    home.swap(0, () => true),
    (e: any) => e.code === 'home_lease_stale' && e.details.leaseEpoch === 1,
  );
  assert.equal(home.status().home?.leaseEpoch, 1);
  // moving: the state clock restarts, the epoch does not move yet, and no stamp is valid, so nothing acts and no store opens
  w.clock.at += 1000;
  await home.swap(1, (h: any) => {
    h.state = 'moving';
    h.moveId = 'move-1';
    return false;
  });
  assert.equal(home.status().home?.state, 'moving');
  assert.equal(home.status().home?.stateSince, w.clock.at);
  assert.equal(home.stamp(), null);
  assert.equal(home.current(stamp), false);
  assert.equal(home.stores(), null);
  // the switch: a new lease, so the old stamp is stale for good even after the home runs again
  await home.swap(1, (h: any) => {
    h.state = 'running';
    return true;
  });
  assert.equal(home.status().home?.leaseEpoch, 2);
  assert.equal(home.current(stamp), false, 'the old epoch never acts again');
  assert.equal(home.current(home.stamp()), true);
  // a revoked grant stops the stamp even while the record says running
  await assert.rejects(home.grant({ account: 'a1', features: [] }), /Unknown request/);
  assert.equal(home.stamp(), null);
  await home.close();
});

test('a grant may carry the account service’s signed entitlement: a string of at most 2 KB, and anything else is as unknown as a bad grant', async (t) => {
  const w = world(t);
  const home = w.make();
  const host = await servedHost(t, { momo: home });
  const { conn } = await host.paired('mac', 'Mac');
  assert.equal((await conn.request('host.momoGrant', { account: 'a1', features: MOMO, entitlement: 'signed.entitlement' })).granted, true);
  for (const entitlement of ['', 5, null, 'x'.repeat(2049)])
    await assert.rejects(
      conn.request('host.momoGrant', { account: 'a1', features: MOMO, entitlement }),
      /Unknown request/,
      String(entitlement).slice(0, 8),
    );
  await home.close();
});
