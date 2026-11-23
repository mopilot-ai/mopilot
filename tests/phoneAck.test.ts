// The phone side of acknowledged delivery (shared/remote/phoneRelay.mjs acker + phoneSession.mjs): receipts go out only after the ratchet is saved, redeliveries are acked and ignored, unopenable frames are acked, failed saves are not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhoneRelay } from '../shared/remote/phoneRelay.mjs';
import { createPhoneSession } from '../shared/remote/phoneSession.mjs';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { toHex, toWire, utf8 } from '../shared/remote/envelope.mjs';
import { prim } from './support/phonePairingFixture.ts';

const PAIR = 'p_12345678';

async function connected(hello: object = { t: 'hello', acks: true }, o: { throwSend?: boolean } = {}) {
  const frames: any[] = [];
  let closes = 0;
  const socket: any = {
    sent: [] as any[],
    send(text: string) {
      if (o.throwSend && JSON.parse(text).t === 'ack') throw new Error('closed');
      this.sent.push(JSON.parse(text));
    },
    close() {
      closes++;
    },
  };
  const relay = createPhoneRelay({ open: () => socket, onFrame: (f) => frames.push(f), onEvent: () => {}, onClose: () => {} });
  const connect = relay.connect('wss://relay.example/v1/ws', 't');
  socket.onmessage({ data: JSON.stringify(hello) });
  await connect;
  return { relay, socket, frames, closes: () => closes };
}
const ackWire = { pair: PAIR, dir: 'm2p', ctr: 3 };

test('the relay client acks only when the hello said acks, only while connected, and forgets that on close', async () => {
  const on = await connected();
  assert.equal(on.relay.acker.enabled(), true);
  assert.equal(on.relay.acker.settle(ackWire, 'accepted'), true);
  assert.deepEqual(on.socket.sent.at(-1), { t: 'ack', ...ackWire });
  on.relay.close();
  assert.equal(on.relay.acker.enabled(), false);
  assert.equal(on.relay.acker.settle(ackWire, 'accepted'), false);
  const off = await connected({ t: 'hello' });
  assert.equal(off.relay.acker.settle(ackWire, 'accepted'), false);
  assert.deepEqual(off.socket.sent, []);
  const broken = await connected({ t: 'hello', acks: true }, { throwSend: true });
  assert.equal(broken.relay.acker.settle(ackWire, 'accepted'), false, 'a socket that refuses says so');
});

function rig(enabled: boolean) {
  const chain = prim.randomBytes(32);
  const crypto = createCrypto(prim);
  let pair: any = { tx: { ctr: 0, chain: toHex(chain) }, rx: { ctr: 0, chain: toHex(chain) } };
  const settled: [number, string][] = [];
  const received: any[] = [];
  const handed: number[] = [];
  let failSave: Error | null = null;
  const session = createPhoneSession({
    prim,
    pairId: PAIR,
    vault: {
      async updatePair(_id: string, fn: any) {
        const result = fn(structuredClone(pair));
        if (failSave) throw failSave;
        pair = result.pair;
        return result.value;
      },
    },
    send: async () => {},
    onMessage: (m: any) => received.push([m, pair.rx.ctr]),
    acker: {
      enabled: () => enabled,
      settle: (f: any, outcome: any) => (settled.push([f.ctr, outcome]), handed.push(received.length), true),
    },
  });
  const sender = crypto.createSender({ pair: PAIR, dir: 'm2p', chain });
  const frame = (id: string) => toWire(sender.seal(utf8(JSON.stringify({ id, t: 1, kind: 'event' }))));
  return { session, settled, received, handed, frame, failWith: (e: Error | null) => (failSave = e) };
}

test('a frame is acked once its ratchet is saved, before the message is handed over', async () => {
  const r = rig(true);
  const f1 = r.frame('a');
  await r.session.receive(f1);
  assert.deepEqual(r.settled, [[1, 'accepted']]);
  assert.deepEqual(r.received, [[{ id: 'a', t: 1, kind: 'event' }, 1]]);
  assert.deepEqual(r.handed, [0], 'the receipt went out before the message was handed over');
});

test('a redelivered frame is acked and ignored, in either order, and later frames still arrive', async () => {
  const r = rig(true);
  const f1 = r.frame('a');
  const f2 = r.frame('b');
  await r.session.receive(f1);
  await r.session.receive(f1); // replay
  await r.session.receive(f2);
  await r.session.receive(f1); // rewind
  assert.deepEqual(r.settled, [
    [1, 'accepted'],
    [1, 'duplicate'],
    [2, 'accepted'],
    [1, 'duplicate'],
  ]);
  assert.deepEqual(
    r.received.map(([m]) => m.id),
    ['a', 'b'],
  );
});

test('a frame that can never be opened is acked as dropped and still fails; a failed save is not acked', async () => {
  const r = rig(true);
  const forged = r.frame('a');
  forged.box = forged.box.slice(0, -4) + (forged.box.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  await assert.rejects(r.session.receive(forged));
  assert.deepEqual(r.settled, [[1, 'dropped']]);
  await assert.rejects(r.session.receive({ ...forged, pair: 'x' }));
  assert.deepEqual(r.settled.at(-1), [1, 'dropped'], 'a malformed frame is dropped too');
  const s = rig(true);
  s.failWith(new Error('disk full'));
  await assert.rejects(s.session.receive(s.frame('a')), /disk full/);
  assert.deepEqual(s.settled, []);
});

test('without relay support a repeated frame still fails and nothing is acked', async () => {
  const r = rig(false);
  const f1 = r.frame('a');
  await r.session.receive(f1);
  await assert.rejects(r.session.receive(f1), /counter/);
  assert.deepEqual(r.settled, [[1, 'accepted']]);
});
