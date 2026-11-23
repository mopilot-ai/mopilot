// MoMo's connector token vault (electron/momo/connectors/vault.cjs, #2999 C0): tokens sealed on disk (never plain text), per connector, refused for bad ids or token sets, dropped when damaged, refused without the OS key, and erased by Reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch, clock } from './support/momo-fixtures.ts';

const require = createRequire(import.meta.url);
const { TokenVault } = require('../electron/momo/connectors/vault.cjs');
const { SealedJson } = require('../electron/gateway/sealedFile.cjs');

const T0 = 1_900_000_000_000;

test('tokens are kept per connector, sealed on disk, stamped, replaced and deleted', async () => {
  const dir = scratch();
  const safe = fakeSafe();
  const c = clock(T0);
  const v = new TokenVault({ dir, safeStorage: safe, now: c.now });
  assert.equal(v.get('fake'), null);
  assert.equal(v.has('fake'), false);
  await v.put('fake', {
    accessToken: 'secret-access',
    refreshToken: 'secret-refresh',
    expiresAt: T0 + 3600_000,
    scopes: ['read'],
    account: 'a@b.c',
  });
  assert.deepEqual(v.get('fake'), {
    accessToken: 'secret-access',
    refreshToken: 'secret-refresh',
    expiresAt: T0 + 3600_000,
    scopes: ['read'],
    account: 'a@b.c',
    savedAt: T0,
  });
  assert.equal(v.has('fake'), true);
  const file = path.join(dir, 'connectors', 'tokens.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('secret-access') && !raw.includes('secret-refresh'), 'never plain text on disk');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  // another connector beside it; a replace keeps only what was given
  c.t += 1000;
  await v.put('other', { accessToken: 'x', scopes: [] });
  await v.put('fake', { accessToken: 'new', scopes: ['read', 'write'] });
  assert.deepEqual(v.get('fake'), { accessToken: 'new', scopes: ['read', 'write'], savedAt: T0 + 1000 });
  await v.delete('fake');
  await v.delete('fake');
  assert.equal(v.get('fake'), null);
  assert.equal(v.get('other')?.accessToken, 'x');
  await v.erase();
  assert.equal(fs.existsSync(file), false);
  assert.equal(v.get('other'), null);
});

test('bad ids and token sets are refused; damaged entries are dropped; no OS key means nothing is read or written', async () => {
  const dir = scratch();
  const safe = fakeSafe();
  const v = new TokenVault({ dir, safeStorage: safe });
  for (const id of ['', 'Fake', '../x', 'a b', 7]) assert.throws(() => v.get(id as any), /Not a connector id/);
  assert.throws(() => v.put('fake', { accessToken: '', scopes: [] }), /needs an access token/);
  assert.throws(() => v.put('fake', { accessToken: 'a', scopes: [1] as any }), /needs an access token/);
  // written behind the vault's back: invalid ids, entries and fields are dropped
  const json = new SealedJson({ file: path.join(dir, 'connectors', 'tokens.json'), safeStorage: safe, shape: (x: any) => x ?? {} });
  await json.change((all: any) => {
    all.good = { accessToken: 'a', scopes: ['s'], savedAt: 1, refreshToken: '', expiresAt: 'soon', account: 3 };
    all['Bad id'] = { accessToken: 'a', scopes: [], savedAt: 1 };
    all.nosaved = { accessToken: 'a', scopes: [] };
    all.noscopes = { accessToken: 'a', savedAt: 1 };
    all.notobj = [1];
  });
  assert.deepEqual(v.get('good'), { accessToken: 'a', scopes: ['s'], savedAt: 1 });
  assert.equal(v.get('nosaved'), null);
  assert.equal(v.get('noscopes'), null);
  assert.equal(v.get('notobj'), null);
  safe.available = false;
  assert.throws(
    () => v.get('good'),
    (e: any) => e.code === 'unavailable',
  );
  await assert.rejects(v.put('good', { accessToken: 'b', scopes: [] }), (e: any) => e.code === 'unavailable');
});
