// Whether updates land is reported once per update, and never as a first install or an unrecorded version.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const { recordActivation, reportInstalledVersion, takeActivationFailure, updateFailure, failureWatcher } = createRequire(import.meta.url)(
  '../electron/updates/outcome.cjs',
);

function scratch(t: TestContext) {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'update-outcome-'));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  const tracked: unknown[][] = [];
  const start = (version: string, dir = userData) =>
    reportInstalledVersion({ userData: dir, version, channel: 'beta', track: (...a: unknown[]) => tracked.push(a) });
  return { userData, tracked, start };
}

test('accepted activation reports the offered version once when the previous app reopens', (t) => {
  const { userData } = scratch(t);
  recordActivation(userData, '2.0.0', 'beta');
  assert.deepEqual(takeActivationFailure(userData, '1.0.0'), { stage: 'install', version: '2.0.0', channel: 'beta' });
  assert.equal(takeActivationFailure(userData, '1.0.0'), null);
  recordActivation(userData, '2.0.0', 'beta');
  assert.equal(takeActivationFailure(userData, '2.0.0'), null);
  recordActivation(path.join(userData, 'missing'), '2.0.0', 'beta');
  for (const bad of [
    'invalid',
    '{}',
    '{"version":"invalid","channel":"beta"}',
    '{"version":"3.0.0"}',
    '{"version":"3.0.0","channel":"other"}',
  ]) {
    writeFileSync(path.join(userData, 'pending-mac-update.json'), bad);
    assert.equal(takeActivationFailure(userData, '2.0.0'), null);
  }
});

test('a first install reports nothing; a new version reports once, with where it came from', (t) => {
  const { tracked, start } = scratch(t);
  start('1.0.0');
  assert.deepEqual(tracked, []);
  start('1.0.0');
  assert.deepEqual(tracked, []);
  start('1.1.0');
  start('1.1.0');
  assert.deepEqual(tracked, [['update_installed', { from: '1.0.0', version: '1.1.0', channel: 'beta' }]]);
});

test('an unreadable record is treated as a first run', (t) => {
  const { userData, tracked, start } = scratch(t);
  for (const text of ['not json', '{"version":5}']) {
    writeFileSync(path.join(userData, 'installed-version'), text);
    start('2.0.0');
  }
  assert.deepEqual(tracked, []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(userData, 'installed-version'), 'utf8')), { version: '2.0.0' });
});

test('a record that cannot be written reports nothing, or it would report at every start', (t) => {
  const { userData, tracked, start } = scratch(t);
  start('1.0.0');
  const gone = path.join(userData, 'missing');
  start('1.1.0', gone);
  assert.deepEqual(tracked, []);
  assert.equal(existsSync(gone), false);
  mkdirSync(path.join(userData, 'dir'));
  const unread = path.join(userData, 'dir');
  mkdirSync(path.join(unread, 'installed-version'));
  start('1.1.0', unread);
  assert.deepEqual(tracked, []);
});

test('a failure is read from how the updater left a stage', () => {
  const downloading = { status: 'downloading', error: null, preparing: false, progress: { version: '2.0.0' } };
  assert.deepEqual(updateFailure(downloading, { status: 'error', error: 'no network' }), { stage: 'download', version: '2.0.0' });
  assert.deepEqual(updateFailure({ ...downloading, preparing: true }, { status: 'error', error: 'bad signature' }), {
    stage: 'prepare',
    version: '2.0.0',
  });
  assert.deepEqual(
    updateFailure({ status: 'installing', error: null }, { status: 'ready', error: 'no restart', available: { version: '2.0.0' } }),
    { stage: 'install', version: '2.0.0' },
  );
  assert.deepEqual(updateFailure({ status: 'installing', available: { version: '2.0.0' } }, { status: 'error', error: 'handoff failed' }), {
    stage: 'install',
    version: '2.0.0',
  });
  assert.deepEqual(updateFailure({ status: 'installing' }, { status: 'error', error: 'handoff failed' }), {
    stage: 'install',
    version: undefined,
  });
});

test('a failed check, a kept warning, and finishing cleanly are not failures', () => {
  assert.equal(updateFailure({ status: 'checking', error: null }, { status: 'error', error: 'offline' }), null);
  assert.equal(updateFailure({ status: 'downloading', error: 'old channel' }, { status: 'ready', error: 'old channel' }), null);
  assert.equal(updateFailure({ status: 'downloading', error: null }, { status: 'ready', error: null }), null);
  assert.equal(updateFailure({ status: 'downloading', error: null }, { status: 'downloading', error: 'warning' }), null);
});

test('a stage counts once per version, and a failure naming no version not at all', () => {
  const seen: unknown[] = [];
  const watch = failureWatcher((f: unknown) => seen.push(f));
  const fail = (version?: string, preparing = false) => {
    watch({ status: 'downloading', error: null, preparing, progress: version && { version } });
    watch({ status: 'error', error: 'failed' });
  };
  fail('2.0.0');
  fail('2.0.0');
  fail('2.0.0', true);
  fail('2.0.1');
  fail(undefined);
  assert.deepEqual(seen, [
    { stage: 'download', version: '2.0.0' },
    { stage: 'prepare', version: '2.0.0' },
    { stage: 'download', version: '2.0.1' },
  ]);
});
