// Phone channel persists both ratchets before external effects, and retirement suppresses delayed delivery.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhoneSession } from '../shared/remote/phoneSession.mjs';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { toHex, toWire, utf8 } from '../shared/remote/envelope.mjs';
import { prim, deferred } from './support/phonePairingFixture.ts';

test('persists ratchets before send and dispatch and rejects replays', async () => {
  const chain = prim.randomBytes(32),
    crypto = createCrypto(prim);
  let pair: any = { tx: { ctr: 0, chain: toHex(chain) }, rx: { ctr: 0, chain: toHex(chain) } };
  const sent: any[] = [],
    received: any[] = [];
  const session = createPhoneSession({
    prim,
    pairId: 'p_12345678',
    vault: {
      async updatePair(_id: string, fn: any) {
        const result = fn(structuredClone(pair));
        pair = result.pair;
        return result.value;
      },
    },
    send: async (frame: any) => {
      assert.equal(pair.tx.ctr, 1);
      sent.push(frame);
    },
    onMessage: (message: any) => {
      assert.equal(pair.rx.ctr, 1);
      received.push(message);
    },
  });
  await session.send({ id: '1', t: 1, kind: 'event' });
  assert.equal(sent.length, 1);
  const sender = crypto.createSender({ pair: 'p_12345678', dir: 'm2p', chain });
  const wire = toWire(sender.seal(utf8(JSON.stringify({ id: '2', t: 2, kind: 'event' }))));
  await session.receive(wire);
  assert.deepEqual(received, [{ id: '2', t: 2, kind: 'event' }]);
  await assert.rejects(session.receive(wire), /counter/);
  session.close();
  await assert.rejects(session.send({}), /closed/);
});

test('does not send after close while persistence is pending', async () => {
  const gate = deferred();
  let sent = false;
  const session = createPhoneSession({
    prim,
    pairId: 'p_12345678',
    vault: { updatePair: () => gate.promise },
    send: async () => {
      sent = true;
    },
    onMessage: () => {},
  });
  const pending = session.send({});
  await Promise.resolve();
  session.close();
  gate.resolve({});
  await assert.rejects(pending, /closed/);
  assert.equal(sent, false);
});

test('a message waits only for its own ratchet save, not for the relay to acknowledge the one before; frames leave in order', async () => {
  const chain = prim.randomBytes(32),
    crypto = createCrypto(prim);
  let pair: any = { tx: { ctr: 0, chain: toHex(chain) }, rx: { ctr: 0, chain: toHex(chain) } };
  const handed: number[] = [];
  const acks: ReturnType<typeof deferred>[] = [];
  const received: any[] = [];
  const session = createPhoneSession({
    prim,
    pairId: 'p_12345678',
    vault: {
      async updatePair(_id: string, fn: any) {
        const result = fn(structuredClone(pair));
        pair = result.pair;
        return result.value;
      },
    },
    send: (frame: any) => {
      handed.push(frame.ctr);
      const ack = deferred();
      acks.push(ack);
      return ack.promise as Promise<void>;
    },
    onMessage: (message: any) => received.push(message),
  });
  const first = session.send({ id: '1', t: 1, kind: 'event' });
  const second = session.send({ id: '2', t: 2, kind: 'event' });
  const third = session.send({ id: '3', t: 3, kind: 'event' });
  const wire = toWire(
    crypto.createSender({ pair: 'p_12345678', dir: 'm2p', chain }).seal(utf8(JSON.stringify({ id: 'r', t: 4, kind: 'event' }))),
  );
  const reply = session.receive(wire);
  await reply;
  assert.deepEqual(handed, [1, 2, 3], 'all three were handed to the relay before any was acknowledged, in order');
  assert.equal(received.length, 1, 'a reply is read while the sends are still unacknowledged');
  acks[1].reject(new Error('relay: mailbox_full'));
  await assert.rejects(second, /mailbox_full/);
  acks[0].resolve(undefined);
  acks[2].resolve(undefined);
  await first;
  await third;
  session.close();
});

test('an authentic but malformed message is dropped, the ratchet moves on, and the next message still arrives', async () => {
  const chain = prim.randomBytes(32),
    crypto = createCrypto(prim);
  let pair: any = { tx: { ctr: 0, chain: toHex(chain) }, rx: { ctr: 0, chain: toHex(chain) } };
  const received: any[] = [],
    malformed: any[] = [],
    settled: string[] = [];
  const session = createPhoneSession({
    prim,
    pairId: 'p_12345678',
    vault: {
      async updatePair(_id: string, fn: any) {
        const result = fn(structuredClone(pair));
        pair = result.pair;
        return result.value;
      },
    },
    send: async () => undefined,
    acker: { enabled: () => true, settle: (_f: any, outcome: string) => (settled.push(outcome), true) },
    onMessage: (m: any) => received.push(m),
    onMalformed: (info: any) => malformed.push(info),
  });
  const sender = crypto.createSender({ pair: 'p_12345678', dir: 'm2p', chain });
  const seal = (body: string) => toWire(sender.seal(utf8(body)));
  await session.receive(seal(JSON.stringify({ id: 'x'.repeat(65), t: 1, kind: 'event' })));
  await session.receive(seal(JSON.stringify({ id: 7, t: 1, kind: 'reply', inReplyTo: 'r1' })));
  await session.receive(seal('not json'));
  await session.receive(seal(JSON.stringify({ id: '4', t: 4, kind: 'event' })));
  assert.deepEqual(
    malformed.map((m) => m.inReplyTo),
    [null, 'r1', null],
  );
  assert.deepEqual(received, [{ id: '4', t: 4, kind: 'event' }]);
  assert.deepEqual(settled, ['dropped', 'dropped', 'dropped', 'accepted']);
  assert.equal(pair.rx.ctr, 4);
  // without a handler or after close nothing throws
  session.close();
  const quiet = createPhoneSession({
    prim,
    pairId: 'p_12345678',
    vault: { updatePair: async (_i: string, fn: any) => fn(structuredClone(pair)).value },
    send: async () => undefined,
    onMessage: () => undefined,
  });
  await quiet.receive(seal(JSON.stringify({ t: 1 })));
});
