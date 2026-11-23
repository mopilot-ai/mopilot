// Linux saved credentials require a real desktop keyring; failed or fallback encryption preserves prior secret files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { directory } from './support/acp-registry.ts';

const require = createRequire(import.meta.url);
const { canEncrypt, encryptForStore } = require('../electron/platform/encryptedStore.cjs');
const { writeSecret } = require('../electron/platform/secretFile.cjs');
const { ChromePairing } = require('../electron/capabilities/browser/chromePairing.cjs');
const { CredentialStore } = require('../electron/capabilities/browser/credentialStore.cjs');

test('encryption accepts desktop secret backends and existing macOS/Windows APIs but refuses fallback and failed probes', () => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', undefined]) {
    const safe = {
      isEncryptionAvailable: () => true,
      ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
      encryptString: (value: string) => Buffer.from(value),
    };
    assert.equal(canEncrypt(safe), true);
    assert.deepEqual(encryptForStore(safe, 'value'), { ok: true, value: Buffer.from('value').toString('base64') });
  }
  for (const safe of [
    null,
    undefined,
    { isEncryptionAvailable: () => false },
    { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' },
    {
      isEncryptionAvailable: () => {
        throw new Error('locked');
      },
    },
    {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => {
        throw new Error('unavailable');
      },
    },
  ]) {
    assert.equal(canEncrypt(safe), false);
    assert.deepEqual(encryptForStore(safe, 'value'), { ok: false });
  }
  assert.deepEqual(
    encryptForStore(
      {
        isEncryptionAvailable: () => true,
        encryptString: () => {
          throw new Error('locked after probe');
        },
      },
      'secret',
    ),
    { ok: false },
  );
});

test('fallback storage cannot overwrite secrets or persist Chrome pairing and browser password imports', () => {
  const dir = directory();
  let backend = 'gnome_libsecret';
  let encryptions = 0;
  const safe = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value: string) => (encryptions++, Buffer.from(value)),
    decryptString: (value: Buffer) => value.toString(),
  };
  const file = path.join(dir, 'login.json');
  writeSecret(file, 'original', safe);
  const before = fs.readFileSync(file, 'utf8');
  backend = 'basic_text';
  assert.throws(() => writeSecret(file, 'replacement', safe), /wasn’t saved/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(encryptions, 1);
  const pairingFile = path.join(dir, 'pairing.json');
  const pairing = new ChromePairing({ file: pairingFile, safeStorage: safe });
  assert.ok(pairing.forPort(40000).secret);
  assert.equal(fs.existsSync(pairingFile), false);
  const credentials = new CredentialStore({ file: path.join(dir, 'passwords.json'), safeStorage: safe });
  assert.equal(credentials.available(), false);
  assert.equal(credentials.save('https://example.com', 'user', 'secret'), false);
  assert.equal(encryptions, 1);
  backend = 'gnome_libsecret';
  assert.equal(credentials.save('https://example.com', 'user', 'secret'), true);
});
