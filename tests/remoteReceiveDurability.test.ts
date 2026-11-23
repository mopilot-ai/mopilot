// Receive durability, revocation and bounded backlog behavior of the real remote channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred, tick } from './support/async-scenarios.ts';
import { until, pairing, msg, request, wireOf, drain, rig } from './support/remoteChannelRig.ts';
const require = createRequire(import.meta.url);
const { RECEIVE_MAX_FRAMES, RECEIVE_MAX_BYTES } = require('../electron/remote/channel.cjs');

test('receive: durable checkpoint precedes dispatch and a failed write never runs the request', async () => {
  const r = await rig();
  const save = deferred<void>();
  const update = r.devices.update.bind(r.devices);
  r.devices.update = async (...args: any[]) => {
    await save.promise;
    return update(...args);
  };
  r.relay.emit('frame', wireOf(r.phone, request('durable')));
  assert.equal(r.delivered.length, 0);
  save.reject(new Error('disk failure'));
  await tick();
  assert.equal(r.delivered.length, 0);
});

test('receive: stopping or replacing the pair during its checkpoint retires the old request', async () => {
  for (const action of ['stop', 'replace']) {
    const r = await rig();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const update = r.devices.update.bind(r.devices);
    r.devices.update = async (...args: any[]) => {
      if (args[1].rx) {
        entered.resolve();
        await gate.promise;
      }
      return update(...args);
    };
    r.relay.emit('frame', wireOf(r.phone, request('old')));
    await entered.promise;
    r.relay.emit('frame', wireOf(r.phone, request('queued')));
    const pending = drain(r);
    if (action === 'stop') r.channel.stop();
    else await r.devices.add(pairing('phone-1', 'p_replacement1').record);
    gate.resolve();
    await pending;
    assert.equal(r.delivered.length, 0, action);
  }
});

test('receive: a blocked pair does not block a different pair in the channel', async () => {
  const a = pairing('phone-1', 'p_pairedphone1');
  const b = pairing('phone-2', 'p_pairedphone2');
  const r = await rig({ phones: [a, b] });
  const gate = deferred<void>();
  const update = r.devices.update.bind(r.devices);
  r.devices.update = async (...args: any[]) => {
    if (args[0] === a.record.id && args[1].rx) await gate.promise;
    return update(...args);
  };
  r.relay.emit('frame', wireOf(a, request('a')));
  r.relay.emit('frame', wireOf(b, request('b')));
  await drain(r, b);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['b'],
  );
  gate.resolve();
  await drain(r, a);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['b', 'a'],
  );
});

test('receive: frame and byte queue limits pause the pair, keep what is queued, hold what is over unacknowledged, and ask the relay for it again when the queue is read', async () => {
  for (const kind of ['frames', 'bytes']) {
    const a = pairing('phone-1', 'p_pairedphone1');
    const b = pairing('phone-2', 'p_pairedphone2');
    const r = await rig({ phones: [a, b], reconnectMs: 1 });
    const gate = deferred<void>();
    const entered = deferred<void>();
    const update = r.devices.update.bind(r.devices);
    r.devices.update = async (...args: any[]) => {
      if (args[0] === a.record.id && args[1].rx) {
        entered.resolve();
        await gate.promise;
      }
      return update(...args);
    };
    const closed: string[] = [];
    const reopened: string[] = [];
    r.channel.onPairClosed((event: any) => closed.push(event.code));
    r.channel.onPairReopened((event: any) => reopened.push(event.code));
    const big = (i: number) => (kind === 'bytes' ? msg(`large${i}`, { patch: 'x'.repeat(200_000) }) : request(`small${i}`));
    const first = wireOf(a, big(0));
    r.relay.emit('frame', first);
    await entered.promise;
    const n = kind === 'frames' ? RECEIVE_MAX_FRAMES : Math.ceil(RECEIVE_MAX_BYTES / 200_000) + 1;
    const more = Array.from({ length: n }, (_, i) => wireOf(a, big(i + 1)));
    for (const f of more) r.relay.emit('frame', f);
    assert.deepEqual(closed, ['overload']);
    assert.equal(r.channel.closedReason(a.pairId), 'overload');
    assert.ok(r.channel.sessions.get(a.pairId).receiveQueue.length > 0, 'what was queued stays queued: it comes first');
    assert.equal(r.relay.reconnects, 0, 'the relay is asked once the queue has been read');
    // another pair is not held up
    r.relay.emit('frame', wireOf(b, request('other')));
    await drain(r, b);
    assert.deepEqual(
      r.delivered.map(([, m]) => m.id),
      ['other'],
    );
    gate.resolve();
    await drain(r, a);
    const read = r.delivered.filter(([pair]) => pair === a.pairId).length;
    assert.ok(read >= 2 && read <= n, `${read} frames read in order`);
    assert.equal(r.channel.sessions.get(a.pairId).receiveBytes, 0);
    await until(() => r.relay.reconnects >= 1);
    const held = r.channel.stats.held;
    assert.ok(held >= 1, 'the frame over the limit was held');
    // the relay connects again and sends what it never saw acknowledged: the session reads it
    r.relay.emit('open', { pairs: [] });
    assert.deepEqual(reopened, ['overload']);
    assert.equal(r.channel.closedReason(a.pairId), null);
    // the first frame that was refused is the next in order, and now it is read
    r.relay.emit('frame', more[read - 1]);
    await drain(r, a);
    assert.equal(r.delivered.filter(([pair]) => pair === a.pairId).length, read + 1);
    assert.equal(r.channel.stats.paused, 0);
  }
});

test('receive: a plain mailbox that deletes after delivery still loses the frames refused over the limit; the queued ones are all read', async () => {
  const r = await rig();
  const gate = deferred<void>();
  const entered = deferred<void>();
  const update = r.devices.update.bind(r.devices);
  r.devices.update = async (...args: any[]) => {
    if (args[1].rx) {
      entered.resolve();
      await gate.promise;
    }
    return update(...args);
  };
  const mailbox = Array.from({ length: RECEIVE_MAX_FRAMES + 1 }, (_, i) => wireOf(r.phone, request(`m_${i}`)));
  r.relay.emit('frame', mailbox.shift());
  await entered.promise;
  while (mailbox.length) r.relay.emit('frame', mailbox.shift());
  assert.equal(mailbox.length, 0, 'relay deletes after socket delivery, before a durable acknowledgement');
  assert.equal(r.channel.closedReason(r.phone.pairId), 'overload');
  gate.resolve();
  await drain(r);
  assert.equal(r.delivered.length, RECEIVE_MAX_FRAMES, 'the last frame was refused and, with this mailbox, cannot come again');
});

test('receive and send: a revoke or replacement called during real checkpoint rename retires the old effect', async () => {
  for (const operation of ['receive', 'send']) {
    for (const intent of ['remove', 'replace']) {
      const r = await rig();
      const gate = deferred<void>();
      const entered = deferred<void>();
      const realFs = r.devices.o.fs;
      let hold = true;
      r.devices.o.fs = {
        ...realFs,
        rename: async (...args: any[]) => {
          if (hold) {
            hold = false;
            entered.resolve();
            await gate.promise;
          }
          return realFs.rename(...args);
        },
      };
      let pending: Promise<any>;
      if (operation === 'receive') {
        r.relay.emit('frame', wireOf(r.phone, request('old')));
        pending = drain(r);
      } else {
        pending = r.channel.send(r.phone.pairId, msg('old')).catch((e: Error) => e);
      }
      await entered.promise;
      const change = intent === 'remove' ? r.devices.remove('phone-1') : r.devices.add(pairing('phone-1', 'p_replacement1').record);
      gate.resolve();
      await pending;
      await change;
      assert.equal(r.delivered.length, 0);
      assert.equal(r.relay.sent.length, 0);
    }
  }
});

test('device intent: pending removal blocks pre-reserved sends and failed removal permits a fresh lease', async () => {
  const r = await rig();
  await r.channel.send(r.phone.pairId, msg('reserve'));
  const oldLease = r.devices.lease('phone-1', r.phone.pairId);
  const gate = deferred<void>();
  const entered = deferred<void>();
  const realFs = r.devices.o.fs;
  r.devices.o.fs = {
    ...realFs,
    rename: async () => {
      entered.resolve();
      await gate.promise;
      throw new Error('disk full');
    },
  };
  const removal = r.devices.remove('phone-1');
  await entered.promise;
  await assert.rejects(r.channel.send(r.phone.pairId, msg('blocked')), /being changed/);
  assert.equal(r.devices.currentLease(oldLease), false);
  gate.resolve();
  await assert.rejects(removal, /disk full/);
  assert.ok(r.devices.get('phone-1'));
  r.devices.o.fs = realFs;
  assert.equal(r.devices.currentLease(oldLease), false);
  await r.channel.send(r.phone.pairId, msg('retry'));
  assert.equal(r.relay.sent.length, 2);
});

test('device intent: overlapping failed removals keep old leases retired until all attempts settle', async () => {
  const r = await rig();
  const old = r.devices.lease('phone-1', r.phone.pairId);
  const first = deferred<void>();
  const second = deferred<void>();
  const realFs = r.devices.o.fs;
  let calls = 0;
  r.devices.o.fs = {
    ...realFs,
    rename: async () => {
      const gate = ++calls === 1 ? first : second;
      await gate.promise;
      throw new Error('disk full');
    },
  };
  const one = r.devices.remove('phone-1');
  const two = r.devices.remove('phone-1');
  first.resolve();
  await assert.rejects(one, /disk full/);
  assert.equal(r.devices.lease('phone-1', r.phone.pairId), null);
  assert.equal(r.devices.currentLease(old), false);
  second.resolve();
  await assert.rejects(two, /disk full/);
  assert.equal(r.devices.currentLease(old), false);
  assert.ok(r.devices.lease('phone-1', r.phone.pairId));
  r.devices.o.fs = realFs;
  assert.equal(await r.devices.remove('phone-1'), true);
  assert.equal(r.devices.intents.size, 0);
  await r.devices.add(r.phone.record);
  assert.equal(r.devices.currentLease(old), false);
});

/** A removal that is stuck on the disk: the pair's lease is withdrawn, so the next frame ends its session for good ('retired'). */
async function retiring(r: Awaited<ReturnType<typeof rig>>) {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const realFs = r.devices.o.fs;
  r.devices.o.fs = {
    ...realFs,
    rename: async () => {
      entered.resolve();
      await gate.promise;
      throw new Error('disk full');
    },
  };
  const removal = r.devices.remove('phone-1');
  removal.catch(() => undefined);
  await entered.promise;
  r.relay.emit('frame', wireOf(r.phone, request('blocked')));
  assert.equal(r.channel.closedReason(r.phone.pairId), 'retired');
  return { release: () => gate.resolve(), removal };
}

test('a pair closed for good rejects ordinary sends, including those awaiting a checkpoint', async () => {
  const r = await rig();
  const gate = deferred<void>();
  const entered = deferred<void>();
  const update = r.devices.update.bind(r.devices);
  let blocked = false;
  r.devices.update = async (...args: any[]) => {
    if (args[1].tx && !blocked) {
      blocked = true;
      entered.resolve();
      await gate.promise;
    }
    return update(...args);
  };
  const sending = r.channel.send(r.phone.pairId, msg('ordinary'));
  const caught = sending.catch((e: Error) => e.message);
  await entered.promise;
  const stuck = await retiring(r);
  await assert.rejects(r.channel.send(r.phone.pairId, msg('after')), /session is closed/);
  gate.resolve();
  // the held checkpoint and the stuck removal share the disk: both are let go before either is waited for
  stuck.release();
  assert.match(await caught, /session is closed|Unknown pair|being changed|disk full/);
  await assert.rejects(stuck.removal, /disk full/);
});

test('failed revoke with an incoming frame leaves the pair closed and requires repair', async () => {
  const r = await rig();
  const gate = deferred<void>();
  const entered = deferred<void>();
  const realFs = r.devices.o.fs;
  r.devices.o.fs = {
    ...realFs,
    rename: async () => {
      entered.resolve();
      await gate.promise;
      throw new Error('disk full');
    },
  };
  const removal = r.devices.remove('phone-1');
  await entered.promise;
  const closed: string[] = [];
  r.channel.onPairClosed((e: any) => closed.push(e.code));
  r.relay.emit('frame', wireOf(r.phone, request('blocked')));
  assert.deepEqual(closed, ['retired']);
  gate.resolve();
  await assert.rejects(removal, /disk full/);
  assert.ok(r.devices.get('phone-1'));
  await assert.rejects(r.channel.send(r.phone.pairId, msg('still-closed')), /session is closed/);
  assert.equal(r.delivered.length, 0);
});

test('queued receive and send work cannot survive a retired owner or closed pair', async () => {
  const r = await rig();
  const gate = deferred<void>();
  const entered = deferred<void>();
  const update = r.devices.update.bind(r.devices);
  r.devices.update = async (...args: any[]) => {
    if (args[1].rx && args[1].rx.ctr === 1) {
      entered.resolve();
      await gate.promise;
    }
    return update(...args);
  };
  let removal: Promise<any> | undefined;
  r.channel.onMessage(() => {
    removal = r.devices.remove('phone-1');
  });
  r.relay.emit('frame', wireOf(r.phone, request('first')));
  await entered.promise;
  r.relay.emit('frame', wireOf(r.phone, request('second')));
  gate.resolve();
  await drain(r);
  await removal;
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['first'],
  );

  const x = await rig();
  const hold = deferred<void>();
  const started = deferred<void>();
  const save = x.devices.update.bind(x.devices);
  x.devices.update = async (...args: any[]) => {
    if (args[1].tx) {
      started.resolve();
      await hold.promise;
    }
    return save(...args);
  };
  const first = x.channel.send(x.phone.pairId, msg('first')).catch((e: Error) => e.message);
  await started.promise;
  const second = x.channel.send(x.phone.pairId, msg('second')).catch((e: Error) => e.message);
  const stuck = await retiring(x);
  hold.resolve();
  stuck.release();
  assert.match(await first, /session is closed|Unknown pair|being changed|disk full/);
  assert.match(await second, /session is closed|Unknown pair|being changed|disk full/);
  await assert.rejects(stuck.removal, /disk full/);
});

test('device leases reject missing, wrong and retired identities', async () => {
  const r = await rig();
  assert.equal(r.devices.lease('missing', r.phone.pairId), null);
  assert.equal(r.devices.lease('phone-1', 'p_wrongpair1'), null);
  assert.equal(r.devices.currentLease(null), false);
});
