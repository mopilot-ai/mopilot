// A packaged app loads only its own Rust core, and a Windows package only the one whose hash it was packaged with
// (electron/platform/core.cjs, docs/architecture/rust-core.md §8): no environment variable or checkout's build reaches the
// signed app, and Windows, which checks no signature when a library loads, gets the check here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { corePath, coreCheck, hostCoreRecord, loadCore, recordedHash, inPackagedApp, sha256Of } = require('../electron/platform/core.cjs');
const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');

/** What a library needs to be the core (`loadCore`), each doing nothing. */
const CORE_EXPORTS = {
  dispatch: async () => Buffer.alloc(0),
  dispatchCancellable: () => ({ id: 0, reply: Promise.resolve(Buffer.alloc(0)) }),
  cancel: () => false,
  dispatchSync: () => Buffer.alloc(0),
  subscribe: () => undefined,
  routes: (): string[] => [],
};

test('a packaged app loads its own copy only: no MOPILOT_CORE, no checkout build', () => {
  const shipped = path.join('/App/resources', 'core', 'mopilot_core.node');
  const o = { root: '/r', platform: 'win32', resources: '/App/resources', packaged: true };
  assert.equal(corePath({ ...o, env: { MOPILOT_CORE: 'C:\\evil.dll' }, exists: (f: string) => f === shipped }), shipped);
  assert.equal(corePath({ ...o, env: { MOPILOT_CORE: 'C:\\evil.dll' }, exists: () => false }), null);
  assert.equal(corePath({ ...o, env: {}, resources: '', exists: () => true }), null);
  // a developer's run still takes MOPILOT_CORE
  assert.equal(corePath({ ...o, packaged: false, env: { MOPILOT_CORE: '/x.node' } }), '/x.node');
});

test('a packaged app is one whose code sits in app.asar, on POSIX and Windows paths', () => {
  assert.equal(inPackagedApp('/Applications/MoPilot.app/Contents/Resources/app.asar/electron/platform'), true);
  assert.equal(inPackagedApp('C:\\Users\\me\\AppData\\Local\\Programs\\MoPilot\\resources\\app.asar\\electron\\platform'), true);
  assert.equal(inPackagedApp('/repo/electron/platform'), false);
  assert.equal(inPackagedApp(), false);
});

test('the addon loads when its hash is the recorded one, and not when it differs or a required one is missing', () => {
  clearIgnored();
  const addon = { ...CORE_EXPORTS, dispatch: async () => Buffer.from('[]') };
  const load = (o: object) => loadCore('/x', { exists: () => true, dlopen: (m: any) => (m.exports = addon), hashOf: () => 'aa', ...o });
  assert.equal(load({ expected: 'aa' }), addon);
  assert.equal(load({ expected: 'bb' }), null);
  assert.match(recentIgnored().at(-1)?.message ?? '', /its hash aa is not the one the app was packaged with \(bb\)/);
  assert.equal(load({ required: true }), null);
  // nothing recorded and none required: as before
  assert.equal(load({}), addon);
});

test("a file's hash is its SHA-256, and the recorded one is read from core-hash.json beside the loader", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'core-hash-'));
  const file = path.join(dir, 'mopilot_core.node');
  writeFileSync(file, 'bytes');
  assert.equal(sha256Of(file), createHash('sha256').update('bytes').digest('hex'));
  const read = (json: string) => (f: string) => (assert.match(f, /core-hash\.json$/), json);
  assert.equal(recordedHash(read('{"sha256":"abc"}')), 'abc');
  assert.equal(recordedHash(read('{"sha256":5}')), null);
  assert.equal(recordedHash(read('not json')), null);
  // a checkout has none
  assert.equal(recordedHash(), null);
});

test('a Host loads the addon its version carries, whatever MOPILOT_CORE says, and a packaged app never takes it', () => {
  const hosted = path.join('/home/u/.mopilot-host/versions/abc', 'host-core', 'mopilot_core.node');
  const exists = (f: string) => f === hosted;
  const root = '/home/u/.mopilot-host/versions/abc';
  assert.equal(corePath({ env: { MOPILOT_CORE: '/tmp/other.node' }, root, resources: '', exists, packaged: false }), hosted);
  // a version without one: as before
  assert.equal(
    corePath({ env: { MOPILOT_CORE: '/tmp/other.node' }, root, resources: '', exists: () => false, packaged: false }),
    '/tmp/other.node',
  );
  // a packaged app whose folder held a Host's addon loads only its own Resources/core
  assert.equal(corePath({ env: {}, root, resources: '/App/Resources', exists, packaged: true }), null);
});

test('a Host requires the hash its version records; a packaged app is checked as before', () => {
  const root = '/h';
  const hosted = path.join(root, 'host-core', 'mopilot_core.node');
  const record = { build: 'linux-x64-gnu', sha256: 'a'.repeat(64) };
  assert.deepEqual(coreCheck(hosted, { root, packaged: false, record, hash: null }), { expected: record.sha256, required: true });
  assert.deepEqual(
    coreCheck(hosted, { root, packaged: false, record: null, hash: null }),
    { expected: null, required: true },
    'no record is no load',
  );
  // the same path in a packaged app is not a Host's, and a checkout's build is checked only against a recorded hash
  assert.deepEqual(coreCheck(hosted, { root, packaged: true, platform: 'win32', record, hash: 'b' }), { expected: 'b', required: true });
  assert.deepEqual(coreCheck('/r/core.dylib', { root, packaged: false, platform: 'darwin', record, hash: null }), {
    expected: null,
    required: false,
  });
  assert.deepEqual(coreCheck(null), { expected: null, required: false }, 'this run, with no core');
  // a failed packaging run leaves its record in the checkout, which must not refuse the checkout's own build
  assert.deepEqual(coreCheck('/r/core.dylib', { root, packaged: false, platform: 'darwin', record, hash: 'left-over' }), {
    expected: null,
    required: false,
  });
  // with a record that does not hold a hash, or none at all
  const read = (text: string) => () => text;
  assert.deepEqual(hostCoreRecord(root, read(JSON.stringify(record))), record);
  assert.equal(hostCoreRecord(root, read('{}')), null);
  assert.equal(hostCoreRecord(root, read('not json')), null);
  assert.equal(hostCoreRecord('/nowhere'), null);
  const loaded: string[] = [];
  const m = loadCore(hosted, {
    exists: () => true,
    dlopen: (o: any, f: string) => (loaded.push(f), (o.exports = { dispatch() {} })),
    hashOf: () => 'c'.repeat(64),
    ...coreCheck(hosted, { root, packaged: false, record, hash: null }),
  });
  assert.equal(m, null, 'a changed file is not loaded');
  assert.deepEqual(loaded, []);
});
