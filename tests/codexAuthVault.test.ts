// electron/identity/accounts/authVault.cjs and records.cjs readAuth/writeAuth: an added Codex account's sign-in is
// encrypted at rest and in plain text only while its helper runs; the CLI's own $CODEX_HOME is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const { AuthVault, PLAIN, SEALED } = require('../electron/identity/accounts/authVault.cjs');
const { readAuth, readAuthText, writeAuth } = require('../electron/identity/accounts/records.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const KEY = JSON.stringify({ OPENAI_API_KEY: 'sk-secret-1' });
function setup(safe: any = fakeSafe()) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-vault-'));
  const root = path.join(userData, 'accounts');
  fs.mkdirSync(root);
  const vault = new AuthVault({ root, safeStorage: safe });
  const home = path.join(root, 'acct');
  fs.mkdirSync(home);
  return { userData, root, vault, home };
}
const exists = (home: string, f: string) => fs.existsSync(path.join(home, f));
const contexts = () => recentIgnored().map((e: any) => e.context);

test('a sign-in is saved encrypted and private, never in plain text, and read back', () => {
  const { home, vault } = setup();
  writeAuth(home, KEY);
  assert.equal(exists(home, PLAIN), false);
  const raw = fs.readFileSync(path.join(home, SEALED), 'utf8');
  assert.ok(!raw.includes('sk-secret-1'));
  assert.equal(fs.statSync(path.join(home, SEALED)).mode & 0o777, 0o600);
  assert.deepEqual(readAuth(home), { kind: 'apiKey', apiKey: 'sk-secret-1' });
  assert.equal(AuthVault.of(home), vault);
});

test('reads decrypt once per saved version', () => {
  let decrypts = 0;
  const safe = fakeSafe();
  const counting = { ...safe, decryptString: (b: Buffer) => (decrypts++, safe.decryptString(b)) };
  const { home, vault } = setup(counting);
  vault.write(home, KEY);
  vault.read(home);
  vault.read(home);
  assert.equal(decrypts, 1);
  vault.write(home, JSON.stringify({ OPENAI_API_KEY: 'sk-2' }));
  assert.equal(JSON.parse(vault.read(home)).OPENAI_API_KEY, 'sk-2');
  assert.equal(decrypts, 2);
});

test('a helper gets the plain sign-in only while it runs: open writes it, seal encrypts what it left and deletes it', () => {
  const { home, vault } = setup();
  vault.write(home, KEY);
  vault.open(home);
  assert.equal(fs.readFileSync(path.join(home, PLAIN), 'utf8'), KEY);
  assert.equal(fs.statSync(path.join(home, PLAIN)).mode & 0o777, 0o600);
  // the helper refreshed the token: the plain file is the newest and is what reads see
  const refreshed = JSON.stringify({ OPENAI_API_KEY: 'sk-refreshed' });
  fs.writeFileSync(path.join(home, PLAIN), refreshed);
  assert.equal(vault.read(home), refreshed);
  // a write while it runs reaches the helper's copy too
  vault.write(home, KEY);
  assert.equal(fs.readFileSync(path.join(home, PLAIN), 'utf8'), KEY);
  fs.writeFileSync(path.join(home, PLAIN), refreshed);
  vault.open(home);
  assert.equal(fs.readFileSync(path.join(home, PLAIN), 'utf8'), refreshed, 'open never overwrites a running helper’s copy');
  vault.seal(home);
  assert.equal(exists(home, PLAIN), false);
  assert.equal(vault.read(home), refreshed);
  clearIgnored();
  vault.seal(home);
  assert.deepEqual(contexts(), [], 'nothing left to seal is no failure');
  // nothing saved: no plain file is made
  const empty = path.join(path.dirname(home), 'empty');
  fs.mkdirSync(empty);
  vault.open(empty);
  assert.equal(exists(empty, PLAIN), false);
});

test('without the OS key a sign-in is refused, and a plain one a helper left stays until it can be sealed', () => {
  let on = true;
  const safe = { ...fakeSafe(), isEncryptionAvailable: () => on };
  const { home, vault } = setup(safe);
  vault.write(home, KEY);
  vault.open(home);
  on = false;
  assert.equal(vault.available(), false);
  assert.throws(
    () => vault.write(home, KEY),
    (e: any) => e.code === 'secret_unavailable',
  );
  clearIgnored();
  vault.seal(home);
  assert.equal(exists(home, PLAIN), true, 'deleting it would lose the sign-in');
  assert.deepEqual(contexts(), ['encrypt a Codex sign-in']);
  on = true;
  vault.seal(home);
  assert.equal(exists(home, PLAIN), false);
});

test('an unreadable sealed sign-in reads as signed out and is recorded; a broken plain file too', () => {
  const { home } = setup();
  fs.writeFileSync(path.join(home, SEALED), JSON.stringify({ v: 1, enc: 'safe', data: 'b3RoZXI=' }));
  clearIgnored();
  assert.equal(readAuth(home), null);
  assert.deepEqual(contexts(), ['decrypt a Codex sign-in']);
  fs.mkdirSync(path.join(home, PLAIN));
  clearIgnored();
  assert.equal(readAuth(home), null);
  assert.deepEqual(contexts(), ['read a Codex sign-in', 'decrypt a Codex sign-in']);
});

test('the CLI’s own home is not the vault’s: plain auth.json read and written as before, never sealed or removed', () => {
  const { vault, userData } = setup();
  const cli = path.join(userData, 'codex-home');
  fs.mkdirSync(cli);
  assert.equal(AuthVault.of(cli), null);
  writeAuth(cli, KEY);
  assert.equal(fs.readFileSync(path.join(cli, PLAIN), 'utf8'), KEY);
  assert.equal(fs.statSync(path.join(cli, PLAIN)).mode & 0o777, 0o600);
  assert.equal(readAuthText(cli), KEY);
  vault.seal(cli);
  vault.open(cli);
  assert.equal(fs.readFileSync(path.join(cli, PLAIN), 'utf8'), KEY);
  assert.equal(exists(cli, SEALED), false);
});

test('at startup every plain sign-in is sealed and unfinished sign-ins are deleted', () => {
  const { root, vault, home } = setup();
  fs.writeFileSync(path.join(home, PLAIN), KEY);
  fs.mkdirSync(path.join(root, '.signin-1234'));
  fs.writeFileSync(path.join(root, '.signin-1234', PLAIN), KEY);
  fs.mkdirSync(path.join(root, '.other'));
  fs.writeFileSync(path.join(root, '.other', PLAIN), KEY);
  fs.writeFileSync(path.join(root, 'stray-file'), 'x');
  clearIgnored();
  vault.sealAll();
  assert.equal(exists(home, PLAIN), false);
  assert.equal(readAuth(home)?.apiKey, 'sk-secret-1');
  assert.equal(fs.existsSync(path.join(root, '.signin-1234')), false);
  assert.equal(exists(path.join(root, '.other'), PLAIN), true, 'only account folders and unfinished sign-ins are touched');
  assert.deepEqual(contexts(), []);
});

test('startup with no accounts folder is nothing to do; an unfinished sign-in that can’t be removed is recorded', () => {
  const missing = new AuthVault({ root: path.join(os.tmpdir(), `no-accounts-${process.pid}-${Date.now()}`), safeStorage: fakeSafe() });
  clearIgnored();
  missing.sealAll();
  assert.deepEqual(contexts(), []);
  const { root, vault } = setup();
  const stuck = path.join(root, '.signin-stuck');
  fs.mkdirSync(path.join(stuck, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(stuck, 'inner', 'f'), 'x');
  fs.chmodSync(path.join(stuck), 0o500);
  try {
    clearIgnored();
    vault.sealAll();
    assert.deepEqual(contexts(), ['remove an unfinished Codex sign-in']);
  } finally {
    fs.chmodSync(stuck, 0o700);
  }
});

test('a helper that exits after another took its place leaves the plain sign-in to the running one', () => {
  const { home, vault } = setup();
  vault.write(home, KEY);
  const helpers = new Map<string, any>();
  let exitOld = () => {};
  const old = vault.helper(helpers, home, (onExit: () => void) => ((exitOld = onExit), { running: true }));
  assert.equal(
    vault.helper(helpers, home, () => assert.fail('a running helper is reused')),
    old,
  );
  old.running = false;
  const next = vault.helper(helpers, home, () => ({ running: true }));
  assert.notEqual(next, old);
  exitOld();
  assert.equal(helpers.get(home), next, 'the old one does not remove its replacement');
  assert.equal(exists(home, PLAIN), true, 'the running helper still reads it');
  next.running = false;
  exitOld();
  assert.equal(exists(home, PLAIN), false, 'sealed once no helper runs');
});

test('a sealed sign-in deleted between the check and the read reads as signed out, recorded', () => {
  const { home, vault } = setup();
  vault.write(home, KEY);
  const fsMod = require('node:fs');
  const real = fsMod.readFileSync;
  fsMod.readFileSync = (f: any, ...rest: any[]) => {
    if (String(f).endsWith(SEALED)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return real.call(fsMod, f, ...rest);
  };
  try {
    vault.cache.clear();
    clearIgnored();
    assert.equal(vault.read(home), null);
    assert.deepEqual(contexts(), ['decrypt a Codex sign-in']);
  } finally {
    fsMod.readFileSync = real;
  }
});

test('at startup, temporary files an unfinished write left in an account folder (one may hold a sign-in) go', () => {
  const { root, vault, home } = setup();
  const tmpFile = path.join(home, `.mopilot-${process.pid}-0000.tmp`);
  fs.writeFileSync(tmpFile, KEY);
  fs.writeFileSync(path.join(home, 'keep.tmp'), 'x');
  vault.sealAll();
  assert.equal(fs.existsSync(tmpFile), false);
  assert.equal(fs.existsSync(path.join(home, 'keep.tmp')), true, 'only fsutil’s own temporary names');
  // a folder that can't be listed is recorded and left for the next start
  const shut = path.join(root, 'shut');
  fs.mkdirSync(shut);
  fs.chmodSync(shut, 0o000);
  clearIgnored();
  try {
    vault.sealAll();
  } finally {
    fs.chmodSync(shut, 0o700);
  }
  assert.ok(contexts().includes('remove what an unfinished write left in a Codex account folder'));
});
