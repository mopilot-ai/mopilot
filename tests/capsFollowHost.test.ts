// What a chat can do follows where it runs (electron/host/wiring.cjs capsFollowHost): main tells the windows to read the
// chat's capabilities again (its steer is its Host agent's while a machine runs it) when a write moves a chat to or from a
// machine and when Host opens or closes, once for the writes of one task; a later main in the process replaces the earlier one's subscription.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { capsFollowHost } = require('../electron/host/wiring.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const access = require('../electron/host/access.cjs');

/** The notice goes out after the task that wrote: wait for it. */
const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const rec = (hostId: string, epoch: number) => ({ hostId, ownerHostId: hostId, epoch, folder: null });

test('a move to or from a machine and a change of Host’s gate each ask the windows again; a later main’s subscription replaces the earlier', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-follow-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const gate = access.openHostAccess({ dir, refresh: () => {}, flagOn: () => true });
  t.after(() => gate.dispose());
  // each notice records whether Host is open as the windows will read it
  const first: boolean[] = [];
  capsFollowHost(() => void first.push(access.hostAccess()));
  store.set('c1', rec('h1', 1));
  assert.deepEqual(first, [], 'told after the task that wrote');
  await settled();
  assert.deepEqual(first, [false], 'a chat went to a machine');
  access.updateHostAccess({ signedIn: true, user: { id: 'u1', features: [] }, checkedAt: Date.now() });
  await settled();
  assert.deepEqual(first, [false, true], 'Host opened, and the windows read it open');
  // a burst of moves in one task (a machine's side chats retired together) is one notice
  store.set('c2', rec('h1', 1));
  store.set('c3', rec('h2', 1));
  store.remove('c2');
  await settled();
  assert.equal(first.length, 3);
  const second: string[] = [];
  capsFollowHost(() => void second.push('changed'));
  store.remove('c1');
  await settled();
  access.updateHostAccess({ signedIn: false, user: null });
  await settled();
  assert.deepEqual(second, ['changed', 'changed'], 'back to this Mac, then Host closed');
  assert.equal(first.length, 3, 'the earlier main hears nothing more');
  capsFollowHost(() => {});
});
