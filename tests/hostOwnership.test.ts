// Host ownership side map (userData/host-ownership.json): missing = local, W3 corrupt file, W1 two writers, I1 delimiters in ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { OwnershipStore, LOCAL_HOST_ID } = require('../electron/host/ownership.cjs');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-ownership-')), 'host-ownership.json');
const rec = (hostId: string, epoch = 1, folder: string | null = '/work') => ({ hostId, ownerHostId: hostId, epoch, folder });

test('a chat nobody claimed is local at epoch 0, and the copy cannot edit the cache', () => {
  const store = new OwnershipStore(tmpFile());
  assert.deepEqual(store.get('c1'), { hostId: LOCAL_HOST_ID, ownerHostId: LOCAL_HOST_ID, epoch: 0, folder: null });
  assert.equal(store.error, null);
  store.set('c1', rec('h1'));
  store.get('c1').epoch = 99;
  assert.equal(store.get('c1').epoch, 1);
  assert.deepEqual(store.get('c1'), rec('h1'));
});

test('a record survives a restart; a missing folder is null; remove makes the chat local again', () => {
  const file = tmpFile();
  new OwnershipStore(file).set('c1', { hostId: 'h1', ownerHostId: 'h1', epoch: 2 });
  const again = new OwnershipStore(file);
  assert.deepEqual(again.get('c1'), rec('h1', 2, null));
  again.remove('c1');
  again.remove('never-there');
  assert.equal(new OwnershipStore(file).get('c1').epoch, 0);
});

test('invalid records and stale epochs are rejected without changing anything', () => {
  const store = new OwnershipStore(tmpFile());
  store.set('c1', rec('h1', 3));
  for (const bad of [
    { ...rec('h1'), epoch: -1 },
    { ...rec('h1'), epoch: 1.5 },
    { ...rec('h1'), hostId: '' },
    { ...rec('h1'), folder: 4 },
  ])
    assert.throws(() => store.set('c1', bad as any), /Invalid/);
  assert.throws(() => store.set('', rec('h1')), /Invalid/);
  assert.throws(() => store.set('c1', rec('h2', 2)), /Stale/);
  store.set('c1', rec('h2', 3));
  assert.equal(store.get('c1').hostId, 'h2');
});

test('W3: a corrupt file is reported, recovered from the last good copy, and kept for inspection', () => {
  const file = tmpFile();
  const first = new OwnershipStore(file);
  first.set('c1', rec('h1'));
  first.set('c2', rec('h2'));
  fs.writeFileSync(file, '{not json');
  const store = new OwnershipStore(file);
  assert.ok(store.error);
  assert.equal(store.get('c1').hostId, 'h1');
  assert.ok(fs.existsSync(`${file}.unreadable`));
  store.set('c3', rec('h3'));
  assert.equal(store.error, null);
  const healed = new OwnershipStore(file);
  assert.deepEqual([healed.get('c1').hostId, healed.get('c2').hostId, healed.get('c3').hostId], ['h1', 'h2', 'h3']);
});

test('W3: an entry of the wrong shape counts as corrupt; with no good copy nothing is invented and the error stays', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ c1: { hostId: 'h1' } }));
  const store = new OwnershipStore(file);
  assert.ok(store.error);
  assert.equal(store.get('c1').epoch, 0);
  fs.writeFileSync(file, '[]');
  assert.ok(new OwnershipStore(file).error);
});

test('W3: when the file and its copy are both unreadable, writes refuse until reset() accepts the loss', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{bad');
  const store = new OwnershipStore(file);
  assert.throws(() => store.set('c1', rec('h1')), /unreadable/);
  assert.throws(() => store.remove('c1'), /unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
  store.reset();
  store.set('c1', rec('h1'));
  assert.equal(new OwnershipStore(file).get('c1').hostId, 'h1');
  assert.equal(store.error, null);
});

test('W3: a copy that fails to write after the file is saved leaves the cache matching the file', () => {
  const file = tmpFile();
  const store = new OwnershipStore(file);
  fs.mkdirSync(`${file}.bak`);
  assert.throws(() => store.set('c1', rec('h1')));
  assert.equal(store.get('c1').hostId, 'h1');
  assert.equal(new OwnershipStore(file).get('c1').hostId, 'h1');
});

test('W3: a failed write keeps the cache and the file as they were', () => {
  const file = tmpFile();
  const store = new OwnershipStore(file);
  store.set('c1', rec('h1'));
  const before = fs.readFileSync(file, 'utf8');
  fs.rmSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.dirname(file), 'a file where the folder was');
  assert.throws(() => store.set('c2', rec('h2')));
  assert.equal(store.get('c2').epoch, 0);
  assert.equal(store.get('c1').hostId, 'h1');
  assert.ok(before.includes('h1'));
});

test("W1: two stores on one file keep each other's chats, including a removal", () => {
  const file = tmpFile();
  const a = new OwnershipStore(file);
  const b = new OwnershipStore(file);
  a.set('c1', rec('h1'));
  b.set('c2', rec('h2'));
  a.set('c3', rec('h3'));
  const all = new OwnershipStore(file);
  assert.deepEqual(
    ['c1', 'c2', 'c3'].map((id) => all.get(id).hostId),
    ['h1', 'h2', 'h3'],
  );
  b.remove('c1');
  const after = new OwnershipStore(file);
  assert.equal(after.get('c1').epoch, 0);
  assert.equal(after.get('c2').hostId, 'h2');
});

test('I1: ids with delimiters, quotes and prototype names are distinct ordinary keys', () => {
  const file = tmpFile();
  const ids = ['a|b', 'a', 'b', 'a:b', '"q"', 'x\\y', '__proto__', 'constructor', 'toString', 'a\nb'];
  const store = new OwnershipStore(file);
  ids.forEach((id, i) => store.set(id, rec(`h${i}`)));
  const again = new OwnershipStore(file);
  ids.forEach((id, i) => assert.equal(again.get(id).hostId, `h${i}`));
  assert.equal(again.get('hasOwnProperty').epoch, 0);
  assert.equal(({} as any).hostId, undefined);
});

test("refresh picks up another store's write; hostId and ownerHostId may differ", () => {
  const file = tmpFile();
  const a = new OwnershipStore(file);
  const b = new OwnershipStore(file);
  b.set('c1', { hostId: 'h2', ownerHostId: 'h1', epoch: 4, folder: null });
  assert.equal(a.get('c1').epoch, 0);
  a.refresh();
  assert.deepEqual(a.get('c1'), { hostId: 'h2', ownerHostId: 'h1', epoch: 4, folder: null });
});

test('remoteChats lists the chats a machine runs, with the machine and the folder, and none that run here', () => {
  const store = new OwnershipStore(tmpFile());
  assert.deepEqual(store.remoteChats(), []);
  store.set('a', { hostId: 'box', ownerHostId: 'box', epoch: 1, folder: '/srv/a' });
  store.set('b', { hostId: LOCAL_HOST_ID, ownerHostId: LOCAL_HOST_ID, epoch: 2, folder: null });
  store.set('c', { hostId: 'other', ownerHostId: 'box', epoch: 1, folder: null });
  assert.deepEqual(store.remoteChats(), [
    { chatId: 'a', hostId: 'box', folder: '/srv/a' },
    { chatId: 'c', hostId: 'other', folder: null },
  ]);
});
