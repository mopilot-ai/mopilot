// The controlling Mac's third message in two steps (R2b of #5576, shared/host/codePair.mjs): `verify(m2)` checks the other Mac's tag and makes the keys, revealing nothing; `seal(carry)` then makes m3 with what the caller made in between (the relay credential). `second(m2, carry)` is both steps in one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createInitiator, createResponder, createRunBudget } from '../shared/host/codePair.mjs';

const c = createCrypto(createNodePrimitives());
const deviceOf = (name: string) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { pub, name, sign: (m: Uint8Array) => new Uint8Array(crypto.sign(null, Buffer.from(m), privateKey)) };
};
const OFFER = { hint: 'ABC', rendezvousId: 'r_AAAAAAAAAAAAAAAAAAAAAA', claims: 1 };
const pair = (typed = 'DEFGH') => ({
  a: createInitiator({ crypto: c, secret: typed, ...OFFER, device: deviceOf('A'), budget: createRunBudget() }),
  b: createResponder({ crypto: c, secret: 'DEFGH', ...OFFER, device: deviceOf('B'), budget: createRunBudget() }),
});

test('verify then seal carries the caller’s object to the other Mac, and the safety words are known between the two', () => {
  const { a, b } = pair();
  const m2 = b.receive(a.first());
  assert.equal(a.safety, null);
  a.verify(m2);
  assert.ok(a.safety);
  const got = b.receive3(a.seal({ hostId: 'h_x' }));
  assert.deepEqual(got.carry, { hostId: 'h_x' });
  assert.equal(got.safety, a.safety);
  assert.equal(a.finish(b.answer(true).message).denied, false);
});

test('second() is the two steps in one', () => {
  const { a, b } = pair();
  assert.deepEqual(b.receive3(a.second(b.receive(a.first()), { x: 1 })).carry, { x: 1 });
});

test('a seal before a verify, a verify twice, a seal twice and a verify of a wrong code each end the run', () => {
  const early = pair();
  early.a.first();
  assert.throws(() => early.a.seal(), /Not the turn/);
  const twice = pair();
  const m2 = twice.b.receive(twice.a.first());
  twice.a.verify(m2);
  assert.throws(() => twice.a.verify(m2), /Not the turn/);
  const sealed = pair();
  sealed.a.verify(sealed.b.receive(sealed.a.first()));
  sealed.a.seal();
  assert.throws(() => sealed.a.seal(), /Not the turn/);
  const wrong = pair('XXXXX');
  assert.throws(
    () => wrong.a.verify(wrong.b.receive(wrong.a.first())),
    (e: any) => e.code === 'bad_confirmation',
  );
  assert.throws(() => wrong.a.seal(), /Not the turn/);
});

test('a carry that is not one bounded object ends the run at the seal', () => {
  const { a, b } = pair();
  a.verify(b.receive(a.first()));
  assert.throws(
    () => a.seal({ big: 'x'.repeat(2000) }),
    (e: any) => e.code === 'bad_body',
  );
});
