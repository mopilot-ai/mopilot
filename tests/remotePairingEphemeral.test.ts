// Pairing mixes an ephemeral exchange into the root key (Mac: electron/remote/pairing.cjs, phone: shared/remote/phonePairing.mjs): pairing the same two devices again gives a new root, a recorded ciphertext does not open with the long-term identity keys alone, and a tampered hello or answer is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../shared/remote/envelope.mjs';
import { prim } from './support/remoteKit.ts';
import { crypto, helloFor, makePhone, openReply, phoneEnds } from './support/remotePhone.ts';
import { rig } from './support/remotePairingRig.ts';
import { setup } from './support/phonePairingFixture.ts';

const sealedByMac = (dev: any, plain: string) =>
  crypto.createSender({ pair: dev.pairId, dir: 'm2p', chain: E.fromHex(dev.tx.chain) }).seal(E.utf8(plain));

test('pairing the same two devices again gives different chains: a new pair id and fresh ephemerals go into the root', async () => {
  const r = rig();
  const phone = makePhone();
  const first = (await r.svc.begin()).payload;
  assert.equal(await r.svc.handleHello(helloFor(phone, first)), 'paired');
  const before = r.devices.get(phone.id);
  const firstReply = openReply(phone, first, r.state.replies[0]);
  assert.equal(await r.svc.unpair(phone.id, before.pairId), true);

  // same identity keys, same phone object (so the same ephemeral too): only the Mac's ephemeral and the pair id are new
  const second = (await r.svc.begin()).payload;
  assert.equal(await r.svc.handleHello(helloFor(phone, second)), 'paired');
  const after = r.devices.get(phone.id);
  const secondReply = openReply(phone, second, r.state.replies[1]);
  assert.notEqual(after.pairId, before.pairId);
  assert.notEqual(second.macEphPub, first.macEphPub, 'the Mac makes a new ephemeral every time');
  assert.notEqual(after.tx.chain, before.tx.chain);
  assert.notEqual(after.rx.chain, before.rx.chain);

  const ends1 = phoneEnds(phone, first, firstReply);
  const ends2 = phoneEnds(phone, second, secondReply);
  assert.notDeepEqual(ends1.rx.state().chain, ends2.rx.state().chain);
});

test('a recorded ciphertext does not open with both long-term identity keys, nor with the old static-only root', async () => {
  const r = rig();
  const phone = makePhone();
  const { payload } = await r.svc.begin();
  assert.equal(await r.svc.handleHello(helloFor(phone, payload)), 'paired');
  const dev = r.devices.get(phone.id);
  const id = await r.identity.get();
  const reply = openReply(phone, payload, r.state.replies[0]);
  const recorded = sealedByMac(dev, 'the secret plan');

  // an attacker who later learns the Mac's and the phone's identity secret keys: the pair id and the ids are public
  const staticOnly = [
    // the root as it was derived before the ephemeral exchange
    crypto.hkdf(E.utf8('mopilot-remote-v1'), prim.x25519(id.x.sk, phone.pk), `root|${id.macId}|${phone.id}`),
    // the new formula without the ephemeral half (two static halves)
    crypto.hkdf(
      E.utf8('mopilot-remote-v1'),
      new Uint8Array([...prim.x25519(id.x.sk, phone.pk), ...prim.x25519(phone.sk, id.x.pk)]),
      `root|2|${id.macId}|${phone.id}|${dev.pairId}`,
    ),
  ];
  for (const root of staticOnly) {
    const rx = crypto.createReceiver({ pair: dev.pairId, dir: 'm2p', chain: crypto.dirKey(root, 'm2p') });
    assert.throws(() => rx.open(recorded), { code: 'auth' });
  }
  // the phone, which still held its ephemeral until the answer, does open it
  const ends = phoneEnds(phone, payload, reply);
  assert.equal(E.fromUtf8(ends.rx.open(recorded)), 'the secret plan');
});

test('a tampered hello is refused: a flipped byte is noise, a missing, short, old-version or low-order key is rejected', async () => {
  const r = rig();
  const phone = makePhone();
  const { payload } = await r.svc.begin();
  const good = helloFor(phone, payload);
  const flipped = { ...good, box: good.box.map((b: number, i: number) => (i === 40 ? b ^ 1 : b)) };
  assert.equal(await r.svc.handleHello(flipped), 'ignored', 'does not open: the pairing stays open');
  for (const request of [
    { ephPub: undefined },
    { ephPub: 'AA==' },
    { ephPub: E.toBase64(new Uint8Array(33)) },
    { ephPub: 5 },
    { v: 1 },
    { v: 2 },
    { v: undefined },
  ]) {
    const r2 = rig();
    const p2 = (await r2.svc.begin()).payload;
    assert.equal(await r2.svc.handleHello(helloFor(makePhone(), p2, { request })), 'rejected', JSON.stringify(request));
    assert.equal(r2.devices.list().length, 0);
    assert.equal(r2.state.confirms.length, 0, 'the user is never asked');
  }
  // a low-order point makes the shared secret zero: refused, nothing stored
  const r3 = rig();
  const p3 = (await r3.svc.begin()).payload;
  const zero = makePhone();
  assert.equal(await r3.svc.handleHello(helloFor(zero, p3, { request: { ephPub: E.toBase64(new Uint8Array(32)) } })), 'rejected');
  assert.equal(r3.devices.list().length, 0);
  assert.equal(openReply(zero, p3, r3.state.replies.at(-1)).ok, false);
  // the untouched hello still pairs on the first rig
  assert.equal(await r.svc.handleHello(good), 'paired');
});

function answerWith(s: ReturnType<typeof setup>, payload: any, edit: (body: any) => void) {
  const key = crypto.helloKey(s.identity.x.sk, E.fromBase64(payload.macPub), E.fromBase64(payload.code));
  const body = JSON.parse(E.fromUtf8(crypto.openReplyFrame(key, E.decodeFrame(s.answer))!));
  edit(body);
  return E.toWire(crypto.replyFrame(crypto.pairId(E.fromBase64(payload.code)), key, E.utf8(JSON.stringify(body))));
}

test('a tampered answer is refused by the phone: a flipped byte, another version', async () => {
  for (const edit of [(b: any) => void (b.v = 1), (b: any) => void (b.v = 2), (b: any) => void delete b.v]) {
    const s = setup();
    const { payload } = await s.desktop.begin();
    await s.phone.begin(JSON.stringify(payload), 'Test phone');
    assert.equal(await s.desktop.handleHello(E.decodeFrame(s.hello)), 'paired');
    await assert.rejects(s.phone.finish(answerWith(s, payload, edit)), /invalid pairing data|low order|invalid private or public key/);
    assert.equal(s.saved, undefined, 'nothing was stored');
  }
  const s = setup();
  const { payload } = await s.desktop.begin();
  await s.phone.begin(JSON.stringify(payload), 'Test phone');
  assert.equal(await s.desktop.handleHello(E.decodeFrame(s.hello)), 'paired');
  const wire = E.decodeFrame(s.answer);
  const flipped = { ...wire, box: wire.box.map((b: number, i: number) => (i === 3 ? b ^ 1 : b)) };
  await assert.rejects(s.phone.finish(E.toWire(flipped as any)), /invalid pairing reply/);
  assert.deepEqual(await s.phone.finish(s.answer), { pairId: crypto.pairId(E.fromBase64(payload.code)), macId: s.mac.macId });
});
