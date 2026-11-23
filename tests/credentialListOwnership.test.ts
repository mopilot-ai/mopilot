// Saved-login and Never-save mutations preserve files whose list entries this version cannot read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { CredentialStore } = createRequire(import.meta.url)('../electron/capabilities/browser/credentialStore.cjs');
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};
const origin = 'https://a.test';
const login = { id: 'owned', origin, username: 'me', secret: Buffer.from('secret').toString('base64'), source: 'import:chrome' };

for (const value of [null, {}, 1, [login, null], [login, { id: 'future', extra: 'retain me' }]]) {
  test(`login mutations keep an unowned list intact: ${JSON.stringify(value)}`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-list-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'logins.json');
    const raw = JSON.stringify(value);
    fs.writeFileSync(file, raw);
    const store = new CredentialStore({ file, safeStorage });
    assert.equal(store.save(origin, 'other', 'password'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.throws(() => store.saveMany([{ origin, username: 'other', password: 'password' }], 'import:safari'), /weren't changed/);
    assert.throws(() => store.remove('owned'), /weren't changed/);
    assert.throws(() => store.deleteImported('chrome'), /weren't changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), raw);
    if (Array.isArray(value)) assert.deepEqual(store.list(origin), [{ id: 'owned', username: 'me' }]);
    fs.writeFileSync(file, JSON.stringify([login]));
    assert.equal(store.remove('owned'), true, 'a restored readable list can be edited without restarting');
  });
}

for (const raw of ['{broken', 'null', '{}', JSON.stringify([origin, null]), JSON.stringify([origin, 42])]) {
  test(`Never-save choices preserve an unreadable list: ${raw}`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-never-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new CredentialStore({ file: path.join(dir, 'logins.json'), safeStorage });
    fs.writeFileSync(store.neverFile, raw);
    assert.equal(store.setNever('https://b.test'), false);
    assert.equal(fs.readFileSync(store.neverFile, 'utf8'), raw);
    assert.equal(fs.readFileSync(`${store.neverFile}.unreadable`, 'utf8'), raw);
    assert.equal(store.isNever(origin), raw.startsWith('['), 'valid existing choices remain readable');
    fs.writeFileSync(store.neverFile, JSON.stringify([origin]));
    assert.equal(store.setNever('https://b.test'), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.neverFile, 'utf8')), [origin, 'https://b.test']);
  });
}

test('missing files are writable and an unreadable Never-save path reports failure', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore({ file: path.join(dir, 'sub', 'logins.json'), safeStorage });
  assert.equal(store.isNever(origin), false);
  assert.equal(store.save(origin, 'me', 'password'), true);
  assert.equal(store.setNever(origin), true);
  assert.equal(store.setNever(origin), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.neverFile, 'utf8')), [origin]);
  fs.rmSync(store.neverFile);
  fs.mkdirSync(store.neverFile);
  assert.equal(store.isNever(origin), false);
  assert.equal(store.setNever(origin), false);
  assert.equal(fs.statSync(store.neverFile).isDirectory(), true);
});
