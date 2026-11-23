// Relay fixture settling waits for starting and retiring connection owners, including work their queues start.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeHub, paired, settle, P } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const { db, reset } = await makeDb();
beforeEach(reset);
// Deliberate external-boundary latency exercises pending ownership; tests never use it as a readiness barrier.
const delayed = () => new Promise<void>((resolve) => setTimeout(resolve, 180));

test('join waits for the starting connection before it is registered in conns', async () => {
  const r = makeHub(db);
  const read = r.store.isRevoked.bind(r.store);
  r.store.isRevoked = async (id: string) => {
    await delayed();
    return read(id);
  };
  try {
    const mac = await r.join('u1', 'starting', 'desktop');
    assert.equal(mac.socket.of('hello').length, 1, 'join returns only after real startup answers');
    assert.equal(r.hub.conns.has('starting'), true);
  } finally {
    await Promise.all([...r.hub.all].map((c) => c.queue));
  }
});

test('settle waits for a retiring owner after it has left conns', async () => {
  const r = await paired(db);
  const conn = r.hub.conns.get('mac1')!;
  const read = r.store.phonesOfMac.bind(r.store);
  let finished = false;
  r.store.phonesOfMac = async (id: string) => {
    await delayed();
    const rows = await read(id);
    finished = true;
    return rows;
  };
  r.mac.h.close(1006);
  try {
    await waitFor(() => !r.hub.conns.has('mac1'), 'the retiring owner leaving current connections');
    await settle(r.hub);
    assert.equal(finished, true, 'retirement database work finished before settle returned');
  } finally {
    await conn.queue;
  }
});

test('settle follows tracked work created by a queue that retires its owner', async () => {
  let sent = false;
  const r = await paired(db, {
    send: async () => {
      await delayed();
      sent = true;
      return { ok: true };
    },
  });
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  const conn = r.hub.conns.get('mac1')!;
  r.mac.h.message(JSON.stringify({ t: 'push', pair: P, kind: 'done', ref: 'late', rid: 'held' }));
  r.mac.h.close(1000);
  try {
    await settle(r.hub);
    assert.equal(sent, true, 'the queued request reached and completed its provider');
    assert.equal(conn.kicks.size, 0, 'all tracked work completed even though its owner retired');
    assert.deepEqual(r.mac.socket.of('push.result'), [], 'a retired connection receives no reply');
  } finally {
    await conn.queue;
    await Promise.all(conn.kicks);
  }
});
