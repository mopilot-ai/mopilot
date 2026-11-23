// The side map's lost-host record (electron/host/ownership.cjs): kept, validated, copied, and listed by the Host it came from (W3, I1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-lost-')), 'host-ownership.json');
const lost = { sourceHostId: 'a|b', targetHostId: 'h2', epoch: 2, rev: 5 };
const rec = (extra: object = {}): any => ({ hostId: 'h2', ownerHostId: 'h2', epoch: 2, folder: '/w', ...extra });

test('a lost-host record survives a restart, is copied out, and drops fields it does not know', () => {
  const f = file();
  const store = new OwnershipStore(f);
  store.set('c1', rec({ lostHost: { ...lost, extra: 1 } }));
  store.set('c2', rec());
  const got: any = new OwnershipStore(f).get('c1');
  assert.deepEqual(got, rec({ lostHost: lost }));
  got.lostHost.rev = 99;
  assert.equal((store.get('c1') as any).lostHost.rev, 5);
  assert.equal('lostHost' in store.get('c2'), false);
});

test('I1: the Host a chat was lost from is found by its id, delimiters and all, and only by it', () => {
  const store = new OwnershipStore(file());
  store.set('c1', rec({ lostHost: lost }));
  store.set('c2', rec({ lostHost: { ...lost, sourceHostId: 'a' } }));
  store.set('c3', rec());
  assert.deepEqual(store.lostFrom('a|b'), [{ chatId: 'c1', epoch: 2, targetHostId: 'h2' }]);
  assert.deepEqual(store.lostFrom('a'), [{ chatId: 'c2', epoch: 2, targetHostId: 'h2' }]);
  assert.deepEqual(store.lostFrom('nobody'), []);
});

test('W3: a malformed lost-host record is rejected on write and counts as a corrupt file on read', () => {
  const store = new OwnershipStore(file());
  for (const bad of [null, 'x', { ...lost, epoch: 0 }, { ...lost, rev: -1 }, { ...lost, sourceHostId: '' }, { ...lost, targetHostId: 3 }])
    assert.throws(() => store.set('c1', rec({ lostHost: bad })), /Invalid/);
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ c1: rec({ lostHost: { ...lost, epoch: 'two' } }) }));
  assert.ok(new OwnershipStore(f).error);
});

test('setting the record again without the lost host closes it', () => {
  const store = new OwnershipStore(file());
  store.set('c1', rec({ lostHost: lost }));
  store.set('c1', rec());
  assert.equal((store.get('c1') as any).lostHost, undefined);
});
