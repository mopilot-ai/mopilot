// The Claude API key at rest (electron/harness/claude/auth.cjs with electron/platform/secretFile.cjs): saved only encrypted, a plain key
// an earlier version left is encrypted and deleted on first read, and nothing is saved without the OS key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakes, load, savedKey } from './support/electron-claude.ts';

const { recentIgnored, clearIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');

const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

test('a key saved under another OS key reads as none and is recorded, never used as a key', () => {
  const t = load();
  clearIgnored();
  fs.writeFileSync(path.join(t.userData, 'claude-api-key.json'), JSON.stringify({ v: 1, enc: 'safe', data: 'b3RoZXI=' }));
  assert.equal(t.claude.identity.keyInfo().set, false);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['read the saved Claude API key'],
  );
});

test('a key an earlier version kept in plain text is encrypted and its plain copy deleted on first read', () => {
  const t = load();
  fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-old-4321\n', { mode: 0o644 });
  fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'apiKey');
  assert.equal(t.claude.authMode(), 'apiKey');
  assert.equal(t.claude.identity.keyInfo().hint, '4321');
  assert.equal(fs.existsSync(path.join(t.userData, 'claude-api-key')), false);
  assert.equal(savedKey(t.userData), 'sk-old-4321');
  assert.equal(fs.statSync(path.join(t.userData, 'claude-api-key.json')).mode & 0o777, 0o600);
  // read again in a new run: from the encrypted file
  const again = load();
  fs.renameSync(path.join(t.userData, 'claude-api-key.json'), path.join(again.userData, 'claude-api-key.json'));
  assert.equal(again.claude.identity.keyInfo().hint, '4321');
});

test('without the OS key a plain key from an earlier version still works but stays where it is; a new key is refused', async () => {
  const t = load();
  fakes.encryption = false;
  fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-old-4321');
  assert.equal(t.claude.identity.keyInfo().hint, '4321');
  assert.equal(read(t.userData, 'claude-api-key'), 'sk-old-4321');
  assert.equal(fs.existsSync(path.join(t.userData, 'claude-api-key.json')), false);
  const u = load();
  fakes.encryption = false;
  await assert.rejects(u.call('claude:setApiKey', 'sk-ant-9999', ''), (e: any) => e.code === 'secret_unavailable');
  assert.deepEqual(
    fs.readdirSync(u.userData).filter((f) => f.startsWith('claude-api-key')),
    [],
  );
  assert.equal(u.claude.identity.keyInfo().set, false);
  assert.equal(u.claude.authMode(), 'subscription');
});

test('a plain key that cannot be moved keeps working this run, and the failure is recorded', () => {
  const t = load();
  fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-old-4321');
  // the folder refuses new files: the encrypted copy can't be written
  fs.chmodSync(t.userData, 0o500);
  clearIgnored();
  try {
    assert.equal(t.claude.identity.keyInfo().hint, '4321');
  } finally {
    fs.chmodSync(t.userData, 0o700);
  }
  assert.equal(read(t.userData, 'claude-api-key'), 'sk-old-4321');
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['encrypt the plain Claude API key of an earlier version'],
  );
});

test('saving an API key replaces its files whole: ones left readable by others become private, the plain copy goes', async () => {
  const t = load();
  for (const f of ['claude-api-key', 'claude-api-key.json', 'claude-api-base']) {
    fs.writeFileSync(path.join(t.userData, f), 'old');
    fs.chmodSync(path.join(t.userData, f), 0o644);
  }
  await t.call('claude:setApiKey', 'sk-ant-5678', 'https://gw.example');
  for (const f of ['claude-api-key.json', 'claude-api-base']) assert.equal(fs.statSync(path.join(t.userData, f)).mode & 0o777, 0o600, f);
  assert.equal(fs.existsSync(path.join(t.userData, 'claude-api-key')), false);
  assert.equal(savedKey(t.userData), 'sk-ant-5678');
  assert.equal(read(t.userData, 'claude-auth-mode'), 'apiKey');
  assert.deepEqual(
    fs.readdirSync(t.userData).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('a process without safeStorage refuses a new key and leaves a plain one in place', async () => {
  const t = load();
  const safe = fakes.safe;
  fakes.safe = undefined;
  try {
    fs.writeFileSync(path.join(t.userData, 'claude-api-key'), 'sk-old-4321');
    assert.equal(t.claude.identity.keyInfo().hint, '4321');
    assert.equal(read(t.userData, 'claude-api-key'), 'sk-old-4321');
    await assert.rejects(t.call('claude:setApiKey', 'sk-ant-9999', ''), (e: any) => e.code === 'secret_unavailable');
  } finally {
    fakes.safe = safe;
  }
});

test('a saved key that can not be read now is read again next time, not taken as none for the run', () => {
  const t = load();
  fs.writeFileSync(path.join(t.userData, 'claude-auth-mode'), 'apiKey');
  const real = fakes.safe.decryptString;
  fakes.safe.decryptString = () => {
    throw new Error('the keychain refused');
  };
  try {
    fs.writeFileSync(
      path.join(t.userData, 'claude-api-key.json'),
      JSON.stringify({ v: 1, enc: 'safe', data: Buffer.from(fakes.safe.encryptString('sk-ant-2468')).toString('base64') }),
    );
    assert.equal(t.claude.identity.keyInfo().set, false);
  } finally {
    fakes.safe.decryptString = real;
  }
  assert.equal(t.claude.identity.keyInfo().hint, '2468');
  assert.equal(t.claude.authMode(), 'apiKey');
});

test('a plain key beside the encrypted one never stays: the newer of the two is kept, encrypted (#2144)', async () => {
  // the encrypted key, saved first
  const first = load();
  await first.call('claude:setApiKey', 'sk-ant-old-1111', '');
  const sealedOld = fs.readFileSync(path.join(first.userData, 'claude-api-key.json'));
  const put = (dir: string, plain: string, plainNewer: boolean) => {
    fs.writeFileSync(path.join(dir, 'claude-api-key.json'), sealedOld);
    fs.writeFileSync(path.join(dir, 'claude-api-key'), plain);
    // the older of the two gets an old time
    fs.utimesSync(path.join(dir, plainNewer ? 'claude-api-key.json' : 'claude-api-key'), 1, 1);
  };
  // a downgrade wrote a newer plain key after it: that one is kept, encrypted
  const t = load();
  put(t.userData, 'sk-ant-new-2222', true);
  assert.equal(t.claude.identity.keyInfo().hint, '2222');
  assert.equal(fs.existsSync(path.join(t.userData, 'claude-api-key')), false);
  assert.equal(savedKey(t.userData), 'sk-ant-new-2222');
  // the encrypted key is the newer one: the stale plain copy only goes
  const u = load();
  put(u.userData, 'sk-ant-stale-3333', false);
  assert.equal(u.claude.identity.keyInfo().hint, '1111');
  assert.equal(fs.existsSync(path.join(u.userData, 'claude-api-key')), false);
});
