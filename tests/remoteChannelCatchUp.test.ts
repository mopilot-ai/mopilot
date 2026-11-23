// The Mac's catch-up when a phone's counter is past MAX_SKIP but within the cap: it opens only under the pair's own chain, is not held up by the session's budget, and a failure changes nothing.
import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import * as E from '../shared/remote/envelope.mjs';
import { MAX_SKIP } from '../shared/remote/crypto.mjs';
import { crypto } from './support/remotePhone.ts';
import { msg, pairing, wireOf, drain, rig, until, type Pairing } from './support/remoteChannelRig.ts';

const require = createRequire(import.meta.url);
const CAP = MAX_SKIP + 1_000;

/** A phone sender `ahead` counters past the phone's current one, as if that many frames were lost; the phone's own sender is not moved. */
function farSender(p: Pairing, ahead: number) {
  const at = p.phone.tx.peek(ahead);
  return crypto.createSender({ pair: p.pairId, dir: 'p2m', chain: at.chain, ctr: at.ctr });
}
const seal = (s: any, m: object) => E.toWire(s.seal(E.encodeMessage(m)));
const saved = (r: any, p: Pairing) => r.devices.get(p.record.id).rx;

test('a frame beyond MAX_SKIP but within the cap is accepted: the counters move and the next frame in order opens', async () => {
  const r = await rig({ catchUpSkip: CAP });
  const acks: any[] = [];
  Object.assign(r.relay, { acks: true, sendAck: (m: any) => (acks.push(m), true) });
  const far = farSender(r.phone, MAX_SKIP + 10);
  const wire = seal(far, msg('m_far'));
  r.relay.emit('frame', wire);
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['m_far'],
  );
  assert.equal(saved(r, r.phone).ctr, wire.ctr);
  assert.deepEqual(
    acks.map((a) => a.ctr),
    [wire.ctr],
  );
  assert.equal(r.channel.stats.gaps, 0);
  r.relay.emit('frame', seal(far, msg('m_next')));
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['m_far', 'm_next'],
  );
  assert.equal(saved(r, r.phone).ctr, wire.ctr + 1);
  // a replay of the far frame is still behind the ratchet
  r.relay.emit('frame', wire);
  await drain(r);
  assert.equal(r.delivered.length, 2);
  assert.equal(r.channel.stats.duplicates, 1);
});

test('beyond the cap: the frame is dropped, nothing saved changes, and the phone is still told', async () => {
  const r = await rig({ catchUpSkip: CAP });
  const before = structuredClone(saved(r, r.phone));
  r.relay.emit('frame', seal(farSender(r.phone, CAP + 5), msg('m_far')));
  await drain(r);
  assert.equal(r.delivered.length, 0);
  assert.deepEqual(saved(r, r.phone), before);
  assert.equal(r.channel.stats.gaps, 1);
  await until(() => r.relay.sent.length === 1);
  assert.equal(E.decodeMessage(r.phone.phone.rx.open(E.decodeFrame(r.relay.sent[0]))).patch.reason, 'gap');
  r.relay.emit('frame', wireOf(r.phone, msg('m_ok')));
  await drain(r);
  assert.equal(r.delivered.length, 1, 'the receiver is where it was');
});

test('a forged far frame leaves the saved counter, the chain and the receiver untouched', async () => {
  const r = await rig({ catchUpSkip: CAP });
  const before = structuredClone(saved(r, r.phone));
  const wire = seal(farSender(r.phone, MAX_SKIP + 10), msg('m_far'));
  const box = E.fromBase64(wire.box);
  box[0] ^= 1;
  r.relay.emit('frame', { ...wire, box: E.toBase64(box) });
  await drain(r);
  assert.equal(r.delivered.length, 0);
  assert.deepEqual(saved(r, r.phone), before);
  assert.equal(r.channel.sessions.get(r.phone.pairId).rx.state().ctr, before.ctr);
  assert.equal(r.channel.stats.gaps, 1);
  r.relay.emit('frame', wireOf(r.phone, msg('m_ok')));
  await drain(r);
  assert.equal(r.delivered.length, 1, 'the real frame in order still opens');
});

/** Counts the hash steps the channel's walks take (patched before the first far frame, when the session's walker is made). */
function countSteps(r: any) {
  const steps = { n: 0 };
  const advance = r.channel.crypto.advance;
  r.channel.crypto.advance = (chain: Uint8Array, n: number) => ((steps.n += n), advance(chain, n));
  return steps;
}
const forge = (wire: any) => {
  const box = E.fromBase64(wire.box);
  box[0] ^= 1;
  return { ...wire, box: E.toBase64(box) };
};

test('no lockout: forged far frames repeated back to back cost bounded work and the real far frame still opens at once', async () => {
  const r = await rig({ catchUpSkip: CAP });
  const steps = countSteps(r);
  const far = farSender(r.phone, MAX_SKIP + 10);
  const real = seal(far, msg('m_real'));
  for (let i = 0; i < 6; i++) r.relay.emit('frame', forge(real));
  await drain(r);
  assert.equal(r.delivered.length, 0);
  assert.equal(r.channel.stats.gaps, 6);
  assert.ok(steps.n <= MAX_SKIP + 10 + 6 * 1024, `six forged frames cost ${steps.n} steps, not six walks`);
  const before = steps.n;
  r.relay.emit('frame', real);
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['m_real'],
  );
  assert.ok(steps.n - before <= 1024, 'the real frame resumed from the cached checkpoints');
});

test('a session that pauses while the far frame is walked leaves it unacknowledged and sends no gap notice; the relay sending it again after the reopen delivers it', async () => {
  const r = await rig({ catchUpSkip: CAP });
  const acks = [] as any[];
  Object.assign(r.relay, { acks: true, sendAck: (m: any) => (acks.push(m), true) });
  const wire = seal(farSender(r.phone, MAX_SKIP + 10), msg('m_far'));
  const s = r.channel.sessions.get(r.phone.pairId);
  r.relay.emit('frame', wire);
  r.channel.pauser.pause(s, 'overload'); // the receive queue filled up while the walk was running
  await drain(r);
  assert.equal(r.delivered.length, 0);
  assert.deepEqual(acks, [], 'not acknowledged: the relay will send it again');
  assert.equal(r.channel.stats.gaps, 0, 'not counted as a gap');
  assert.equal(r.relay.sent.length, 0, 'the phone is told nothing');
  r.channel.pauser.reopenAll();
  r.relay.emit('frame', wire);
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['m_far'],
  );
  assert.deepEqual(
    acks.map((a: any) => a.ctr),
    [wire.ctr],
  );
});

test('a session that ends, is replaced or has its receiver moved during the walk judges nothing: dropped, counted, nothing saved', async () => {
  for (const how of ['ended-mid-walk', 'ended-at-end', 'replaced', 'moved'] as const) {
    const r = await rig({ catchUpSkip: CAP });
    const before = structuredClone(saved(r, r.phone));
    const s = r.channel.sessions.get(r.phone.pairId);
    const steps = countSteps(r);
    if (how !== 'ended-mid-walk') {
      const real = (await import('../shared/remote/crypto.mjs')).createWalker(r.channel.crypto.advance, { stride: 1024, cap: CAP });
      s.walker = {
        ...real,
        async walkTo(b: any, t: number, o: any) {
          const chain = await real.walkTo(b, t, o);
          if (how === 'ended-at-end') s.closed = 'retired';
          if (how === 'replaced') r.channel.sessions.set(r.phone.pairId, { ...s });
          if (how === 'moved') s.rx = crypto.createReceiver({ pair: r.phone.pairId, dir: 'p2m', chain: b.chain, ctr: b.ctr + 1 });
          return chain;
        },
      };
    }
    r.relay.emit('frame', seal(farSender(r.phone, MAX_SKIP + 10), msg('m_far')));
    if (how === 'ended-mid-walk') s.closed = 'retired'; // before the first chunk: it is not even started
    await drain(r);
    assert.equal(r.delivered.length, 0, how);
    assert.deepEqual(saved(r, r.phone), before, how);
    assert.equal(r.channel.stats.gaps, 1, how);
    if (how === 'ended-mid-walk') assert.equal(steps.n, 0, 'no step was walked for a session that ended');
  }
});

test('a frame at or behind the receiver after the gap was seen is not walked for', async () => {
  const { catchUpOpen } = require('../electron/remote/catchUp.cjs');
  const s: any = { closed: null, rx: { state: () => ({ ctr: 50, chain: new Uint8Array(32) }) } };
  assert.equal(await catchUpOpen({ s, frame: { ctr: 50 }, crypto: {}, current: () => true }), null);
  assert.equal(await catchUpOpen({ s, frame: { ctr: 40 }, crypto: {}, current: () => true }), null);
});

test('the walk is not paid from the budget (a forged far counter cannot hold the session), and another session is not slowed', async () => {
  const a = pairing('phone-a', 'p_pairedphonea');
  const b = pairing('phone-b', 'p_pairedphoneb');
  const r = await rig({ phones: [a, b], catchUpSkip: CAP });
  const s = r.channel.sessions.get(a.pairId);
  const other = r.channel.sessions.get(b.pairId);
  r.relay.emit('frame', seal(farSender(a, MAX_SKIP + 10), msg('m_far')));
  await drain(r, a);
  assert.equal(r.delivered.length, 1);
  assert.ok(s.budget > 8_192 - 100, 'the walk did not take the budget a minutes-long wait would have needed');
  assert.equal(other.budget, 8_192, 'the other session paid nothing');
  r.relay.emit('frame', wireOf(b, msg('m_b')));
  await drain(r, b);
  assert.deepEqual(
    r.delivered.map(([p, m]) => [p, m.id]),
    [
      [a.pairId, 'm_far'],
      [b.pairId, 'm_b'],
    ],
  );
});

test('A3: a far frame held by a pause lets go of the frames queued behind it, so all of them come again in order and none is lost or opened out of order', async () => {
  const r = await rig({ catchUpSkip: CAP });
  const acks = [] as any[];
  Object.assign(r.relay, { acks: true, sendAck: (m: any) => (acks.push(m), true) });
  const far = farSender(r.phone, MAX_SKIP + 10);
  const wires = ['m_f', 'm_f1', 'm_f2'].map((id) => seal(far, msg(id)));
  const s = r.channel.sessions.get(r.phone.pairId);
  const real = (await import('../shared/remote/crypto.mjs')).createWalker(r.channel.crypto.advance, { stride: 1024, cap: CAP });
  let walks = 0;
  s.walker = {
    ...real,
    async walkTo(b: any, t: number, o: any) {
      const chain = await real.walkTo(b, t, o);
      // a later walk would find the session open again (the relay reconnected meanwhile): the frame behind the held one would open
      if (++walks === 2) r.channel.pauser.reopenAll();
      return chain;
    },
  };
  for (const w of wires) r.relay.emit('frame', w);
  r.channel.pauser.pause(s, 'overload'); // the receive queue filled up while the first walk was running
  await drain(r);
  assert.equal(walks, 1, 'the frames behind the held one were not read');
  assert.equal(s.receiveQueue.length, 0);
  assert.equal(s.receiveCount, 0);
  assert.equal(s.receiveBytes, 0);
  assert.equal(r.delivered.length, 0, 'none opened out of order');
  assert.deepEqual(acks, [], 'none acknowledged: the relay sends them all again');
  assert.equal(saved(r, r.phone).ctr, 0);
  assert.equal(s.receivingActive, false);
  r.channel.pauser.reopenAll();
  for (const w of wires) r.relay.emit('frame', w);
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['m_f', 'm_f1', 'm_f2'],
  );
  assert.deepEqual(
    acks.map((a: any) => a.ctr),
    wires.map((w) => w.ctr),
  );
  assert.equal(saved(r, r.phone).ctr, wires[2].ctr);
});

test('after an opened far frame is saved the walker holds no point at or below the new counter; a forged one leaves its points', async () => {
  const r = await rig({ catchUpSkip: CAP });
  const far = farSender(r.phone, MAX_SKIP + 10);
  const real = seal(far, msg('m_real'));
  r.relay.emit('frame', forge(real));
  await drain(r);
  const s = r.channel.sessions.get(r.phone.pairId);
  assert.ok(s.walker.points().length > 1, 'a forged frame leaves points of the true chain, all ahead of the saved counter');
  assert.ok(s.walker.points().every((k: number) => k >= saved(r, r.phone).ctr));
  r.relay.emit('frame', real);
  await drain(r);
  assert.equal(saved(r, r.phone).ctr, real.ctr);
  assert.deepEqual(s.walker.points(), [], 'nothing at or below the new counter, the base included');
  r.relay.emit('frame', seal(far, msg('m_next')));
  await drain(r);
  assert.deepEqual(s.walker.points(), []);
});

test('a session that never walked has nothing to forget', async () => {
  const r = await rig();
  r.relay.emit('frame', wireOf(r.phone, msg('m_ok')));
  await drain(r);
  assert.equal(r.delivered.length, 1);
  assert.equal(r.channel.sessions.get(r.phone.pairId).walker, undefined);
});
