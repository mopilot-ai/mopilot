// The app's crypto runs in Electron, whose OpenSSL has no ChaCha20-Poly1305 (ERR_CRYPTO_UNKNOWN_CIPHER): the app seals with libsodium (electron/platform/sodiumPrimitives.cjs), never with Node's (shared/remote/nodePrimitives.mjs, the Host's, which runs on Node). Pairing by code failed in the running app because its wiring used Node's (#5576). Electron's own runtime is exercised by the real-app spec (tests/e2e/host-code-pair-real.spec.ts): unit tests never start Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';

const require = createRequire(import.meta.url);
const { createSodiumPrimitives } = require('../electron/platform/sodiumPrimitives.cjs');

test('the app’s and the Host’s primitives are one cipher, byte for byte: what one seals the other opens, and both refuse an altered box', () => {
  const app = createSodiumPrimitives();
  const host = createNodePrimitives();
  const key = app.randomBytes(32);
  const nonce = app.randomBytes(24);
  const aad = new TextEncoder().encode('aad');
  const plain = new TextEncoder().encode('hello');
  const fromApp = app.aeadSeal(key, nonce, plain, aad);
  const fromHost = host.aeadSeal(key, nonce, plain, aad);
  // the same key and nonce make the same bytes: one XChaCha20-Poly1305, byte for byte
  assert.deepEqual(Buffer.from(fromApp), Buffer.from(fromHost));
  assert.deepEqual(Buffer.from(host.aeadOpen(key, nonce, fromApp, aad) as Uint8Array), Buffer.from(plain));
  assert.deepEqual(Buffer.from(app.aeadOpen(key, nonce, fromHost, aad) as Uint8Array), Buffer.from(plain));
  // a box altered by one bit is refused by both
  const bad = Uint8Array.from(fromApp);
  bad[0] ^= 1;
  assert.equal(host.aeadOpen(key, nonce, bad, aad), null);
  assert.equal(app.aeadOpen(key, nonce, bad, aad), null);
});

test('the edges agree too: empty additional data, an empty message, and a box shorter than its tag', () => {
  const app = createSodiumPrimitives();
  const host = createNodePrimitives();
  const key = app.randomBytes(32);
  const nonce = app.randomBytes(24);
  const empty = new Uint8Array(0);
  const plain = new TextEncoder().encode('hello');
  for (const [aad, msg, what] of [
    [empty, plain, 'empty additional data'],
    [new TextEncoder().encode('aad'), empty, 'an empty message'],
    [empty, empty, 'both empty'],
  ] as const) {
    const fromApp = app.aeadSeal(key, nonce, msg, aad);
    assert.deepEqual(Buffer.from(fromApp), Buffer.from(host.aeadSeal(key, nonce, msg, aad)), what);
    assert.equal(fromApp.length, msg.length + 16, `${what}: the tag is the last 16 bytes`);
    assert.deepEqual(Buffer.from(host.aeadOpen(key, nonce, fromApp, aad) as Uint8Array), Buffer.from(msg), what);
    assert.deepEqual(Buffer.from(app.aeadOpen(key, nonce, fromApp, aad) as Uint8Array), Buffer.from(msg), what);
  }
  // shorter than the tag: refused, never thrown
  for (const short of [empty, new Uint8Array(15)]) {
    assert.equal(app.aeadOpen(key, nonce, short, empty), null);
    assert.equal(host.aeadOpen(key, nonce, short, empty), null);
  }
});
