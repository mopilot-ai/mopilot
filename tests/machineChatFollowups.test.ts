// The ownership file survives one bad optional field (a stray `takenIn: true` from an unmerged build): the record keeps what is good and the whole map stays readable; a message the Host refused is still a pending message of its chat; and the startup sweep keeps a binding a window has open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world, msg, UUID, code } from './support/host/remoteSendKit.ts';

const require = createRequire(import.meta.url);
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const { registerHostLists } = require('../electron/app/ipc/hostLists.cjs');

const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-followups-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const record = (o: object = {}) => ({ hostId: 'box', ownerHostId: 'box', epoch: 2, folder: '/w', ...o });

test('a mark that is no time drops that mark and keeps the record, and the rest of the map reads as it was', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'host-ownership.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      stray: record({ takenIn: true }),
      zero: record({ takenIn: 0 }),
      text: record({ takenIn: 'yesterday' }),
      good: record({ takenIn: 1_700_000_000_000 }),
      plain: record(),
    }),
  );
  const store = new OwnershipStore(file);
  assert.equal(store.error, null, 'the file is readable');
  assert.equal(store.lost, false);
  for (const id of ['stray', 'zero', 'text', 'plain'] as const) {
    const r = store.get(id);
    assert.deepEqual([r.hostId, r.epoch, r.folder, r.takenIn, r.lostHost], ['box', 2, '/w', undefined, undefined], id);
  }
  assert.equal(store.get('good').takenIn, 1_700_000_000_000);
  assert.deepEqual(store.takenInChats(), [{ chatId: 'good', at: 1_700_000_000_000 }]);
  // a write after such a read keeps every record and writes only what is valid
  store.set('new', record({ takenIn: 1_700_000_000_001 }));
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(written).sort(), ['good', 'new', 'plain', 'stray', 'text', 'zero']);
  assert.equal(written.stray.takenIn, undefined);
});

test('a record without its base fields still makes the file unreadable, as before; a backup is read with the same tolerance', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'host-ownership.json');
  fs.writeFileSync(file, JSON.stringify({ broken: { hostId: 'box' }, fine: record() }));
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ kept: record({ takenIn: true }) }));
  const store = new OwnershipStore(file);
  assert.ok(store.error, 'the main file is not usable');
  assert.equal(store.get('kept').hostId, 'box', 'the last good copy is read');
  assert.equal(store.get('kept').takenIn, undefined, 'with a stray mark dropped');
});

test('a message the Host refused, and one still on its way, is a pending message of its chat until it is acknowledged or deleted', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.host.failWith = code('That is not allowed here.', 'forbidden');
  await w.service.send('c1', msg('refused', UUID(1)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.sent, [], 'the Host did not take it');
  assert.equal(w.service.hasPending('c1'), true, 'refused: still the chat has a message waiting');
  w.host.failWith = code('The machine is not reachable.', 'host_unreachable');
  w.remote('c2');
  await w.service.send('c2', msg('unreachable', UUID(2)), 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(w.service.hasPending('c2'), true, 'unreachable: retryable, still waiting');
  w.host.failWith = null;
  await w.comeBack();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.service.hasPending('c2'), false, 'once delivered and acknowledged it is none');
});

/** A run of the app over a folder with two old taken-in bindings, no records; `read` is the first read of the list, with what the window sends. */
async function firstRead(t: any, sent: unknown[]) {
  const dir = tmp(t);
  const own = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const old = Date.now() - 9 * 24 * 3600 * 1000;
  for (const id of ['open', 'idle']) own.set(`acp:host-claude:${id}`, record({ takenIn: old }));
  const lists = new Map<string, (...a: unknown[]) => unknown>();
  registerHostLists({
    ipcMain: { handle: (channel: string, fn: (...a: unknown[]) => unknown) => void lists.set(channel, fn) },
    handle: () => undefined,
    allowed: () => true,
    service: () => ({ list: () => ({ machines: [] }), chatIndex: () => [], row: () => ({}) }),
    deps: { live: { chats: { get: () => undefined } } },
    chats: {
      pendingDeletions: () => [],
      takenInChats: () => own.takenInChats(),
      release: (id: string) => own.remove(id),
      takenIn: () => true,
      markTakenIn: () => undefined,
      setEpoch: () => undefined,
    },
    folders: () => ({ bind: () => undefined }),
  });
  await lists.get('host:chatIndex')!({}, ...sent);
  return ['open', 'idle'].map((n) => own.get(`acp:host-claude:${n}`).hostId);
}

test('the first read of the list keeps a binding the reading window has open or selected, however old and unrecorded; anything else it is told is ignored', async (t) => {
  assert.deepEqual(await firstRead(t, [['acp:host-claude:open']]), ['box', 'local'], 'the open one stays, the idle one goes');
  assert.deepEqual(await firstRead(t, []), ['local', 'local'], 'a read that names no chat judges them all');
  assert.deepEqual(await firstRead(t, ['not a list']), ['local', 'local'], 'a text is no list');
  assert.deepEqual(await firstRead(t, [[7, null, 'acp:host-claude:open', { id: 'x' }]]), ['box', 'local'], 'only text ids count');
  const many = Array.from({ length: 200 }, (_, i) => `c${i}`);
  assert.deepEqual(await firstRead(t, [[...many, 'acp:host-claude:open']]), ['local', 'local'], 'a list is cut at 64 ids');
});
