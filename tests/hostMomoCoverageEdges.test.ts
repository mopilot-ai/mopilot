// The edges of MoMo's home, move and turn ledger that the main cases pass by: a record that cannot be read, a lease that is not newer, a write that cannot be kept, ids and files in the order they come.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoMove } from '../host/src/momoMove.mjs';
// @ts-ignore
import { createMomoTurns } from '../host/src/momoTurns.mjs';
// @ts-ignore
import { collectFiles, receiptOk } from '../host/src/momoBundle.mjs';
// @ts-ignore
import { loadMomoServices } from '../host/src/momoServices.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import methods from '../shared/host/methods/momo.mjs';
// @ts-ignore
import { createMomoChats } from '../host/src/momoChats.mjs';
import { B, host, studio } from './support/host/momoMoveWorld.ts';
import { world } from './support/host/momoChatsWorld.ts';

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: any) => String(e.code ?? e.message),
  );
const ids = { moveId: 'move-0001' };

/** A host whose home record cannot be read: another key sealed it. */
async function unreadable(t: any) {
  const h = await host(t, B, { granted: false });
  // a record another Host key sealed
  const other = createMomoHome({
    hostId: 'home-zzzz-9999',
    dataDir: path.join(h.dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(h.dir, 'other')),
  });
  await other.grant({ account: 'a1', features: ['momo'] });
  await other.start({ name: 'Other' });
  await other.close();
  // a home opened over it now finds a record it cannot read
  const home: any = createMomoHome({
    hostId: B.homeId,
    dataDir: path.join(h.dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(h.dir, 'config')),
    dataSafeStorage: createFileSafeStorage(h.dataKeyDir),
    dataKeyDir: h.dataKeyDir,
  });
  t.after(() => home.close());
  home.move = createMomoMove({ home });
  return { home, side: { call: (op: string, p: object = {}) => home.move[op]({ op, ...p }) } };
}

test('a home needs its Host’s own id, and a record that cannot be read is told as such by every step that needs it', async (t) => {
  assert.throws(
    () => createMomoHome({ dataDir: os.tmpdir(), safeStorage: createFileSafeStorage(os.tmpdir()) } as any),
    /needs this Host’s own id/,
  );
  const h = await unreadable(t);
  assert.equal(await code(h.side.call('offer', ids)), 'home_unavailable');
  assert.throws(
    () => h.home.canAdopt(2),
    (e: any) => e.code === 'home_unavailable',
  );
  await assert.rejects(h.home.tombstone({ name: 'x', homeId: 'y', leaseEpoch: 3 }), (e: any) => e.code === 'home_unavailable');
  await assert.rejects(h.home.start({ name: 'Mac mini' }), (e: any) => e.code === 'home_unavailable');
  assert.deepEqual(h.home.status().home, { state: 'unavailable' });
});

test('a lease that is not newer is refused by the record, and a home that exists refuses to adopt another', async (t) => {
  const a = await studio(t);
  await assert.rejects(
    a.home.swap(1, () => 1),
    (e: any) => e.code === 'home_lease_stale',
  );
  assert.throws(
    () => a.home.canAdopt(5),
    (e: any) => e.code === 'home_exists',
  );
  const told: unknown[] = [];
  a.home.watch((e: unknown) => told.push(e));
  await a.home.swap(1, () => 4);
  assert.deepEqual(told.at(-1), { running: true, state: 'running' });
});

test('Reset on a machine with no folder yet, and on a home with no data key folder, only clears what is there', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-edge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'c')),
  });
  t.after(() => home.close());
  await home.grant({ account: 'a1', features: ['momo'] });
  fs.rmSync(path.join(dir, 'data', 'momo'), { recursive: true, force: true });
  await home.reset();
  assert.equal(home.status().home, null);
});

test('the turn ledger keeps the newest pruned ids only, oldest settled first', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-turns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let at = 1000;
  const turns = createMomoTurns({
    dir: path.join(dir, 'momo'),
    safeStorage: createFileSafeStorage(path.join(dir, 'c')),
    now: () => (at += 10),
    keep: 1,
    keepGone: 2,
  });
  for (const id of ['turn-0001', 'turn-0002', 'turn-0003', 'turn-0004', 'turn-0005']) {
    await turns.accept({ turnId: id, chatId: 'claude:c1', deviceId: null, leaseEpoch: 1 });
    await turns.settle('claude:c1', 'completed');
  }
  assert.deepEqual(
    new Set(turns.ids()),
    new Set(['turn-0002', 'turn-0003', 'turn-0004', 'turn-0005']),
    'one in full, the two newest pruned ids; the oldest is forgotten',
  );
  assert.equal((turns.status('turn-0001') as any).state, 'unknown');
});

test('a stamp that cannot be kept is refused, never believed for a moment and then forgotten', async (t) => {
  const a = await studio(t);
  assert.equal((await a.home.receiveStamp({ homeId: B.homeId, leaseEpoch: 5 })).ok, true);
  // a folder where the sealed file must go: the next newer lease cannot be written
  fs.rmSync(path.join(a.momoDir, 'stamps.json'), { force: true });
  fs.mkdirSync(path.join(a.momoDir, 'stamps.json'));
  const refused: any = await a.home.receiveStamp({ homeId: B.homeId, leaseEpoch: 9 });
  assert.deepEqual([refused.ok, refused.reason], [false, 'not-kept']);
});

test('a receipt with a key that is no key is no receipt, and files come in a fixed order', () => {
  assert.equal(receiptOk('!!not-a-key!!', Buffer.from('x'), 'c2ln'), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-files-'));
  try {
    for (const f of ['b.json', 'a.json', 'c.json']) fs.writeFileSync(path.join(dir, f), f);
    assert.deepEqual(
      collectFiles(dir, () => false).map((f: any) => f.path),
      ['a.json', 'b.json', 'c.json'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Host’s own services folder is loaded by name: a file in it is given the deps and reported when it throws', () => {
  const folder = path.join(import.meta.dirname, '..', 'host', 'src', 'momoServices');
  const mine = path.join(folder, `zz-edge-${process.pid}.mjs`);
  const loadedWith: unknown[] = [];
  (globalThis as any).__momoEdge = loadedWith;
  fs.writeFileSync(mine, 'export default (deps) => globalThis.__momoEdge.push(deps);\n');
  try {
    // every service of the folder (each lane adds its own) loads against a home that takes any registration and refuses nothing
    // the parts a home only has once the Host has made them (the day, the scheduler, the push, the gate…) are none yet, as on a home before the serve entry sets them
    const unset = new Set(['daily', 'scheduler', 'push', 'intents', 'rows', 'gate', 'seams', 'chats', 'intentRegistry']);
    const home = new Proxy({}, { get: (_t, key) => (unset.has(String(key)) ? null : () => undefined), set: () => true });
    const reports: string[] = [];
    const loaded = loadMomoServices({ deps: { home }, report: (m: string) => reports.push(m) });
    assert.ok(loaded.includes(path.basename(mine)));
    assert.equal(loadedWith.length, 1);
    assert.equal((loadedWith[0] as { home: unknown }).home, home);
    assert.deepEqual(reports, []);
  } finally {
    fs.rmSync(mine, { force: true });
    delete (globalThis as any).__momoEdge;
  }
});

test('the wire parse of a move step: cancel with a proof, with none and with a null; and a reclaim names the caller only when the connection has one', async (t) => {
  const parse = methods({ bad: (m: string) => new Error(m), matchOf: (v: any) => v }).methods['host.momoMove'].parse;
  assert.deepEqual(parse({ op: 'cancel', moveId: 'move-0001' }), { op: 'cancel', moveId: 'move-0001' });
  assert.deepEqual(parse({ op: 'cancel', moveId: 'move-0001', proof: null }), { op: 'cancel', moveId: 'move-0001' });
  assert.deepEqual(parse({ op: 'cancel', moveId: 'move-0001', proof: 'sig' }), { op: 'cancel', moveId: 'move-0001', proof: 'sig' });
  const seen: any[] = [];
  const handler = (await import('../host/src/methods/momo.mjs' as any)).default({
    momo: { move: { reclaim: (p: any) => seen.push(p), begin: (p: any) => seen.push(p) } },
  }).handlers['host.momoMove'];
  handler({ op: 'reclaim', moveId: 'm' }, 'desktop', { principal: () => ({ fingerprint: 'fp' }) });
  handler({ op: 'reclaim', moveId: 'm' }, 'desktop', { principal: () => null });
  handler({ op: 'reclaim', moveId: 'm' }, 'desktop', {});
  handler({ op: 'reclaim', moveId: 'm' }, 'desktop');
  handler({ op: 'begin', moveId: 'm' }, 'desktop', {});
  assert.deepEqual(
    seen.map((p) => p.by ?? null),
    ['fp', null, null, null, null],
  );
  void t;
});

test('every MoMo chat’s turn is cancelled for a move, and one that cannot be stopped is reported while the rest still are', async () => {
  const w = await world();
  try {
    const first = await w.chats.start({ harness: 'claude' });
    const cancelled: string[] = [];
    const reported: string[] = [];
    const sessions: any = {
      ...w.h.sessions,
      chats: w.h.sessions.chats,
      host: {
        cancel: async (id: string) => {
          cancelled.push(id);
          throw new Error('the harness would not stop');
        },
      },
    };
    const chats = w.make(sessions);
    await chats.stopTurns();
    assert.deepEqual(cancelled, [first.chatId]);
    const quietChats = createMomoChats({
      home: w.home,
      sessions: { ...sessions, host: undefined },
      epochs: w.epochs,
      env: {},
      report: (m: string) => reported.push(m),
    });
    await quietChats.stopTurns();
    // a registry that cannot be read names no chat to stop
    fs.writeFileSync(path.join(w.momoDir, 'momo', 'chats.json'), 'not sealed');
    await w.make(sessions).stopTurns();
    assert.deepEqual(reported, [], 'a Host with no runtime to cancel on has nothing to stop');
    // a send that threw settles its turn; after a Reset the id reads as settled for good and is never run again
    const send = () => w.chats.rules.guard('chat.send', { chatId: first.chatId, key: 'key-00000001', text: 'x' });
    await send();
    w.chats.rules.sendFailed(first.chatId);
    await w.home.reset();
    const answered: any = await send();
    assert.deepEqual(answered.value, { duplicate: true, turnId: 'key-00000001', state: 'cancelled', void: true });
  } finally {
    await w.home.close();
  }
});
