// How a service plugs into MoMo's home (host/src/momoHome.mjs `use`, `lifecycle`, `reset`): start when the home runs here, pause when it stops acting, wipe before its data goes; through a move, a Cancel and a Reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
// @ts-ignore
import { loadMomoServices } from '../host/src/momoServices.mjs';
import os from 'node:os';
// @ts-ignore: plain ESM without declarations
import { moveHome } from '../shared/momoMove.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { MOMO, A, B, host, studio } from './support/host/momoMoveWorld.ts';

/** A service that writes down what it is told, in order. */
const service = (log: string[], tag: string, over: Record<string, () => unknown> = {}) => ({
  start: () => void log.push(`${tag}:start`),
  pause: () => void log.push(`${tag}:pause`),
  wipe: () => void log.push(`${tag}:wipe`),
  ...over,
});
const run = (a: any, b: any, extra: object = {}) =>
  moveHome({ moveId: 'move-0001', from: a.side, to: b.side, target: B, fromName: A.name, ...extra });

test('a service starts with the home, pauses and wipes through a move on the old machine, and starts on the new one', async (t) => {
  const log: string[] = [];
  const a = await host(t, A);
  const b = await host(t, B);
  a.home.use('sched', service(log, 'A'));
  b.home.use('sched', service(log, 'B'));
  assert.deepEqual(log, [], 'no home yet, so nothing starts');
  await a.home.start(A);
  await a.home.start(A);
  assert.deepEqual(log, ['A:start'], 'a repeated start answers as it is: the services are not started again');
  log.length = 0;
  assert.equal((await run(a, b)).ok, true);
  assert.deepEqual(log, ['A:pause', 'B:start', 'A:wipe']);
});

test('a Cancel pauses the service and starts it again, at the same epoch', async (t) => {
  const log: string[] = [];
  const a = await studio(t);
  const b = await host(t, B);
  a.home.use('sched', service(log, 'A'));
  assert.deepEqual(log, ['A:start'], 'a service registered into a running home starts at once');
  const r = await run(a, b, { cancelled: () => true });
  assert.equal(r.ok, false);
  assert.deepEqual(log, ['A:start', 'A:pause', 'A:start']);
  assert.equal(a.home.status().home.leaseEpoch, 1);
});

test('a hook that fails is reported and the others still run; a service with fewer hooks is fine; the same id replaces', async (t) => {
  const log: string[] = [];
  const reports: string[] = [];
  const a = await host(t, A, { granted: false });
  // a home whose reports we can read
  const home: any = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(a.dir, 'other'),
    safeStorage: createFileSafeStorage(path.join(a.dir, 'other-config')),
    report: (m: string) => reports.push(m),
  });
  await home.grant({ account: 'a1', features: MOMO });
  home.use(
    'bad',
    service(log, 'bad', {
      start: () => {
        throw new Error('boom');
      },
    }),
  );
  home.use('late', { pause: () => void log.push('late:pause') });
  home.use('late', service(log, 'late2'));
  await home.start(A);
  assert.deepEqual(log, ['late2:start']);
  assert.match(reports[0], /service bad failed on start: boom/);
  await home.lifecycle('pause');
  assert.deepEqual(log, ['late2:start', 'bad:pause', 'late2:pause']);
  await home.close();
});

test('Reset deletes every file MoMo’s stores kept, keeps the home, the grant and the key, tells the services, and is refused while a move runs', async (t) => {
  const log: string[] = [];
  const a = await studio(t);
  a.home.use('sched', service(log, 'A'));
  log.length = 0;
  fs.writeFileSync(path.join(a.momoDir, 'chats.json'), 'registry');
  assert.ok(fs.existsSync(path.join(a.momoDir, 'audit')));
  const after = await a.home.reset();
  assert.deepEqual(log, ['A:pause', 'A:wipe', 'A:start']);
  assert.deepEqual(fs.readdirSync(a.momoDir).sort(), ['chats.json', 'grant.json', 'home.json', 'turns-void.json']);
  assert.equal(after.home.state, 'running');
  assert.equal(after.home.leaseEpoch, 1);
  assert.deepEqual(a.home.stores()!.memory.list().facts, [], 'empty, and it goes on');
  assert.ok(fs.existsSync(path.join(a.dataKeyDir, 'safe-storage.key')));
  // a move holds Reset off
  await a.side.call('begin', { moveId: 'move-0001' });
  await assert.rejects(a.home.reset(), (e: any) => e.code === 'move_in_progress');
  // a Host that is no home resets nothing and starts nothing
  const none = await host(t, B);
  const log2: string[] = [];
  none.home.use('x', service(log2, 'N'));
  assert.equal((await none.home.reset()).home, null);
  assert.deepEqual(log2, ['N:pause', 'N:wipe']);
});

test('on the wire: host.momoReset is unknown to a client with no grant, and a granted client resets the home', async (t) => {
  const a = await studio(t);
  const served = await servedHost(t, { momo: a.home });
  assert.match(JSON.stringify(await served.line().call('host.momoReset', {})), /Unknown request/);
  const { conn } = await served.paired('mac', 'Mac');
  await conn.request('host.momoGrant', { account: 'a1', features: MOMO });
  await conn.call('host.hello', helloParams());
  // a Host that runs the home offers `momoHome`; the hello of one that does not run it offers only `momo`
  const features = async () => {
    const r = await conn.call('host.hello', helloParams());
    return (r.result ?? r).features as string[];
  };
  assert.deepEqual(
    (await features()).filter((f) => f.startsWith('momo')),
    ['momo', 'momoHome', 'momoLook'],
  );
  await a.side.call('begin', { moveId: 'move-0001' });
  assert.deepEqual(
    (await features()).filter((f) => f.startsWith('momo')),
    ['momo', 'momoLook'],
    'a home that is moving does not claim it',
  );
  await a.side.call('cancel', { moveId: 'move-0001' });
  assert.equal((await conn.request('host.momoReset', {})).home.state, 'running');
  assert.deepEqual(a.home.stores()!.memory.list().facts, []);
});

test('services are found by folder: each file gets the home and its parts, a file that cannot load is reported and the rest still load, and a service offers its API to its methods', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-services-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, 'a.mjs'),
    "export default ({ home, tag }) => { home.use('a', { start: () => { globalThis.__momoSvc.push('a:' + tag + ':start'); } }); home.provide('a', { hello: () => 'hi' }); };\n",
  );
  fs.writeFileSync(path.join(dir, 'b.mjs'), "export default () => { throw new Error('nope'); };\n");
  fs.writeFileSync(path.join(dir, 'README.md'), 'not code');
  (globalThis as any).__momoSvc = [];
  const a = await host(t, A);
  const reports: string[] = [];
  assert.deepEqual(loadMomoServices({ dir, deps: { home: a.home, tag: 't' }, report: (m: string) => reports.push(m) }), ['a.mjs']);
  assert.match(reports[0], /b\.mjs could not be loaded: nope/);
  assert.equal(a.home.service('a').hello(), 'hi');
  assert.equal(a.home.service('zzz'), undefined);
  await a.home.start(A);
  assert.deepEqual((globalThis as any).__momoSvc, ['a:t:start']);
  // every service the Host ships loads (lanes add theirs by file, so the list is not pinned here), and a missing folder loads none
  const shipped: string[] = [];
  const loaded = loadMomoServices({
    deps: { home: a.home, report: (m: string) => shipped.push(m) },
    report: (m: string) => shipped.push(m),
  });
  assert.deepEqual(shipped, [], 'no shipped service fails to load');
  assert.ok(loaded.every((name) => /\.(?:mjs|cjs|js)$/.test(name)));
  assert.ok(loaded.includes('google.mjs'), 'the Google service is among them');
  assert.deepEqual(loadMomoServices({ dir: path.join(dir, 'missing'), deps: {}, report: () => undefined }), []);
});

test('Reset keeps the ids of the turns it deleted as settled, so an old id never reads "safe to send again"; an id the home never had reads unknown and is accepted once when a copy arrives, whichever copy is first (S2, S4)', async (t) => {
  const a = await studio(t);
  assert.equal((await a.home.turn('key-00000001')).state, 'accepted');
  await a.home.reset();
  const after: any = await a.home.turn('key-00000001');
  assert.deepEqual([after.state, after.void], ['cancelled', true]);
  assert.equal(a.home.voided('key-00000001'), true);
  assert.equal(a.home.voided('key-99999999'), false);
  // the tombstone is the Host's own and survives another Reset and a restart of the Host's object
  fs.mkdirSync(`${a.momoDir}.incoming`, { recursive: true });
  fs.mkdirSync(`${a.dataKeyDir}.incoming`, { recursive: true });
  await a.home.reset();
  assert.equal(
    fs.existsSync(`${a.momoDir}.incoming`) || fs.existsSync(`${a.dataKeyDir}.incoming`),
    false,
    'a stage a move left is deleted too',
  );
  assert.equal((await a.home.turn('key-00000001')).state, 'cancelled');
  // an id the home never had reads unknown (a pure read: asking changes nothing); a copy that arrives later is accepted once, and the other is a duplicate
  assert.equal((await a.home.turn('key-00000042')).state, 'unknown');
  const stores = a.home.stores()!;
  assert.equal(stores.turns.ids().includes('key-00000042'), false, 'asking wrote nothing');
  const accept = () => stores.turns.accept({ turnId: 'key-00000042', chatId: 'claude:c1', deviceId: null, leaseEpoch: 1 });
  const both = await Promise.all([accept(), accept()]);
  assert.deepEqual(both.map((r: any) => r.duplicate).sort(), [false, true], 'the original and its resend: one runs, one is a duplicate');
});

test('the home tells its watchers when it starts and stops running, and one that fails does not stop the rest (S5)', async (t) => {
  const a = await studio(t);
  const seen: string[] = [];
  a.home.watch(() => {
    throw new Error('screen gone');
  });
  const off = a.home.watch((e: any) => seen.push(`${e.running}:${e.state}`));
  await a.side.call('begin', { moveId: 'move-0001' });
  await a.side.call('cancel', { moveId: 'move-0001' });
  assert.deepEqual(seen, ['false:moving', 'true:running']);
  off();
  await a.side.call('begin', { moveId: 'move-0002' });
  assert.equal(seen.length, 2);
});
