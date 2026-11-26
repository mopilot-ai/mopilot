// Phone adapter contract against real noble and a Node libsodium stand-in, with production remote vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { createPhonePrimitives } from '../shared/remote/phonePrimitives.mjs';
import { createCrypto } from '../shared/remote/crypto.mjs';
import * as E from '../shared/remote/envelope.mjs';

const require = createRequire(import.meta.url);
const native = require('../electron/platform/sodiumPrimitives.cjs').createSodiumPrimitives();
const authError = '[react-native-libsodium][crypto_aead_xchacha20poly1305_ietf_decrypt] crypto_aead_xchacha20poly1305_ietf_decrypt failed';
// Stand-in has the 1.7.0 JS API and delegates crypto to the desktop's native sodium implementation.
const sodium = {
  randombytes_buf: native.randomBytes,
  crypto_sign_keypair: () => {
    const p = native.edKeypair();
    return { publicKey: p.pk, privateKey: p.sk };
  },
  crypto_sign_detached: (msg: Uint8Array, sk: Uint8Array) => native.edSign(sk, msg),
  crypto_sign_verify_detached: (sig: Uint8Array, msg: Uint8Array, pk: Uint8Array) => native.edVerify(pk, msg, sig),
  crypto_aead_xchacha20poly1305_ietf_encrypt: (plain: Uint8Array, aad: string, _n: null, nonce: Uint8Array, key: Uint8Array) =>
    native.aeadSeal(key, nonce, plain, E.utf8(aad)),
  crypto_aead_xchacha20poly1305_ietf_decrypt: (_n: null, box: Uint8Array, aad: string, nonce: Uint8Array, key: Uint8Array) => {
    const value = native.aeadOpen(key, nonce, box, E.utf8(aad));
    if (value === null) throw new Error(authError);
    return value;
  },
};
const p = createPhonePrimitives(sodium, { x25519, sha256, hmac });
const c = createCrypto(p);
const V = JSON.parse(readFileSync(new URL('../shared/remote/vectors.json', import.meta.url), 'utf8'));

test('production vectors reproduce with noble and the native stand-in', () => {
  const k = V.keys;
  assert.equal(E.toHex(p.x25519Base(E.fromHex(k.phoneSk))), k.phonePk);
  assert.equal(
    E.toHex(
      c.deriveRoot(E.fromHex(k.phoneSk), E.fromHex(k.macPk), E.fromHex(k.phoneEphSk), E.fromHex(k.macEphPk), k.macId, k.phoneId, V.pair.id),
    ),
    k.root,
  );
  assert.equal(E.toHex(c.hkdf(E.fromHex(V.hkdf.salt), E.fromHex(V.hkdf.ikm), V.hkdf.info, V.hkdf.length)), V.hkdf.okm);
  assert.equal(c.pairId(E.fromHex(V.pair.code)), V.pair.id);
  const transcript = c.pairTranscript({
    macId: k.macId,
    phoneId: k.phoneId,
    pairId: V.pair.id,
    macPub: E.fromHex(k.macPk),
    phonePub: E.fromHex(k.phonePk),
    macEdPub: E.fromHex(k.macEdPk),
    phoneEdPub: E.fromHex(k.phoneEdPk),
    macEphPub: E.fromHex(k.macEphPk),
    phoneEphPub: E.fromHex(k.phoneEphPk),
  });
  assert.equal(E.toHex(transcript), V.pair.transcript, 'the phone hashes the same transcript the Mac does');
  assert.equal(c.safetyNumber(transcript), V.pair.safetyNumber, 'and shows the same number');
  assert.equal(E.toHex(c.pairProof(E.fromHex(V.pair.code), E.fromHex(k.macPk), E.fromHex(k.phonePk))), V.pair.proof);
  for (const dir of ['m2p', 'p2m'] as const) {
    const chain = c.dirKey(E.fromHex(k.root), dir);
    const sender = c.createSender({ pair: V.pair.id, dir, chain });
    const receiver = c.createReceiver({ pair: V.pair.id, dir, chain });
    V[dir].frames.forEach((v: any, i: number) => {
      const nonce = Uint8Array.from({ length: 24 }, (_, j) => (i + j) & 255);
      assert.deepEqual(JSON.parse(E.encodeFrame(sender.seal(E.utf8(v.plain), nonce))), v.frame);
      assert.equal(E.fromUtf8(receiver.open(E.decodeFrame(v.frame))), v.plain);
    });
  }
  const key = c.helloKey(E.fromHex(k.phoneSk), E.fromHex(k.macPk), E.fromHex(V.pair.code));
  assert.equal(E.toHex(key), V.hello.key);
  assert.equal(E.fromUtf8(c.openHelloFrame(key, E.decodeFrame(V.hello.frame))!), V.hello.request);
  assert.equal(E.fromUtf8(c.openReplyFrame(key, E.decodeFrame(V.hello.replyFrame))!), V.hello.reply);
});

test('signing, randomness and authenticated failures respect the adapter contract', () => {
  assert.equal(p.randomBytes(24).length, 24);
  const pair = p.edKeypair();
  const msg = E.utf8('hello');
  const signature = p.edSign(pair.sk, msg);
  assert.equal(p.edVerify(pair.pk, msg, signature), true);
  assert.equal(p.edVerify(pair.pk, E.utf8('changed'), signature), false);
  const key = new Uint8Array(32),
    nonce = new Uint8Array(24),
    aad = E.utf8('header');
  const box = p.aeadSeal(key, nonce, msg, aad);
  assert.deepEqual(p.aeadOpen(key, nonce, box, aad), msg);
  assert.equal(p.aeadOpen(key, nonce, box, E.utf8('changed')), null);
  assert.equal(p.aeadOpen(key, nonce, new Uint8Array(15), aad), null);
  assert.throws(() => p.aeadSeal(key, nonce, msg, Uint8Array.of(255)));
  assert.throws(() => p.aeadOpen(key, nonce, box, Uint8Array.of(255)));
  const broken = createPhonePrimitives(
    {
      ...sodium,
      crypto_aead_xchacha20poly1305_ietf_decrypt: () => {
        throw new Error('binding unavailable');
      },
    },
    { x25519, sha256, hmac },
  );
  assert.throws(() => broken.aeadOpen(key, nonce, box, aad), /binding unavailable/);
  const nonError = createPhonePrimitives(
    {
      ...sodium,
      crypto_aead_xchacha20poly1305_ietf_decrypt: () => {
        throw 'unexpected';
      },
    },
    { x25519, sha256, hmac },
  );
  assert.throws(
    () => nonError.aeadOpen(key, nonce, box, aad),
    (e) => e === 'unexpected',
  );
});

test('malformed native inputs never reach unsafe binding calls', () => {
  let calls = 0;
  const spy = createPhonePrimitives(
    {
      ...sodium,
      randombytes_buf: () => {
        calls++;
        return new Uint8Array();
      },
      crypto_sign_detached: () => {
        calls++;
        return new Uint8Array();
      },
      crypto_sign_verify_detached: () => {
        calls++;
        return true;
      },
      crypto_aead_xchacha20poly1305_ietf_decrypt: () => {
        calls++;
        return new Uint8Array();
      },
    },
    { x25519, sha256, hmac },
  );
  for (const n of [-1, 0.5, Infinity, 0x80000000]) assert.throws(() => spy.randomBytes(n), RangeError);
  for (const n of [0, 63, 65]) assert.throws(() => spy.edSign(new Uint8Array(n), new Uint8Array()), RangeError);
  for (const n of [0, 31, 33]) assert.equal(spy.edVerify(new Uint8Array(n), new Uint8Array(), new Uint8Array(64)), false);
  for (const n of [0, 63, 65]) assert.equal(spy.edVerify(new Uint8Array(32), new Uint8Array(), new Uint8Array(n)), false);
  assert.equal(spy.aeadOpen(new Uint8Array(32), new Uint8Array(24), new Uint8Array(15), new Uint8Array()), null);
  assert.equal(calls, 0);
});
