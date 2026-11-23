// The Mac's channel (electron/remote/channel.cjs) with a relay that keeps frames until acked: a receipt goes out only once the receive ratchet is saved (or the frame can never be accepted), duplicates from a redelivery are acked and ignored, and a failed save is left for the relay to redeliver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MAX_SKIP } from '../shared/remote/crypto.mjs';
import { deferred } from './support/async-scenarios.ts';
import { msg, request, wireOf, drain, rig, pairing } from './support/remoteChannelRig.ts';
const require = createRequire(import.meta.url);
const { RECEIVE_MAX_FRAMES } = require('../electron/remote/channel.cjs');

/** A rig whose relay advertises acks and records them; `snapshot` captures what was true when each ack went out. */
async function ackRig(o: Parameters<typeof rig>[0] = {}) {
  const r = await rig(o);
  const acks: any[] = [];
  const atAck: { delivered: number; saved: number }[] = [];
  Object.assign(r.relay, {
    acks: true,
    sendAck: (m: any) => {
      acks.push(m);
      atAck.push({ delivered: r.delivered.length, saved: r.devices.list()[0].rx.ctr });
      return true;
    },
  });
  return { ...r, acks, atAck };
}
const ctrs = (acks: any[]) => acks.map((a) => a.ctr);

test('acks: a frame is acked after its ratchet is saved and before it is dispatched', async () => {
  const r = await ackRig();
  r.relay.emit('frame', wireOf(r.phone, request('a')));
  r.relay.emit('frame', wireOf(r.phone, request('b')));
  await drain(r);
  assert.deepEqual(r.acks, [
    { t: 'ack', pair: r.phone.pairId, dir: 'p2m', ctr: 1 },
    { t: 'ack', pair: r.phone.pairId, dir: 'p2m', ctr: 2 },
  ]);
  assert.deepEqual(r.atAck, [
    { delivered: 0, saved: 1 },
    { delivered: 1, saved: 2 },
  ]);
});

test('acks: a failed save is not acked, so the relay redelivers it; the pair closes as before', async () => {
  const r = await ackRig();
  const closed: string[] = [];
  r.channel.onPairClosed((e: any) => closed.push(e.code));
  r.devices.update = async () => {
    throw new Error('disk full');
  };
  r.relay.emit('frame', wireOf(r.phone, request('a')));
  await drain(r);
  assert.deepEqual([r.acks, closed, r.delivered.length], [[], ['storage'], 0]);
});

test('acks: a frame that comes again is acked and ignored, in either order, and later frames still arrive', async () => {
  const r = await ackRig();
  const first = wireOf(r.phone, msg('m_1'));
  const second = wireOf(r.phone, msg('m_2'));
  const closed: string[] = [];
  r.channel.onPairClosed((e: any) => closed.push(e.code));
  r.relay.emit('frame', first);
  r.relay.emit('frame', first); // lost ack: the same frame again (replay)
  r.relay.emit('frame', second);
  r.relay.emit('frame', first); // a redelivery from an old backlog (rewind)
  r.relay.emit('frame', wireOf(r.phone, msg('m_3')));
  await drain(r);
  assert.deepEqual(closed, []);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['m_1', 'm_2', 'm_3'],
  );
  assert.deepEqual(ctrs(r.acks), [1, 1, 2, 1, 3]);
  assert.equal(r.channel.duplicates, 2);
});

test('acks: a crash between save and ack is a duplicate after the restart, not a closed session', async () => {
  const r = await ackRig();
  const f = wireOf(r.phone, request('once'));
  r.relay.emit('frame', f);
  await drain(r);
  const again = await r.restart();
  const acks: any[] = [];
  Object.assign(again.relay, { acks: true, sendAck: (m: any) => (acks.push(m), true) });
  const received: any[] = [];
  again.channel.onMessage((_p: string, m: any) => received.push(m));
  again.relay.emit('frame', f);
  await again.channel.sessions.get(r.phone.pairId).receiving;
  assert.deepEqual([received.length, ctrs(acks), again.channel.duplicates], [0, [1], 1]);
});

test('acks: without relay support nothing is sent, and a repeat is dropped without ending the session', async () => {
  const r = await ackRig();
  (r.relay as any).acks = false;
  const closed: string[] = [];
  r.channel.onPairClosed((e: any) => closed.push(e.code));
  const f = wireOf(r.phone, msg('m_1'));
  r.relay.emit('frame', f);
  r.relay.emit('frame', f);
  await drain(r);
  assert.deepEqual([r.acks, closed, r.channel.stats.duplicates], [[], [], 1]);
});

test('acks: frames that can never be accepted are acked so the relay stops redelivering them', async () => {
  const r = await ackRig();
  const closed: string[] = [];
  r.channel.onPairClosed((e: any) => closed.push(e.code));
  const good = wireOf(r.phone, msg('m_1'));
  const forged = wireOf(r.phone, msg('m_2'));
  forged.box = forged.box.slice(0, -4) + (forged.box.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  r.relay.emit('frame', forged);
  await drain(r);
  assert.deepEqual([ctrs(r.acks), r.channel.droppedFrames, closed], [[2], 1, []]);
  r.relay.emit('frame', { ...good, pair: 'p_unknownpair1' });
  r.relay.emit('frame', { ...good, ctr: MAX_SKIP + 5 });
  await drain(r);
  assert.deepEqual(closed, [], 'a gap does not end the session');
  r.relay.emit('frame', wireOf(r.phone, msg('m_3'))); // the next frame in order opens and is acked
  await drain(r);
  assert.deepEqual(ctrs(r.acks), [2, MAX_SKIP + 5, 3], 'an unknown pair is left for the relay to redeliver');
  assert.equal(r.delivered.at(-1)?.[1].id, 'm_3');
});

test('acks: a hello (counter 0) is never acked, and a sealed non-message is acked once saved', async () => {
  const hellos: any[] = [];
  const r = await ackRig({ onHello: (f: any) => hellos.push(f) });
  r.relay.emit('frame', { ...wireOf(r.phone, msg('x')), ctr: 0 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual([r.acks, hellos.length], [[], 1]);
  const junk = wireOf(r.phone, { not: 'a protocol message' });
  r.relay.emit('frame', junk);
  await drain(r);
  assert.deepEqual([ctrs(r.acks), r.channel.droppedFrames, r.delivered.length], [[2], 1, 0]);
});

test('acks: a retired pair, a lost lease and an unsaved checkpoint are acked as dropped', async () => {
  const r = await ackRig();
  r.devices.lease = () => null;
  r.relay.emit('frame', wireOf(r.phone, request('a')));
  assert.deepEqual(ctrs(r.acks), [1], 'no lease at receive');
  const q = await ackRig();
  q.devices.currentLease = () => false;
  q.relay.emit('frame', wireOf(q.phone, request('a')));
  await drain(q);
  assert.deepEqual(ctrs(q.acks), [1], 'lease gone before opening');
  const s = await ackRig();
  const checks = [true, false];
  s.devices.currentLease = () => checks.shift() ?? false;
  s.relay.emit('frame', wireOf(s.phone, request('a')));
  await drain(s);
  assert.deepEqual([ctrs(s.acks), s.delivered.length], [[1], 0], 'lease gone after the save');
  const t = await ackRig();
  t.devices.update = async () => false;
  t.relay.emit('frame', wireOf(t.phone, request('a')));
  await drain(t);
  assert.deepEqual(ctrs(t.acks), [1], 'device removed during the save');
});

test('acks: a queue overflow pauses the pair and leaves the frame that did not fit unacknowledged, so the relay sends it again', async () => {
  const a = pairing('phone-1', 'p_pairedphone1');
  const r = await ackRig({ phones: [a] });
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
  const frames = Array.from({ length: RECEIVE_MAX_FRAMES + 2 }, (_, i) => wireOf(a, request(`m_${i}`)));
  r.relay.emit('frame', frames[0]);
  await entered.promise;
  for (const f of frames.slice(1)) r.relay.emit('frame', f);
  assert.ok(!ctrs(r.acks).includes(RECEIVE_MAX_FRAMES + 1), 'the frame past the limit is not acked: it is not lost');
  assert.equal(r.channel.closedReason(a.pairId), 'overload');
  gate.resolve();
  await drain(r, a);
  // everything that was queued is read first and acknowledged; only the frames over the limit wait for the relay to send them again
  assert.deepEqual(
    ctrs(r.acks),
    Array.from({ length: RECEIVE_MAX_FRAMES }, (_, i) => i + 1),
  );
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    Array.from({ length: RECEIVE_MAX_FRAMES }, (_, i) => `m_${i}`),
  );
});
