// Encrypted stores keep their boolean save contract when the OS keychain fails after an availability probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CredentialStore } = require('../electron/capabilities/browser/credentialStore.cjs');
const { ChromeTokens } = require('../electron/capabilities/browser/chromeToken.cjs');

for (const kind of ['login', 'token']) {
  for (const failure of ['probe', 'encrypt']) {
    test(`${kind}: ${failure} failure preserves saved bytes and allows a later retry`, (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encrypted-store-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const file = path.join(dir, 'saved.json');
      let broken = false;
      const safeStorage = {
        isEncryptionAvailable() {
          if (broken && failure === 'probe') throw new Error('keychain unavailable');
          return true;
        },
        encryptString(value: string) {
          if (broken && failure === 'encrypt') throw new Error('keychain locked');
          return Buffer.from(`encrypted:${value}`);
        },
        decryptString(value: Buffer) {
          return value.toString().slice(10);
        },
      };
      const store = kind === 'login' ? new CredentialStore({ file, safeStorage }) : new ChromeTokens({ file, safeStorage });
      const save = (value: string) => (kind === 'login' ? store.save('https://a.test', 'user', value) : store.set('Default', value));
      assert.equal(save('old'), true);
      const before = fs.readFileSync(file, 'utf8');
      broken = true;
      assert.equal(save('new-secret'), false);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      broken = false;
      assert.equal(save('new-secret'), true);
      assert.notEqual(fs.readFileSync(file, 'utf8'), before);
      assert.equal(
        kind === 'login' ? store.get(store.list('https://a.test')[0].id, 'https://a.test').password : store.get('Default'),
        'new-secret',
      );
    });
  }
}
