// This app's Host client key at rest (electron/host/pairingClient.cjs loadIdentity, finding H-1 in docs/host-threat-model.md): sealed with safeStorage and never written in plain text, a plain-text file of an earlier version sealed in its place, and a file that can't be opened never replaced by a quiet new key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { keySafe, openKeyFile } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { loadIdentity } = require('../electron/host/pairingClient.cjs');

const tmp = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'host-key-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'host-client-key.json');
};
const locked = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
/** A pair as an earlier version kept it, in plain text. */
function plainPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  };
}

test('a new key is kept sealed, owner-only, with no private key in the file, and read back the same', (t) => {
  const file = tmp(t);
  const id = loadIdentity(file, keySafe);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(raw).enc, 'safe');
  assert.doesNotMatch(raw, /PRIVATE KEY|privateKey|publicKey/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(openKeyFile(file).publicKey, id.publicKey);
  assert.equal(loadIdentity(file, keySafe).keyId, id.keyId);
  // a rotation's next key is sealed too
  id.startRotation();
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE KEY|next/);
  assert.ok(openKeyFile(file).next.privateKey);
});

test('a plain-text key of an earlier version stays the same key and is sealed in its place', (t) => {
  const file = tmp(t);
  const old = plainPair();
  fs.writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
  const id = loadIdentity(file, keySafe);
  assert.equal(id.publicKey, old.publicKey, 'every paired Host still knows it');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE KEY/);
  assert.equal(openKeyFile(file).privateKey, old.privateKey);
  assert.equal(loadIdentity(file, keySafe).publicKey, old.publicKey);
});

test('without the keychain nothing is written in plain text: a new key is refused, and an old plain-text one is used until it can be sealed', (t) => {
  const file = tmp(t);
  assert.throws(() => loadIdentity(file, locked), /can’t encrypt this app’s Host key.*keychain is unlocked/);
  assert.throws(() => loadIdentity(file, null), /can’t encrypt/);
  assert.equal(fs.existsSync(file), false);
  const old = plainPair();
  fs.writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
  const id = loadIdentity(file, locked);
  assert.equal(id.publicKey, old.publicKey);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old, 'left as it was');
  // a change needs a save, which is refused rather than written unsealed
  assert.throws(() => id.startRotation(), /can’t encrypt/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old);
  // once the keychain is there, it is sealed
  loadIdentity(file, keySafe);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE KEY/);
});

test('a sealed key that can’t be opened (another Mac’s keychain, no keychain, not a key inside) is an error with a copy kept, never a new key', (t) => {
  const file = tmp(t);
  const id = loadIdentity(file, keySafe);
  const sealed = fs.readFileSync(file, 'utf8');
  const other = {
    ...keySafe,
    decryptString: () => {
      throw new Error('Error while decrypting the ciphertext');
    },
  };
  assert.throws(() => loadIdentity(file, other), /cannot be read \(Error while decrypting.*copy was kept/);
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), sealed);
  assert.throws(() => loadIdentity(file, undefined), /cannot be read/);
  assert.equal(fs.readFileSync(file, 'utf8'), sealed, 'not replaced');
  assert.equal(loadIdentity(file, keySafe).publicKey, id.publicKey);
  fs.writeFileSync(file, JSON.stringify({ v: 1, enc: 'safe', data: keySafe.encryptString('{"publicKey":1}').toString('base64') }));
  assert.throws(() => loadIdentity(file, keySafe), /cannot be read \(Invalid saved state/);
});

test('a save that fails for another reason says so as it is', (t) => {
  const file = path.join(path.dirname(tmp(t)), 'missing', 'k.json');
  assert.throws(() => loadIdentity(file, keySafe), /ENOENT/);
});

test('a key id the remote chats read while the key can’t be opened is none, so a Host’s event is still handled', async (t) => {
  const { remoteChatsFor } = require('../electron/host/wiring.cjs');
  const dir = path.dirname(tmp(t));
  loadIdentity(path.join(dir, 'host-client-key.json'), keySafe);
  const other = {
    ...keySafe,
    decryptString: () => {
      throw new Error('locked');
    },
  };
  let opened: any = null;
  const chats = remoteChatsFor({
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => null }),
    acpHost: () => undefined,
    safeStorage: () => opened,
  });
  // deleting a machine's chat asks for the key id: with the keychain locked there is none, and it says so plainly
  const { OwnershipStore } = require('../electron/host/ownership.cjs');
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('acp:kimi:x', {
    hostId: 'box',
    ownerHostId: 'box',
    epoch: 1,
    folder: '/w',
  });
  opened = other;
  await assert.rejects(chats.forget('acp:kimi:x'), /no paired identity/);
});

test('the acceptance runs seal their throwaway client key with a stand-in, which gives back what it sealed', async () => {
  const { throwawayKeySafe, realDeps } = await import('../scripts/host-accept.mjs');
  assert.equal(throwawayKeySafe.isEncryptionAvailable(), true);
  assert.equal(throwawayKeySafe.decryptString(throwawayKeySafe.encryptString('k')), 'k');
  assert.equal(realDeps().keySafe, throwawayKeySafe);
});
