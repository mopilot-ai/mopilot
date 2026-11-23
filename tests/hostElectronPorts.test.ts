// The Host installs its own paths behind the ports the shared electron/ modules read (host/src/electronPorts.mjs): a module that
// keeps a file in "userData" keeps it in the Host's data dir, and the previous port comes back when the Host stops.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { installElectronPorts } from '../host/src/electronPorts.mjs';
import { main } from '../host/src/cli.mjs';
import { useFakePaths } from './support/ports/paths.ts';
import { useFakeSecrets } from './support/ports/secrets.ts';
import { createFileSafeStorage } from '../host/src/secretStore.mjs';

const require = createRequire(import.meta.url);
const { paths, installPaths } = require('../electron/platform/ports/paths.cjs');
const { openExternal, installOpenExternal } = require('../electron/platform/ports/openExternal.cjs');
const { secrets, installSecrets } = require('../electron/platform/ports/secrets.cjs');
const { createAuth } = require('../electron/harness/claude/auth.cjs');
const { createArtifacts } = require('../electron/harness/claude/artifacts.cjs');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-ports-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

test('the paths port reads what is installed each time, and null puts Electron’s back', (t) => {
  useFakePaths(t, '/one');
  assert.equal(paths.userData(), '/one');
  const previous = installPaths({ userData: () => '/two' });
  assert.equal(paths.userData(), '/two');
  installPaths(previous);
  assert.equal(paths.userData(), '/one');
  // with nothing installed the port asks Electron, which a plain Node process does not have
  const fallback = installPaths(null);
  assert.throws(() => paths.userData());
  installPaths(fallback);
});

test('a shared module keeps its file in the Host’s data dir', () => {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const restore = installElectronPorts({ paths: { dataDir: dir, configDir: path.join(dir, 'config') }, openExternal: async () => {} });
  try {
    const artifacts = createArtifacts({ restartIdle: () => {}, isEnabled: () => true });
    artifacts.setArtifacts(true);
    assert.ok(fs.existsSync(path.join(dir, 'claude-artifacts-on')));
  } finally {
    restore();
  }
});

test('serve installs the Host’s paths while it runs and puts the previous ones back', async (t) => {
  useFakePaths(t, '/before');
  const dir = fs.mkdtempSync(path.join(base, 's-'));
  const signals: any = new EventEmitter();
  const out: string[] = [];
  const running = main(['serve', '--data-dir', dir], { out: (l: string) => out.push(l), err: () => {}, env: {}, signals });
  while (!out.length) await new Promise((r) => setTimeout(r, 10));
  assert.equal(paths.userData(), dir);
  signals.emit('SIGTERM');
  assert.equal(await running, 0);
  assert.equal(paths.userData(), '/before');
});

test('a serve that cannot start puts the previous paths back', async (t) => {
  useFakePaths(t, '/before');
  const dir = fs.mkdtempSync(path.join(base, 'l-'));
  fs.writeFileSync(path.join(dir, 'host.lock'), String(process.pid));
  await assert.rejects(
    main(['serve', '--data-dir', dir], { out: () => {}, err: () => {}, env: {}, signals: new EventEmitter() as any }),
    /already uses/,
  );
  assert.equal(paths.userData(), '/before');
});

test('the secrets port reads what is installed each time, and null puts Electron’s back (none here)', (t) => {
  const safe = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (b: Buffer) => String(b) };
  useFakeSecrets(t, safe);
  assert.equal(secrets.safeStorage(), safe);
  const fallback = installSecrets(null);
  assert.equal(secrets.safeStorage(), null, 'a process without Electron has no safeStorage until one is installed');
  installSecrets(fallback);
  assert.equal(secrets.safeStorage(), safe);
});

test('the Host’s safe storage seals with a key of its own, shared by every instance, and refuses tampering', () => {
  const dir = path.join(fs.mkdtempSync(path.join(base, 'k-')), 'config');
  const a = createFileSafeStorage(dir);
  assert.equal(a.isEncryptionAvailable(), true);
  const sealed = a.encryptString('sk-secret');
  assert.ok(!sealed.includes('sk-secret'));
  assert.equal(fs.statSync(path.join(dir, 'safe-storage.key')).mode & 0o777, 0o600);
  assert.equal(createFileSafeStorage(dir).decryptString(sealed), 'sk-secret');
  assert.notDeepEqual(a.encryptString('sk-secret'), sealed, 'a fresh iv each time');
  sealed[sealed.length - 1] ^= 1;
  assert.throws(() => a.decryptString(sealed));
  // a key file that cannot be read is an error, not a new key over it
  const broken = fs.mkdtempSync(path.join(base, 'b-'));
  fs.mkdirSync(path.join(broken, 'safe-storage.key'));
  assert.throws(() => createFileSafeStorage(broken).encryptString('x'), /EISDIR/);
  // a key that is the wrong size is reported, never used
  const short = fs.mkdtempSync(path.join(base, 's-'));
  fs.writeFileSync(path.join(short, 'safe-storage.key'), 'abc');
  assert.throws(() => createFileSafeStorage(short).encryptString('x'), /damaged/);
  // the key is read once per instance
  const once = fs.mkdtempSync(path.join(base, 'o-'));
  const instance = createFileSafeStorage(once);
  instance.encryptString('a');
  const reads = mock.method(fs, 'readFileSync');
  try {
    instance.encryptString('b');
    instance.decryptString(instance.encryptString('c'));
    assert.equal(reads.mock.calls.length, 0);
  } finally {
    reads.mock.restore();
  }
  // two Hosts starting together: the one that lost the race reads the winner's key
  const raced = fs.mkdtempSync(path.join(base, 'r-'));
  const real = fs.readFileSync;
  let first = true;
  const winner = Buffer.alloc(32, 7);
  const read = mock.method(fs, 'readFileSync', (p: any, ...rest: any[]) => {
    if (String(p).endsWith('safe-storage.key') && first) {
      first = false;
      fs.writeFileSync(p, winner);
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return (real as any)(p, ...rest);
  });
  try {
    const sealedByLoser = createFileSafeStorage(raced).encryptString('x');
    assert.equal(createFileSafeStorage(raced).decryptString(sealedByLoser), 'x');
    assert.deepEqual(fs.readFileSync(path.join(raced, 'safe-storage.key')), winner);
  } finally {
    read.mock.restore();
  }
  // any other failure to create it is reported
  const noDir = fs.mkdtempSync(path.join(base, 'n-'));
  fs.writeFileSync(path.join(noDir, 'file'), '');
  assert.throws(() => createFileSafeStorage(path.join(noDir, 'file', 'config')).encryptString('x'));
  const nolink = fs.mkdtempSync(path.join(base, 'l-'));
  const link = mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('no hard links here'), { code: 'EPERM' });
  });
  try {
    assert.throws(() => createFileSafeStorage(nolink).encryptString('x'), /no hard links/);
    assert.deepEqual(fs.readdirSync(nolink), [], 'the staging file is removed');
  } finally {
    link.mock.restore();
  }
  const full = fs.mkdtempSync(path.join(base, 'f-'));
  const write = mock.method(fs, 'writeFileSync', () => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  try {
    assert.throws(() => createFileSafeStorage(full).encryptString('x'), /disk full/);
  } finally {
    write.mock.restore();
  }
});

test('the Claude API key is kept encrypted under the Host’s data dir through the shared auth module', () => {
  const data = fs.mkdtempSync(path.join(base, 'a-'));
  const config = path.join(data, 'config');
  const restore = installElectronPorts({ paths: { dataDir: data, configDir: config }, openExternal: async () => {} });
  try {
    const auth = createAuth({ sessions: () => [] }, { restartIdle: () => {} });
    auth.setApiKey('sk-ant-test-key-1234', '');
    const onDisk = fs.readFileSync(path.join(data, 'claude-api-key.json'), 'utf8');
    assert.ok(!onDisk.includes('sk-ant-test-key-1234'));
    assert.equal(createAuth({ sessions: () => [] }, { restartIdle: () => {} }).apiKeyInfo().hint, '1234');
  } finally {
    restore();
  }
});

test('the openExternal port reads what is installed each time, and null puts back the one that refuses', async () => {
  const opened: unknown[][] = [];
  const previous = installOpenExternal((url: string, ...rest: unknown[]) => void opened.push([url, ...rest]));
  try {
    await openExternal('https://a.test', { activate: true });
    assert.deepEqual(opened, [['https://a.test', { activate: true }]]);
    installOpenExternal(null);
    await assert.rejects(async () => openExternal('https://b.test'), /cannot open a link/);
  } finally {
    installOpenExternal(previous);
  }
});

test('the Host hands links to its own openExternal and puts the previous one back', async () => {
  const printed: string[] = [];
  const dir = fs.mkdtempSync(path.join(base, 'o-'));
  const before = installOpenExternal(() => void printed.push('previous'));
  const restore = installElectronPorts({
    paths: { dataDir: dir, configDir: path.join(dir, 'config') },
    openExternal: async (url: string) => void printed.push(url),
  });
  try {
    await openExternal('https://login.example.test');
    assert.deepEqual(printed, ['https://login.example.test']);
  } finally {
    restore();
  }
  await openExternal('https://after.test');
  assert.deepEqual(printed.slice(-1), ['previous']);
  installOpenExternal(before);
});
