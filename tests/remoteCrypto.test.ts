// Mobile Remote's cryptography (shared/remote/crypto.mjs, envelope.mjs) over the Mac's real libsodium primitives: the shared test vectors the phone reuses, the ratchet's strict counters (replay, rewind, gaps, forged frames moving nothing), header binding, frame size and base64 edges, the safety number and the pairing proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as E from '../shared/remote/envelope.mjs';
import * as C from '../shared/remote/crypto.mjs';

const require = createRequire(import.meta.url);
const { createSodiumPrimitives } = require('../electron/platform/sodiumPrimitives.cjs');
const V = JSON.parse(readFileSync(new URL('../shared/remote/vectors.json', import.meta.url), 'utf8'));

const prim = createSodiumPrimitives();
const c = C.createCrypto(prim);
const h = E.fromHex;
const nonce = (n: number) => Uint8Array.from({ length: 24 }, (_, i) => (i + n) & 255);

function ends() {
  const root = h(V.keys.root);
  const m2p = { pair: V.pair.id, dir: 'm2p' as const, chain: c.dirKey(root, 'm2p') };
  const p2m = { pair: V.pair.id, dir: 'p2m' as const, chain: c.dirKey(root, 'p2m') };
  return { mac: { tx: c.createSender(m2p), rx: c.createReceiver(p2m) }, phone: { tx: c.createSender(p2m), rx: c.createReceiver(m2p) } };
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e.code;
  }
  return null;
};

test('vectors: every derived value reproduces', () => {
  assert.equal(E.toHex(c.hkdf(h(V.hkdf.salt), h(V.hkdf.ikm), V.hkdf.info, V.hkdf.length)), V.hkdf.okm);
  const k = V.keys;
  assert.equal(E.toHex(prim.x25519Base(h(k.macSk))), k.macPk);
  assert.equal(E.toHex(prim.x25519Base(h(k.macEphSk))), k.macEphPk);
  assert.equal(E.toHex(prim.x25519Base(h(k.phoneEphSk))), k.phoneEphPk);
  const mac = c.deriveRoot(h(k.macSk), h(k.phonePk), h(k.macEphSk), h(k.phoneEphPk), k.macId, k.phoneId, V.pair.id);
  assert.equal(E.toHex(mac), k.root);
  const phone = c.deriveRoot(h(k.phoneSk), h(k.macPk), h(k.phoneEphSk), h(k.macEphPk), k.macId, k.phoneId, V.pair.id);
  assert.equal(E.toHex(phone), k.root, 'both ends reach one root');
  assert.equal(E.toHex(c.dirKey(h(k.root), 'p2m')), k.p2mChain);
  assert.equal(E.toHex(c.dirKey(h(k.root), 'm2p')), k.m2pChain);
  assert.equal(c.pairId(h(V.pair.code)), V.pair.id);
  assert.match(V.pair.id, /^p_[A-Za-z0-9_-]{8,64}$/);
  const transcript = c.pairTranscript({
    macId: k.macId,
    phoneId: k.phoneId,
    pairId: V.pair.id,
    macPub: h(k.macPk),
    phonePub: h(k.phonePk),
    macEdPub: h(k.macEdPk),
    phoneEdPub: h(k.phoneEdPk),
    macEphPub: h(k.macEphPk),
    phoneEphPub: h(k.phoneEphPk),
  });
  assert.equal(E.toHex(transcript), V.pair.transcript);
  assert.equal(c.safetyNumber(transcript), V.pair.safetyNumber);
  assert.equal(E.toHex(c.pairProof(h(V.pair.code), h(k.macPk), h(k.phonePk))), V.pair.proof);
  assert.match(V.pair.safetyNumber, /^\d{20}$/);
});

test('vectors: frames seal to the same bytes and open on the other end', () => {
  for (const dir of ['m2p', 'p2m'] as const) {
    const root = h(V.keys.root);
    const tx = c.createSender({ pair: V.pair.id, dir, chain: c.dirKey(root, dir) });
    const rx = c.createReceiver({ pair: V.pair.id, dir, chain: c.dirKey(root, dir) });
    V[dir].frames.forEach((v: any, i: number) => {
      const f = tx.seal(E.utf8(v.plain), nonce(i));
      assert.deepEqual(JSON.parse(E.encodeFrame(f)), v.frame);
      assert.equal(E.fromUtf8(rx.open(E.decodeFrame(v.frame))), v.plain);
    });
  }
});

test('vectors: the hello and its answer are frames of counter 0 under the hello key', () => {
  const k = c.helloKey(h(V.keys.macSk), h(V.keys.phonePk), h(V.pair.code));
  assert.equal(E.toHex(k), V.hello.key);
  const hello = E.decodeFrame(V.hello.frame);
  assert.deepEqual([hello.dir, hello.ctr], ['p2m', 0]);
  assert.deepEqual(c.helloPub(hello), h(V.keys.phonePk));
  assert.equal(E.fromUtf8(c.openHelloFrame(k, hello)!), V.hello.request);
  assert.equal(c.openHelloFrame(k, { ...hello, pair: 'p_otherpair1' }), null, 'bound to its pair');
  const reply = E.decodeFrame(V.hello.replyFrame);
  assert.deepEqual([reply.dir, reply.ctr], ['m2p', 0]);
  assert.equal(E.fromUtf8(c.openReplyFrame(k, reply)!), V.hello.reply);
  assert.equal(c.openReplyFrame(k, { ...reply, pair: 'p_otherpair1' }), null);
  assert.equal(c.openHelloFrame(k, reply), null, 'an answer is not a request');
  assert.deepEqual(E.decodeFrame(E.encodeFrame(c.helloFrame(V.pair.id, k, h(V.keys.phonePk), E.utf8('x'), nonce(50)))).nonce, nonce(50));
  assert.equal(c.helloFrame(V.pair.id, k, h(V.keys.phonePk), E.utf8('x')).nonce.length, C.NONCE_BYTES);
  assert.equal(c.replyFrame(V.pair.id, k, E.utf8('x')).nonce.length, C.NONCE_BYTES);
  assert.equal(c.helloPub({ box: new Uint8Array(32) }), null, 'a box with no ciphertext holds no hello');
});

test('ratchet: a counter that repeats or goes back is refused and moves nothing', () => {
  const { mac, phone } = ends();
  const f1 = mac.tx.seal(E.utf8('one'));
  const f2 = mac.tx.seal(E.utf8('two'));
  assert.equal(E.fromUtf8(phone.rx.open(f2)), 'two', 'a lost first frame is skipped');
  assert.equal(
    code(() => phone.rx.open(f2)),
    'replay',
  );
  assert.equal(
    code(() => phone.rx.open(f1)),
    'rewind',
  );
  assert.equal(phone.rx.state().ctr, 2);
  assert.equal(E.fromUtf8(phone.rx.open(mac.tx.seal(E.utf8('three')))), 'three');
});

test('ratchet: a forged or altered frame fails and the receiver stays in step', () => {
  const { mac, phone } = ends();
  const f1 = mac.tx.seal(E.utf8('one'));
  const forged = { ...f1, ctr: 50, box: f1.box };
  assert.equal(
    code(() => phone.rx.open(forged)),
    'auth',
  );
  const flipped = { ...f1, box: Uint8Array.from(f1.box, (b, i) => (i === 0 ? b ^ 1 : b)) };
  assert.equal(
    code(() => phone.rx.open(flipped)),
    'auth',
  );
  assert.equal(phone.rx.state().ctr, 0);
  assert.equal(E.fromUtf8(phone.rx.open(f1)), 'one');
});

test('ratchet: the header is authenticated, and a frame for another pair or direction is refused', () => {
  const { mac, phone } = ends();
  const f = mac.tx.seal(E.utf8('x'));
  assert.equal(
    code(() => phone.rx.open({ ...f, pair: 'p_elsewhere' })),
    'header',
  );
  assert.equal(
    code(() => phone.rx.open({ ...f, dir: 'p2m' })),
    'header',
  );
  const back = ends().phone.tx.seal(E.utf8('y'));
  assert.equal(
    code(() => mac.rx.open({ ...back, ctr: 9 })),
    'auth',
    'a moved counter fails the tag',
  );
});

test('ratchet: more than MAX_SKIP missing frames closes the session', () => {
  const { mac, phone } = ends();
  const first = mac.tx.seal(E.utf8('a'));
  const far = { ...first, ctr: C.MAX_SKIP + 1 };
  assert.equal(
    code(() => phone.rx.open(far)),
    'gap',
  );
  const edge = { ...first, ctr: C.MAX_SKIP };
  assert.equal(
    code(() => phone.rx.open(edge)),
    'auth',
    'the edge is walked, then fails its tag',
  );
});

test('ratchet: peek gives a checkpoint a restarted sender resumes from without reusing a counter', () => {
  const { mac, phone } = ends();
  const check = mac.tx.peek(3);
  assert.equal(check.ctr, 3);
  const resumed = c.createSender({ pair: V.pair.id, dir: 'm2p', chain: check.chain, ctr: check.ctr });
  const f = resumed.seal(E.utf8('after the crash'));
  assert.equal(f.ctr, 4);
  assert.equal(E.fromUtf8(phone.rx.open(f)), 'after the crash');
  assert.deepEqual(resumed.state().ctr, 4);
});

test('sealing: a nonce is made when none is given, and every frame differs', () => {
  const { mac } = ends();
  const a = mac.tx.seal(E.utf8('same'));
  const b = mac.tx.seal(E.utf8('same'));
  assert.notDeepEqual(a.nonce, b.nonce);
  assert.equal(a.nonce.length, C.NONCE_BYTES);
});

test('primitives: the sodium adapter signs, verifies, refuses short boxes and bad keys', () => {
  const kp = prim.edKeypair();
  const sig = prim.edSign(kp.sk, E.utf8('m'));
  assert.equal(prim.edVerify(kp.pk, E.utf8('m'), sig), true);
  assert.equal(prim.edVerify(kp.pk, E.utf8('n'), sig), false);
  assert.equal(prim.aeadOpen(new Uint8Array(32), nonce(0), new Uint8Array(3), new Uint8Array(0)), null);
  assert.equal(prim.randomBytes(7).length, 7);
});

test('sameBytes: equal and unequal contents, and lengths', () => {
  assert.equal(C.sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2)), true);
  assert.equal(C.sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3)), false);
  assert.equal(C.sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1)), false);
  assert.equal(C.sameBytes(Uint8Array.of(1), Uint8Array.of(1, 2)), false);
});

test('envelope: base64 round trips every length and refuses what is not base64', () => {
  for (let n = 0; n < 7; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => 250 - i * 37);
    assert.deepEqual(E.fromBase64(E.toBase64(bytes)), bytes);
  }
  assert.equal(E.toBase64(E.utf8('Man')), 'TWFu');
  for (const bad of ['TWF', 'T===', '@@@@', 5 as any])
    assert.equal(
      code(() => E.fromBase64(bad)),
      'base64',
    );
});

test('envelope: hex round trips and refuses odd or non-hex text', () => {
  assert.equal(E.toHex(E.fromHex('00ff10')), '00ff10');
  assert.deepEqual(E.fromHex(''), new Uint8Array(0));
  for (const bad of ['abc', 'zz', 7 as any])
    assert.equal(
      code(() => E.fromHex(bad)),
      'hex',
    );
});

test('envelope: frames are checked field by field', () => {
  const ok = { pair: 'p_abcdefgh', dir: 'p2m', ctr: 1, nonce: 'AA==', box: 'AA==' };
  assert.equal(E.checkFrame(ok).ctr, 1);
  const bad = (patch: object) => code(() => E.checkFrame({ ...ok, ...patch }));
  assert.equal(
    code(() => E.checkFrame(null)),
    'frame',
  );
  assert.equal(bad({ pair: 'x' }), 'frame');
  assert.equal(bad({ pair: 'p_abc' }), 'frame');
  assert.equal(bad({ pair: 7 }), 'frame');
  assert.equal(bad({ dir: 'up' }), 'frame');
  assert.equal(bad({ ctr: -1 }), 'frame');
  assert.equal(bad({ ctr: 1.5 }), 'frame');
  assert.equal(bad({ nonce: 5 }), 'frame');
  assert.equal(bad({ box: 5 }), 'frame');
  assert.equal(bad({ box: 'A'.repeat(E.MAX_FRAME_BYTES * 2) }), 'size');
});

test('envelope: a frame over 256 KB is not encoded or decoded', () => {
  const big = { pair: 'p_abcdefgh', dir: 'p2m', ctr: 1, nonce: new Uint8Array(24), box: new Uint8Array(E.MAX_FRAME_BYTES + 1) };
  assert.equal(
    code(() => E.encodeFrame(big)),
    'size',
  );
  assert.equal(
    code(() => E.decodeFrame('x'.repeat(E.MAX_FRAME_BYTES * 2 + 1))),
    'size',
  );
  assert.equal(
    code(() => E.decodeFrame('{nope')),
    'frame',
  );
  const small = { ...big, box: new Uint8Array(10) };
  assert.deepEqual(E.decodeFrame(E.encodeFrame(small)), small);
  assert.deepEqual(E.decodeFrame({ pair: 'p_abcdefgh', dir: 'm2p', ctr: 2, nonce: 'AA==', box: 'AA==' }).box, Uint8Array.of(0));
});

test('envelope: sealed messages keep the shared fields', () => {
  const base = { id: 'm_1', t: 1, kind: 'event' };
  assert.equal(E.decodeMessage(E.encodeMessage(base)).id, 'm_1');
  const bad = (m: unknown) => code(() => E.checkMessage(m));
  assert.equal(bad(null), 'message');
  assert.equal(bad([]), 'message');
  assert.equal(bad({ ...base, id: '' }), 'message');
  assert.equal(bad({ ...base, t: 'x' }), 'message');
  assert.equal(bad({ ...base, kind: 'other' }), 'message');
  assert.equal(bad({ ...base, kind: 'request' }), 'message');
  assert.equal(bad({ ...base, kind: 'reply' }), 'message');
  assert.equal(bad({ ...base, kind: 'ack', inReplyTo: 'm_0' }), null);
  assert.equal(bad({ ...base, kind: 'request', method: 'chat.send' }), null);
  assert.equal(
    code(() => E.decodeMessage(E.utf8('{no'))),
    'message',
  );
  assert.throws(() => E.decodeMessage(Uint8Array.of(0xff)));
});

test('a root is refused when a primitive hands back an all-zero shared secret, whatever the primitive does about it', () => {
  const lax = C.createCrypto({ ...prim, x25519: () => new Uint8Array(32) });
  const k = V.keys;
  assert.equal(
    code(() => lax.deriveRoot(h(k.macSk), h(k.phonePk), h(k.macEphSk), h(k.phoneEphPk), k.macId, k.phoneId, V.pair.id)),
    'auth',
  );
  let calls = 0;
  const half = C.createCrypto({
    ...prim,
    x25519: (sk: Uint8Array, pk: Uint8Array) => (++calls === 2 ? new Uint8Array(32) : prim.x25519(sk, pk)),
  });
  assert.equal(
    code(() => half.deriveRoot(h(k.macSk), h(k.phonePk), h(k.macEphSk), h(k.phoneEphPk), k.macId, k.phoneId, V.pair.id)),
    'auth',
    'a zero in the ephemeral half alone is refused too',
  );
});

test('ratchet: a receiver told to walk further opens a frame past MAX_SKIP, and only if its tag opens', () => {
  const { mac, phone } = ends();
  const first = mac.tx.seal(E.utf8('a'));
  const far = { ...first, ctr: C.MAX_SKIP + 10 };
  assert.equal(
    code(() => phone.rx.open(far, { maxSkip: C.MAX_SKIP + 10 })),
    'auth',
    'walked, then failed its tag: a counter moved by hand opens nothing',
  );
  assert.equal(phone.rx.state().ctr, 0, 'a frame that does not open moves nothing');
  assert.equal(
    code(() => phone.rx.open(far, { maxSkip: C.MAX_SKIP + 9 })),
    'gap',
    'past the bound it was given',
  );
});
