// The Host's node:crypto primitive set (shared/remote/nodePrimitives.mjs) against libsodium and the phone's vectors: the same seal,
// the same keys, each opening what the other sealed, HChaCha20's published test vector, and the low-order and bad-input answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as E from '../shared/remote/envelope.mjs';
import * as C from '../shared/remote/crypto.mjs';
import { createNodePrimitives, hchacha20 } from '../shared/remote/nodePrimitives.mjs';

const require = createRequire(import.meta.url);
const { createSodiumPrimitives } = require('../electron/remote/sodiumPrimitives.cjs');
const V = JSON.parse(readFileSync(new URL('../shared/remote/vectors.json', import.meta.url), 'utf8'));
const node = createNodePrimitives();
const sodium = createSodiumPrimitives();
const h = E.fromHex;

test('HChaCha20 matches draft-irtf-cfrg-xchacha section 2.2.1', () => {
  const key = h('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
  const nonce = h('000000090000004a0000000031415927');
  assert.equal(E.toHex(hchacha20(key, nonce)), '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc');
});

test('the phone vectors reproduce on node:crypto: keys, root and every sealed frame', () => {
  const c = C.createCrypto(node);
  const k = V.keys;
  assert.equal(E.toHex(node.x25519Base(h(k.macSk))), k.macPk);
  assert.equal(E.toHex(c.deriveRoot(h(k.macSk), h(k.phonePk), h(k.macEphSk), h(k.phoneEphPk), k.macId, k.phoneId, V.pair.id)), k.root);
  for (const dir of ['m2p', 'p2m'] as const) {
    const tx = c.createSender({ pair: V.pair.id, dir, chain: c.dirKey(h(k.root), dir) });
    const rx = c.createReceiver({ pair: V.pair.id, dir, chain: c.dirKey(h(k.root), dir) });
    for (const v of V[dir].frames) {
      const f = tx.seal(E.utf8(v.plain), E.fromBase64(v.frame.nonce));
      assert.equal(E.toBase64(f.box), v.frame.box);
      assert.equal(E.fromUtf8(rx.open({ ...f })), v.plain);
    }
  }
});

test('node and libsodium open each other’s boxes and agree on X25519; Ed25519 signatures cross', () => {
  const key = node.randomBytes(32);
  const nonce = node.randomBytes(24);
  const aad = E.utf8('header');
  for (const size of [0, 1, 63, 64 * 1024 + 7]) {
    const plain = node.randomBytes(size);
    const a = node.aeadSeal(key, nonce, plain, aad);
    assert.deepEqual(a, sodium.aeadSeal(key, nonce, plain, aad));
    assert.deepEqual(sodium.aeadOpen(key, nonce, a, aad), plain);
    assert.deepEqual(node.aeadOpen(key, nonce, a, aad), plain);
  }
  const box = node.aeadSeal(key, nonce, E.utf8('x'), aad);
  box[0] ^= 1;
  assert.equal(node.aeadOpen(key, nonce, box, aad), null, 'a failed tag is null');
  assert.equal(node.aeadOpen(key, nonce, new Uint8Array(5), aad), null, 'shorter than a tag');
  const a = node.randomBytes(32);
  const b = node.randomBytes(32);
  assert.deepEqual(node.x25519(a, sodium.x25519Base(b)), sodium.x25519(b, node.x25519Base(a)));
  assert.deepEqual(node.x25519(a, new Uint8Array(32)), new Uint8Array(32), 'a low-order key gives zeros, as libsodium does');
  assert.equal(node.sha256(E.utf8('abc')).length, 32);
  assert.deepEqual(node.sha256(E.utf8('abc')), sodium.sha256(E.utf8('abc')));
  const kp = node.edKeypair();
  assert.equal(kp.sk.length, 64);
  const msg = E.utf8('signed');
  const sig = node.edSign(kp.sk, msg);
  assert.equal(sodium.edVerify(kp.pk, msg, sig), true);
  assert.equal(node.edVerify(kp.pk, msg, sig), true);
  const theirs = sodium.edKeypair();
  assert.equal(node.edVerify(theirs.pk, msg, sodium.edSign(theirs.sk, msg)), true);
  assert.equal(node.edVerify(theirs.pk, E.utf8('other'), sodium.edSign(theirs.sk, msg)), false);
  assert.equal(node.edVerify(new Uint8Array(3), msg, sig), false, 'a key that is not one is false');
});
