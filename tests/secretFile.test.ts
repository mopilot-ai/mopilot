// electron/platform/secretFile.cjs: secrets are saved only encrypted (0600), refused without the OS key, and read back; an
// earlier unencrypted envelope is recognized for migration, and unreadable files throw instead of reading as none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/computerHistory.ts';

const { SecretUnavailableError, canEncrypt, sealSecret, writeSecret, readSecret } = createRequire(import.meta.url)(
  '../electron/platform/secretFile.cjs',
);

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'secret-file-'));

test('a secret is written encrypted and private, and read back', () => {
  const file = path.join(dir(), 's.json');
  writeSecret(file, 'sk-live-1234', fakeSafe());
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('sk-live-1234'));
  assert.equal(JSON.parse(raw).enc, 'safe');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readSecret(file, fakeSafe()), { value: 'sk-live-1234', legacy: false });
});

test('without the OS key nothing is written and the error says what was not saved', () => {
  const file = path.join(dir(), 's.json');
  for (const safe of [
    fakeSafe(false),
    null,
    {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('locked');
      },
    },
  ]) {
    assert.throws(
      () => writeSecret(file, 'k', safe, 'the API key'),
      (e: any) => e instanceof SecretUnavailableError && e.code === 'secret_unavailable' && /can’t encrypt the API key/.test(e.message),
    );
  }
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => sealSecret(fakeSafe(false), 'k'), /can’t encrypt it/);
});

test('canEncrypt is false when the probe throws or there is no safeStorage', () => {
  assert.equal(canEncrypt(fakeSafe()), true);
  assert.equal(canEncrypt(fakeSafe(false)), false);
  assert.equal(canEncrypt(null), false);
  assert.equal(
    canEncrypt({
      isEncryptionAvailable: () => {
        throw new Error('no keychain');
      },
    }),
    false,
  );
});

test('reading: none, an earlier plain envelope, and every unreadable form throws', () => {
  const d = dir();
  assert.equal(readSecret(path.join(d, 'missing.json'), fakeSafe()), null);
  const plain = path.join(d, 'plain.json');
  fs.writeFileSync(plain, JSON.stringify({ v: 1, enc: 'plain', data: Buffer.from('old').toString('base64') }));
  assert.deepEqual(readSecret(plain, null), { value: 'old', legacy: true });
  const cases: [string, string | null, RegExp][] = [
    ['not json', 'x', /JSON/],
    ['no data', JSON.stringify({ enc: 'safe' }), /Not a saved secret/],
    ['unknown', JSON.stringify({ enc: 'rot13', data: 'x' }), /Not a saved secret/],
    ['other key', JSON.stringify({ enc: 'safe', data: Buffer.from('zzz').toString('base64') }), /bad ciphertext/],
  ];
  for (const [name, body, err] of cases) {
    const f = path.join(d, `${name}.json`);
    fs.writeFileSync(f, body as string);
    assert.throws(() => readSecret(f, fakeSafe()), err, name);
  }
  const sealed = path.join(d, 'sealed.json');
  writeSecret(sealed, 'v', fakeSafe());
  assert.throws(
    () => readSecret(sealed, null),
    (e: any) => e.code === 'secret_unavailable',
  );
  fs.mkdirSync(path.join(d, 'folder.json'));
  assert.throws(() => readSecret(path.join(d, 'folder.json'), fakeSafe()), /EISDIR/);
});
