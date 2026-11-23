// Phone pairing protocol validation against the real desktop service and controlled boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhonePairing } from '../shared/remote/phonePairing.mjs';
import { decodeFrame, toBase64, toWire, utf8 } from '../shared/remote/envelope.mjs';
import { prim, c, deferred, setup } from './support/phonePairingFixture.ts';

test('phone hello and durable pair interoperate with the actual desktop service', async () => {
  const s = setup();
  const { qr } = await s.desktop.begin();
  assert.equal(s.phone.status(), 'idle');
  const pending = await s.phone.begin(qr, 'Test phone');
  assert.equal(s.phone.status(), 'waiting');
  assert.equal(await s.desktop.handleHello(decodeFrame(s.hello)), 'paired');
  assert.equal(pending.safetyNumber, s.observed);
  assert.deepEqual(await s.phone.finish(s.answer), { pairId: pending.pairId, macId: s.mac.macId });
  assert.equal(s.saved.pairId, pending.pairId);
  // the two ends reached one root through the ephemeral exchange: each one's send chain is the other's receive chain
  const device = s.devices.get(s.identity.phoneId);
  assert.equal(s.saved.tx.chain, device.rx.chain);
  assert.equal(s.saved.rx.chain, device.tx.chain);
  assert.equal(await s.desktop.handleHello(decodeFrame(s.hello)), 'ignored');
  await assert.rejects(s.phone.finish(s.answer), /no pending/);
});

test('a code that also carries the account hint and a name is read as one without: the extra keys are ignored, so an older phone pairs with a newer computer', async () => {
  const s = setup();
  const { payload } = await s.desktop.begin();
  const begun = await s.phone.begin({ ...payload, acct: '0123456789abcdef', who: 'j***@x.com', name: 'Studio', app: '9.9.9' }, 'Phone');
  assert.match(begun.safetyNumber, /^\d+$/);
});

test('QR, identity, and transport failures cannot report success', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin();
  for (const bad of [
    'not json',
    'x'.repeat(4097),
    null,
    [],
    { ...payload, v: 1 },
    { ...payload, macId: '!' },
    { ...payload, exp: 100 },
    { ...payload, relay: 'ws://relay.example' },
    { ...payload, relay: 'wss://user@relay.example' },
    { ...payload, relay: 'wss://relay.example/#x' },
    { ...payload, code: 'bad' },
    { ...payload, macPub: toBase64(new Uint8Array(31)) },
  ])
    await assert.rejects(s.phone.begin(bad, 'phone'));
  const brokenIdentity = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: { ...s.store, getIdentity: async () => ({ ...s.identity, x: { ...s.identity.x, pk: new Uint8Array(32) } }) },
    transport: s.transport,
    now: () => 100,
  });
  await assert.rejects(brokenIdentity.begin(payload, 'phone'), /invalid identity/);
  const brokenJoin = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: s.store,
    transport: {
      ...s.transport,
      join: async () => {
        throw new Error('offline');
      },
    },
    now: () => 100,
  });
  await assert.rejects(brokenJoin.begin(payload, 'phone'), /offline/);
  const brokenSend = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: setup().store,
    transport: {
      ...s.transport,
      send: async () => {
        throw new Error('send failed');
      },
    },
    now: () => 100,
  });
  await assert.rejects(brokenSend.begin(payload, 'phone'), /send failed/);
  assert.equal(s.phone.cancel(), false);
});

test('bad replies and secure-store failures cannot become paired', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin();
  const phone = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: {
      ...s.store,
      savePair: async () => {
        throw new Error('secure store unavailable');
      },
    },
    transport: s.transport,
    now: () => 100,
  });
  await phone.begin(payload, 'phone');
  assert.equal(await s.desktop.handleHello(decodeFrame(s.hello)), 'paired');
  await assert.rejects(phone.finish({ ...s.answer, pair: 'p_wrongpair1' }), /invalid pairing reply/);
  const tampered = { ...s.answer, box: toBase64(new Uint8Array(32)) };
  await assert.rejects(phone.finish(tampered), /invalid pairing reply/);
  await assert.rejects(phone.finish(s.answer), /secure store unavailable/);
  assert.equal(s.saved, undefined);
});

test('authenticated refusal retires pairing, and invalid QR or identity expiry is rejected', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin();
  const pending = await s.phone.begin(payload, 'phone');
  const key = c.helloKey(s.mac.x.sk, s.identity.x.pk, Buffer.from(payload.code, 'base64'));
  const refusal = toWire(c.replyFrame(pending.pairId, key, utf8(JSON.stringify({ ok: false, error: 'declined' }))));
  await assert.rejects(s.phone.finish(refusal), /rejected/);
  assert.equal(s.phone.cancel(), false);
  await assert.rejects(s.phone.begin({ ...payload, code: null }, 'phone'));
  let clock = 100;
  const expiredOnLoad = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: {
      ...s.store,
      getPending: async () => null,
      getIdentity: async () => {
        clock = payload.exp;
        return s.identity;
      },
    },
    transport: s.transport,
    now: () => clock,
  });
  await assert.rejects(expiredOnLoad.begin(payload, 'phone'), /expired QR/);
  clock = 100;
  const expiredOnJoin = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: setup().store,
    transport: {
      ...s.transport,
      join: async () => {
        clock = payload.exp;
      },
    },
    now: () => clock,
  });
  await assert.rejects(expiredOnJoin.begin(payload, 'phone'), /expired QR/);
  const defaultClock = createPhonePairing({ prim, relayUrl: 'wss://relay.example/ws', store: s.store, transport: s.transport });
  await assert.rejects(defaultClock.begin(payload, 'phone'), /expired QR/);
});

test('untrusted relay URLs never reach authenticated transport', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin();
  let joins = 0;
  const phone = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: s.store,
    transport: {
      ...s.transport,
      join: async () => {
        joins++;
      },
    },
    now: () => 100,
  });
  for (const relay of [
    'wss://attacker.example/ws',
    'wss://relay.example:444/ws',
    'wss://relay.example/other',
    'wss://relay.example/ws?x=1',
  ]) {
    await assert.rejects(phone.begin({ ...payload, relay }, 'phone'), /untrusted relay/);
  }
  assert.equal(joins, 0);
});

test('a reply arriving before send acknowledgement waits for startup and does not disappear', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin(),
    ack = deferred(),
    delivered = deferred();
  const phone = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: s.store,
    transport: {
      ...s.transport,
      send: async (frame) => {
        await s.desktop.handleHello(decodeFrame(frame));
        delivered.resolve(undefined);
        await ack.promise;
      },
    },
    now: () => 100,
  });
  const starting = phone.begin(payload, 'phone');
  await delivered.promise;
  const finishing = phone.finish(s.answer);
  ack.resolve(undefined);
  await starting;
  assert.equal((await finishing).macId, s.mac.macId);
});

test('a reply buffered before a failed send cannot publish pairing', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin(),
    ack = deferred(),
    delivered = deferred();
  const phone = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: s.store,
    transport: {
      ...s.transport,
      send: async (frame) => {
        await s.desktop.handleHello(decodeFrame(frame));
        delivered.resolve(undefined);
        await ack.promise;
      },
    },
    now: () => 100,
  });
  const starting = phone.begin(payload, 'phone');
  await delivered.promise;
  const finishing = phone.finish(s.answer);
  ack.reject(new Error('ack lost'));
  await assert.rejects(starting, /ack lost/);
  await assert.rejects(finishing, /ack lost/);
  assert.equal(s.saved, undefined);
});

test('untrusted or oversized replies cannot occupy the single waiting slot', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin(),
    ack = deferred(),
    delivered = deferred();
  const phone = createPhonePairing({
    prim,
    relayUrl: 'wss://relay.example/ws',
    store: s.store,
    transport: {
      ...s.transport,
      send: async (frame) => {
        await s.desktop.handleHello(decodeFrame(frame));
        delivered.resolve(undefined);
        await ack.promise;
      },
    },
    now: () => 100,
  });
  const starting = phone.begin(payload, 'phone');
  await delivered.promise;
  for (let i = 0; i < 50; i++)
    await assert.rejects(phone.finish({ ...s.answer, box: toBase64(new Uint8Array(32)) }), /invalid pairing reply/);
  await assert.rejects(phone.finish({ ...s.answer, box: 'A'.repeat(400000) }));
  const finishing = phone.finish(s.answer);
  await assert.rejects(phone.finish(s.answer), /reply busy/);
  ack.resolve(undefined);
  await starting;
  await finishing;
});

test('object QR fields are bounded before URL parsing and base64 decoding', async () => {
  const s = setup(),
    { payload } = await s.desktop.begin();
  for (const bad of [
    { ...payload, relay: `wss://relay.example/${'x'.repeat(3000)}` },
    { ...payload, code: 'A'.repeat(5000) },
    { ...payload, macPub: 'A'.repeat(5000) },
  ]) {
    await assert.rejects(s.phone.begin(bad, 'phone'));
  }
});

test('a code from a newer or an older Mac says which, not that it expired', async () => {
  const s = setup();
  const { payload } = await s.desktop.begin();
  await assert.rejects(s.phone.begin({ ...payload, v: 4 }, 'Phone'), /newer QR/);
  await assert.rejects(s.phone.begin({ ...payload, v: 2 }, 'Phone'), /older QR/);
  await assert.rejects(s.phone.begin({ ...payload, exp: 1 }, 'Phone'), /expired QR/);
});

test('a join the relay refuses owes no cleanup; a join that failed some other way keeps the record', async () => {
  for (const [code, left] of [
    ['relay: forbidden', null],
    ['relay: taken', null],
    ['relay connection closed', 'joining'],
  ] as const) {
    const s = setup();
    const { qr } = await s.desktop.begin();
    s.transport.join = async () => {
      throw new Error(code);
    };
    await assert.rejects(s.phone.begin(qr, 'Phone'), new RegExp(code));
    assert.equal((await s.store.getPending())?.phase ?? null, left);
  }
});
