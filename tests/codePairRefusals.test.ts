// Pairing two Macs by a code, the protocol layer (shared/host/codePair.mjs, #5576 R2a), part three: every step refuses every kind of bad message, a signer that fails ends the run, and a key exchange that gives nothing is refused on both kinds of answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A, ID, cp, createCrypto, createNodePrimitives, crypto, json, run, shape } from './support/host/codePairKit.ts';

test('every step refuses a message that is not of its shape, whatever way it is not: bad text, text that is not JSON, the wrong fields, a wrong associated data; and a signer that fails ends the run', () => {
  const notJson = cp.b64u(new TextEncoder().encode('this is not json'));
  const wrongFields = shape({ x: 1 });
  // the responder's first step and third step
  for (const bad of ['!!', notJson, wrongFields]) {
    assert.throws(
      () => run().b.receive(bad),
      (e: any) => e.code === 'bad_message',
      `first step: ${bad.slice(0, 8)}`,
    );
    const r = run();
    r.b.receive(r.a.first());
    assert.throws(
      () => r.b.receive3(bad),
      (e: any) => e.code === 'bad_message',
      `third step: ${bad.slice(0, 8)}`,
    );
    // the initiator's second step, and its last
    const s = run();
    s.b.receive(s.a.first());
    assert.throws(
      () => s.a.second(bad),
      (e: any) => e.code === 'bad_message',
      `second step: ${bad.slice(0, 8)}`,
    );
    const t = run();
    t.b.receive3(t.a.second(t.b.receive(t.a.first())));
    assert.throws(
      () => t.a.finish(bad),
      (e: any) => e.code === 'bad_body',
      `last step: ${bad.slice(0, 8)}`,
    );
  }
  // a reply with the right fields and an associated data that is not one
  const u = run();
  const reply = json(u.b.receive(u.a.first()));
  assert.throws(
    () => u.a.second(shape({ ...reply, ad: cp.b64u(new Uint8Array(10)) })),
    (e: any) => e.code === 'bad_message',
  );
  // a signer that fails (a locked key, a missing card) ends the run with a refusal of its own kind, and nothing is left to finish
  const failing = {
    ...A,
    sign: () => {
      throw new Error('the key is locked');
    },
  };
  const v = run({ a: { device: failing } });
  assert.throws(
    () => v.a.second(v.b.receive(v.a.first())),
    (e: any) => e instanceof cp.CodePairError && e.code === 'bad_message',
  );
  assert.throws(
    () => v.a.finish('x'),
    (e: any) => e.code === 'out_of_turn',
  );
  const w = run({ b: { device: failing } });
  w.b.receive3(w.a.second(w.b.receive(w.a.first())));
  assert.throws(
    () => w.b.answer(true),
    (e: any) => e.message.includes('locked') || e.code,
  );
});

test('a key exchange that gives nothing is refused whichever way the primitive set says so: an error, or an answer of zeros', () => {
  const base = createNodePrimitives();
  const rnd = (n: number, v: number) => new Uint8Array(n).fill(v);
  const eph = crypto.prim.randomBytes(32);
  const peer = crypto.prim.x25519Base(crypto.prim.randomBytes(32));
  for (const x25519 of [
    () => new Uint8Array(32),
    () => {
      throw new Error('refused');
    },
  ]) {
    const c = createCrypto({ ...base, x25519 });
    assert.throws(
      () => cp.deriveKeys(c, { isk: rnd(64, 1), transcript: rnd(8, 2) }, rnd(32, 3), rnd(32, 4), eph, peer, ID),
      (e: any) => e.code === 'bad_message',
    );
  }
});

// What the module checks itself, shown against verifiers that check nothing: removing any one of its own checks (the key, the nonce R, the scalar S) lets one of these through.
import { ed25519, ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha2';
import * as pubCpace from '../shared/host/cpace.mjs';

test('the module’s own checks of a signature hold against a verifier that accepts what a lax one accepts, and against one that accepts everything', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const L = ed25519.CURVE.n;
  const hash = crypto.prim.randomBytes(64);
  const message = pubCpace.lvCat(enc('mopilot-code-pair-v1|device-proof'), enc('initiator'), hash);
  const seed = crypto.prim.randomBytes(32);
  const pk = ed25519.getPublicKey(seed);
  const sig = ed25519.sign(message, seed);
  const le = (bytes: Uint8Array) => bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
  const toLe = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
  // verifiers: noble's ZIP-215 one (cofactored: it accepts a small-order R), and one that says yes to everything
  const lax = createCrypto({
    ...createNodePrimitives(),
    edVerify: (k: Uint8Array, m: Uint8Array, s: Uint8Array) => ed25519.verify(s, m, k, { zip215: true }),
  });
  const yes = createCrypto({ ...createNodePrimitives(), edVerify: () => true });
  const proves = (c: any, key: Uint8Array, s: Uint8Array) => cp.provedBy(c, key, 'initiator', hash, cp.b64u(s));
  assert.equal(proves(lax, pk, sig), true, 'a good signature passes both');
  // a signature of the real key whose R is a point of small order: the cofactored check accepts it, the module does not
  const T = Uint8Array.from(Buffer.from(ED25519_TORSION_SUBGROUP[3] as string, 'hex'));
  const { scalar } = ed25519.utils.getExtendedPublicKey(seed);
  const h = le(sha512(Uint8Array.from([...T, ...pk, ...message]))) % L;
  const laxSig = Uint8Array.from([...T, ...toLe((h * scalar) % L)]);
  assert.equal(ed25519.verify(laxSig, message, pk, { zip215: true }), true, 'the lax verifier takes it');
  assert.equal(proves(lax, pk, laxSig), false, 'the module does not (the nonce is of small order)');
  assert.equal(proves(yes, pk, laxSig), false, 'not even when the verifier says yes to everything');
  // the key of small order, a key that is not the canonical spelling of its point, and a nonce of small order, each alone, with a verifier that says yes
  const identityR = Uint8Array.from(Buffer.from('0100000000000000000000000000000000000000000000000000000000000000', 'hex'));
  for (const point of ED25519_TORSION_SUBGROUP)
    assert.equal(proves(yes, Uint8Array.from(Buffer.from(point, 'hex')), sig), false, `key ${point.slice(0, 8)}`);
  for (const bad of [
    'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  ])
    assert.equal(proves(yes, Uint8Array.from(Buffer.from(bad, 'hex')), sig), false, `non-canonical key ${bad.slice(0, 4)}`);
  assert.equal(proves(yes, pk, Uint8Array.from([...identityR, ...sig.slice(32)])), false, 'a nonce of small order, the rest as signed');
  // a scalar that is not below the group order, with the nonce and the key as signed
  const big = Uint8Array.from([...sig.slice(0, 32), ...toLe(le(sig.slice(32)) + L)]);
  assert.equal(proves(yes, pk, big), false, 'S plus the group order');
  assert.equal(proves(yes, pk, Uint8Array.from([...sig.slice(0, 32), ...toLe(L)])), false, 'S equal to the group order');
  // the same through the product's own primitive sets, which add their own refusals but not these
  assert.equal(proves(yes, pk, sig), true, 'and a good one is still good');
  assert.equal(proves(yes, pk.slice(0, 31), sig), false);
});
