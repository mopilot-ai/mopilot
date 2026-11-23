// The lease sealed for a phone (shared/remote/stampSeal.mjs): only the enrollment's pair root opens it, every malformed or foreign blob opens to nothing, and a stamp that is not one is never sealed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore
import { createStampSeal, MAX_SEALED_STAMP } from '../shared/remote/stampSeal.mjs';
// @ts-ignore
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';

const prim = createNodePrimitives();
const seal = createStampSeal(prim);
const key = seal.stampKey(new Uint8Array(32).fill(7));
const other = seal.stampKey(new Uint8Array(32).fill(9));
const good = () => seal.seal({ key, ref: 'r1', homeId: 'studio', leaseEpoch: 3 });

test('a sealed stamp opens with its key and ref, among several keys, and nowhere else', () => {
  const s = good();
  assert.ok(s && s.length <= MAX_SEALED_STAMP && !/[+/=]/.test(s));
  assert.deepEqual(seal.open({ sealed: s, ref: 'r1', keys: [other, key] }), { homeId: 'studio', leaseEpoch: 3 });
  assert.equal(seal.open({ sealed: s, ref: 'r2', keys: [key] }), null);
  assert.equal(seal.open({ sealed: s, ref: 'r1', keys: [other] }), null);
  assert.equal(seal.open({ sealed: s, ref: 'r1', keys: [new Uint8Array(5), other] }), null);
});

test('a stamp that is not one is not sealed', () => {
  for (const bad of [
    { homeId: '', leaseEpoch: 1 },
    { homeId: 5, leaseEpoch: 1 },
    { homeId: 'x'.repeat(65), leaseEpoch: 1 },
    { homeId: 'a', leaseEpoch: 0 },
    { homeId: 'a', leaseEpoch: 1.5 },
  ])
    assert.equal(seal.seal({ key, ref: 'r1', ...(bad as any) }), null);
});

test('anything that is not a sealed stamp opens to nothing', () => {
  const s = good() as string;
  assert.equal(seal.open({ sealed: 5 as any, ref: 'r1', keys: [key] }), null);
  assert.equal(seal.open({ sealed: 'x'.repeat(MAX_SEALED_STAMP + 1), ref: 'r1', keys: [key] }), null);
  assert.equal(seal.open({ sealed: '!!!!', ref: 'r1', keys: [key] }), null);
  assert.equal(seal.open({ sealed: 'AAAA', ref: 'r1', keys: [key] }), null);
  // wrong version byte
  const raw = Buffer.from(s, 'base64url');
  raw[0] = 2;
  assert.equal(seal.open({ sealed: raw.toString('base64url'), ref: 'r1', keys: [key] }), null);
  // a flipped byte fails the tag
  const flipped = Buffer.from(s, 'base64url');
  flipped[flipped.length - 1] ^= 1;
  assert.equal(seal.open({ sealed: flipped.toString('base64url'), ref: 'r1', keys: [key] }), null);
});

test('a well-sealed body that is not a stamp opens to nothing', () => {
  const nonce = prim.randomBytes(24);
  const aad = new TextEncoder().encode('mopilot-push-stamp-v1|r1');
  for (const body of [
    'not json',
    JSON.stringify({ h: '', e: 1 }),
    JSON.stringify({ h: 'a', e: 0 }),
    JSON.stringify({ h: 'a'.repeat(65), e: 1 }),
  ]) {
    const box = prim.aeadSeal(key, nonce, new TextEncoder().encode(body), aad);
    const out = new Uint8Array(1 + nonce.length + box.length);
    out[0] = 1;
    out.set(nonce, 1);
    out.set(box, 1 + nonce.length);
    assert.equal(seal.open({ sealed: Buffer.from(out).toString('base64url'), ref: 'r1', keys: [key] }), null, body);
  }
});

test('a primitive that throws on a bad tag (not only one that returns nothing) opens to nothing, and the next key is still tried', () => {
  const s = good() as string;
  let calls = 0;
  const throwing = createStampSeal({
    ...prim,
    aeadOpen: (k: Uint8Array, n: Uint8Array, b: Uint8Array, a: Uint8Array) => {
      calls++;
      if (calls === 1) throw new Error('bad tag');
      return prim.aeadOpen(k, n, b, a);
    },
  });
  assert.deepEqual(throwing.open({ sealed: s, ref: 'r1', keys: [other, key] }), { homeId: 'studio', leaseEpoch: 3 });
  assert.equal(calls, 2);
});
