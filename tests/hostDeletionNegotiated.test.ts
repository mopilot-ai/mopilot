// A deletion waits for an update only when the machine's Host has answered a hello without `journalLifecycle`: a Host not heard from yet, or whose connection dropped, is only waiting to be reached (electron/host/remote.cjs negotiated, deletionOutbox.cjs outdated).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hostWorld, tick } from './support/host-wire-kit.ts';

const require = createRequire(import.meta.url);
const { createDeletionOutbox } = require('../electron/host/deletionOutbox.cjs');

test('too old only after a hello that lacks the feature: not before the first hello, not after a drop, not for a machine that is offline', {
  timeout: 20000,
}, async (t) => {
  const w = hostWorld(t);
  const host = w.remote(w.tunnel());
  let status = 'online';
  const outbox = createDeletionOutbox({
    dir: path.join(w.dir, 'deletions'),
    identity: () => 'mac',
    hostFor: () => host,
    rowOf: () => ({ status }),
  });
  // no hello yet
  assert.deepEqual([host.negotiated(), outbox.outdated('box')], [false, false]);
  // the stand-in Host answers a hello that does not offer journalLifecycle
  const up = host.connect();
  await tick();
  await up;
  assert.deepEqual([host.negotiated(), host.speaks('journalLifecycle'), outbox.outdated('box')], [true, false, true]);
  // a machine that is not online is waited for, not updated
  status = 'offline';
  assert.equal(outbox.outdated('box'), false);
  status = 'online';
  // the connection drops: nothing is known of the Host until it answers again
  w.children[0].die(255, 'Network is unreachable');
  await tick();
  assert.deepEqual([host.negotiated(), outbox.outdated('box')], [false, false]);
  // a Host that offers the feature is not too old
  const current = hostWorld(t);
  current.net.handlers['host.hello'] = () => ({
    protocol: { minor: 1, floor: 1 },
    features: ['epoch', 'dedupe', 'isolation', 'lanes', 'journalLifecycle'],
  });
  const fresh = current.remote(current.tunnel());
  const second = fresh.connect();
  await tick();
  await second;
  const other = createDeletionOutbox({
    dir: path.join(w.dir, 'other'),
    identity: () => 'mac',
    hostFor: () => fresh,
    rowOf: () => ({ status: 'online' }),
  });
  assert.deepEqual([fresh.negotiated(), other.outdated('box')], [true, false]);
  // a machine with no connection object at all
  const none = createDeletionOutbox({
    dir: path.join(w.dir, 'none'),
    identity: () => 'mac',
    hostFor: () => null,
    rowOf: () => ({ status: 'online' }),
  });
  assert.equal(none.outdated('box'), false);
});
