// The E2E app's stand-ins for a Linux desktop (tests/e2e/fixtures/linux-desktop.cjs): a keyring, so safeStorage
// encrypts, and a notification server, so the app shows notifications on a runner's virtual display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FIXTURE = require.resolve('./e2e/fixtures/linux-desktop.cjs');
const { standInForDesktop } = require(FIXTURE);

test('the fake desktop reports a keyring for app-flow tests and supports notifications', () => {
  const plain: boolean[] = [];
  const safeStorage = { setUsePlainTextEncryption: (on: boolean) => void plain.push(on), getSelectedStorageBackend: () => 'basic_text' };
  const Notification = { isSupported: () => false };
  standInForDesktop({ safeStorage, Notification });
  assert.deepEqual(plain, [true]);
  assert.equal(safeStorage.getSelectedStorageBackend(), 'gnome_libsecret');
  assert.equal(Notification.isSupported(), true);
});

test('loading it outside the main process (node, a child process) changes nothing', () => {
  // `electron` is not there to load: requiring it would throw, so the file must not touch it
  const run = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(FIXTURE)}); console.log('loaded')`], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'loaded');
});
