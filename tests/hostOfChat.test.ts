// The Host a chat's events come from (electron/host/wiring.cjs hostOfChat, electron/host/machines.cjs hostOwnership): the chat's owner, this Mac for a chat nobody moved, an event outside any chat, or Host not wired; the ownership file is read again only when it changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hostOfChat } = require('../electron/host/wiring.cjs');
const { hostOwnership } = require('../electron/host/machines.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

test('an event outside any chat, and a chat while Host is not wired, are this Mac’s; a chat is its owner’s', () => {
  assert.equal(hostOfChat({}, null), 'local');
  assert.equal(hostOfChat({}, 'c1'), 'local');
  const live = { hostOwnership: { get: (id: string) => ({ hostId: id === 'remote' ? 'box' : 'local' }) } };
  assert.equal(hostOfChat(live, 'remote'), 'box');
  assert.equal(hostOfChat(live, 'c1'), 'local');
  assert.equal(hostOfChat(live, null), 'local');
});

test('the ownership file is read again only when it changes, and a chat moved by any writer is seen at its next event (A2)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-of-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'host-ownership.json');
  let allowed = true;
  const owners = hostOwnership({ dir, allowed: () => allowed });
  // no file: everything is local
  assert.deepEqual(owners.get('c1'), { hostId: 'local', epoch: 0 });
  const writer = new OwnershipStore(file);
  writer.set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/srv' });
  assert.deepEqual(owners.get('c1'), { hostId: 'box', epoch: 0 });
  // unchanged: the answer comes from memory (the file is not parsed again)
  const read = fs.readFileSync;
  let reads = 0;
  (fs as any).readFileSync = (...a: any[]) => (reads++, (read as any)(...a));
  try {
    for (let i = 0; i < 5; i++) owners.get('c1');
    assert.equal(reads, 0);
    writer.set('c1', { hostId: 'other', ownerHostId: 'other', epoch: 1, folder: '/w' });
    assert.deepEqual(owners.get('c1'), { hostId: 'other', epoch: 1 });
    assert.ok(reads > 0);
  } finally {
    (fs as any).readFileSync = read;
  }
  allowed = false;
  assert.deepEqual(owners.get('c1'), { hostId: 'local' });
});
