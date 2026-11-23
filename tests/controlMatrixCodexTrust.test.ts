// CM-L18 (#1346), electron/harness/codexTrust.cjs: a Codex thread MoPilot starts carries its folder's trust in its own
// config, so the app-server does not write it into the user's ~/.codex/config.toml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/harness/'];

const require = createRequire(import.meta.url);
const { userTrust, userDecides, withTrust, TRUST_LEVEL } = require('../electron/harness/codexTrust.cjs');

test('CM-L18: a writable thread in a folder gets that folder trusted in its own config, next to the config it has', () => {
  const out = withTrust({ cwd: '/work/app', sandbox: 'workspace-write', config: { model_providers: { p: {} } } }, {});
  assert.deepEqual(out.config, { model_providers: { p: {} }, projects: { '/work/app': { trust_level: TRUST_LEVEL } } });
  assert.deepEqual(withTrust({ cwd: '/work/app' }, {}).config, { projects: { '/work/app': { trust_level: 'trusted' } } });
  // the key is the folder as given, with dots and all
  assert.deepEqual(Object.keys(withTrust({ cwd: '/work/my.app v1', sandbox: 'danger-full-access' }, {}).config.projects), [
    '/work/my.app v1',
  ]);
  // other trust entries a window sent stay
  const kept = withTrust({ cwd: '/w', config: { projects: { '/other': { trust_level: 'untrusted' } } } }, {});
  assert.deepEqual(kept.config.projects, { '/other': { trust_level: 'untrusted' }, '/w': { trust_level: 'trusted' } });
});

test('CM-L18: read-only threads, starts without an absolute folder, and a decision already made are left alone', () => {
  const same = (p: any, t = {}) => assert.equal(withTrust(p, t), p);
  same({ cwd: '/w', sandbox: 'read-only' });
  same({ sandbox: 'workspace-write' });
  same({ cwd: 'relative/dir' });
  same({ cwd: 42 });
  // the window chose a trust for this very folder
  same({ cwd: '/w', config: { projects: { '/w': { trust_level: 'untrusted' } } } });
  // the user's own config decides the folder, or one above it (Codex keys trust by git root)
  same({ cwd: '/w/sub' }, { '/w': 'untrusted' });
  same({ cwd: '/w' }, { '/w': 'trusted' });
  same({ cwd: '/w' }, { '/': 'untrusted' });
  assert.equal(withTrust(undefined, {}).config, undefined);
  assert.equal(withTrust(null, {}).config, undefined);
  // a folder the user's config does not mention is not decided
  assert.ok(withTrust({ cwd: '/w' }, { '/elsewhere': 'untrusted' }).config);
  // a config of the wrong shape is treated as none
  assert.ok(withTrust({ cwd: '/w', config: 'x' as any }, {}).config.projects['/w']);
});

test("CM-L18: the user's folder-trust entries come from config/read, and only the ones with a trust level", () => {
  assert.deepEqual(
    userTrust({ config: { projects: { '/a': { trust_level: 'trusted' }, '/b': {}, '/c': null, '/d': { trust_level: 'untrusted' } } } }),
    { '/a': 'trusted', '/d': 'untrusted' },
  );
  assert.deepEqual(userTrust({ config: { projects: [] } }), {});
  assert.deepEqual(userTrust({ config: {} }), {});
  assert.deepEqual(userTrust(null), {});
  assert.equal(userDecides('/a/b/c', { '/a': 'trusted' }), true);
  assert.equal(userDecides('/a/b/c', {}), false);
});
