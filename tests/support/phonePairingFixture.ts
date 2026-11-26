// Phone pairing over shared crypto, a real desktop pairing service and controlled secure-store/transport boundaries.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fakeSafe, fs, tempDir } from './remoteKit.ts';
import { createPhonePairing } from '../../shared/remote/phonePairing.mjs';
import { createPhonePrimitives } from '../../shared/remote/phonePrimitives.mjs';
import { createCrypto } from '../../shared/remote/crypto.mjs';
import { toWire, utf8 } from '../../shared/remote/envelope.mjs';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
const require = createRequire(import.meta.url);
const { createSodiumPrimitives } = require('../../electron/platform/sodiumPrimitives.cjs');
const { PairingService } = require('../../electron/remote/pairing.cjs');
const { DeviceList } = require('../../electron/remote/deviceList.cjs');
export const prim = createSodiumPrimitives(),
  c = createCrypto(prim);
const x = () => {
  const sk = prim.randomBytes(32);
  return { sk, pk: prim.x25519Base(sk) };
};
export const deferred = () => {
  let resolve!: (v: any) => void, reject!: (e: Error) => void;
  const promise = new Promise<any>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
export function setup() {
  const identity = { phoneId: 'phone_1234', x: x(), ed: prim.edKeypair() };
  const mac = { macId: 'mac_1234', x: x(), ed: prim.edKeypair() };
  let saved: any,
    hello: any,
    answer: any,
    observed = '';
  const devices = new DeviceList({ file: join(tempDir(), 'devices.key'), safe: fakeSafe(), fs });
  const desktop = new PairingService({
    identity: { get: async () => mac },
    devices,
    prim,
    relayUrl: () => 'wss://relay.example/ws',
    registerPair: async () => {},
    removePair: async () => {},
    sendReply: (f: any) => {
      answer = toWire(f);
    },
    confirm: async ({ safetyNumber }: any) => {
      observed = safetyNumber;
      return 'allow';
    },
    now: () => 100,
  });
  let pending: any = null;
  const store = {
    getIdentity: async () => identity,
    getPending: async () => pending,
    claimPending: async (p: any) => {
      if (pending) return false;
      pending = p;
      return true;
    },
    markJoining: async (owner: string) => {
      assert.equal(pending?.owner, owner);
      assert.equal(pending.phase, 'prepared');
      pending = { ...pending, phase: 'joining' };
    },
    clearRefused: async (owner: string) => {
      if (pending?.owner !== owner) throw new Error('stale pairing');
      pending = null;
    },
    clearPrepared: async (owner: string) => {
      assert.equal(pending?.owner, owner);
      assert.equal(pending.phase, 'prepared');
      pending = null;
    },
    savePair: async (owner: string, p: any) => {
      assert.equal(pending?.owner, owner);
      assert.equal(pending?.pairId, p.pairId);
      assert.equal(pending.phase, 'joining');
      saved = p;
      pending = null;
    },
  };
  const transport = {
    join: async (_relay: string, _pair: string) => {},
    send: async (f: any) => {
      hello = f;
    },
    remove: async (_relay: string, _pair: string) => {},
  };
  // This stand-in exposes the native JS signatures while desktop sodium performs the operations in Node.
  const phonePrim = createPhonePrimitives(
    {
      randombytes_buf: prim.randomBytes,
      crypto_sign_keypair: () => {
        const p = prim.edKeypair();
        return { publicKey: p.pk, privateKey: p.sk };
      },
      crypto_sign_detached: (msg: Uint8Array, sk: Uint8Array) => prim.edSign(sk, msg),
      crypto_sign_verify_detached: (sig: Uint8Array, msg: Uint8Array, pk: Uint8Array) => prim.edVerify(pk, msg, sig),
      crypto_aead_xchacha20poly1305_ietf_encrypt: (plain: Uint8Array, aad: string, _n: null, nonce: Uint8Array, key: Uint8Array) =>
        prim.aeadSeal(key, nonce, plain, utf8(aad)),
      crypto_aead_xchacha20poly1305_ietf_decrypt: (_n: null, box: Uint8Array, aad: string, nonce: Uint8Array, key: Uint8Array) => {
        const result = prim.aeadOpen(key, nonce, box, utf8(aad));
        if (result === null)
          throw new Error(
            '[react-native-libsodium][crypto_aead_xchacha20poly1305_ietf_decrypt] crypto_aead_xchacha20poly1305_ietf_decrypt failed',
          );
        return result;
      },
    },
    { x25519, sha256, hmac },
  );
  const phone = createPhonePairing({ prim: phonePrim, relayUrl: 'wss://relay.example/ws', store, transport, now: () => 100 });
  return {
    identity,
    mac,
    desktop,
    devices,
    store,
    transport,
    phone,
    get hello() {
      return hello;
    },
    get answer() {
      return answer;
    },
    get saved() {
      return saved;
    },
    get observed() {
      return observed;
    },
  };
}
