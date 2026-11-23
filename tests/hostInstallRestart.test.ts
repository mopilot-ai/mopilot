// An install over a Host that is already running (electron/host/install.cjs, #3130): the service ends up running the version just unpacked on Linux (systemd: `enable --now` leaves a running unit alone) and on macOS (launchd), and a fresh machine starts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SHA, bundle, machine, registry } from './support/host-install-kit.ts';
const require = createRequire(import.meta.url);
const { createInstaller } = require('../electron/host/install.cjs');

test('A1: installing over a Host that is already running makes the service run the new version, on Linux and on macOS; a fresh machine starts it', async () => {
  for (const os of ['Linux x86_64', 'Darwin arm64']) {
    const running = machine({ 'uname -sm': { stdout: `${os}\n` } });
    running.service.runningFrom = 'a'.repeat(64);
    const again = await createInstaller({ channel: running.channel, registry, bundle }).install('me@box');
    assert.equal(again.ok, true);
    assert.equal(running.service.runningFrom, SHA, `${os}: the running Host is the one just unpacked`);
    const fresh = machine({ 'uname -sm': { stdout: `${os}\n` } });
    await createInstaller({ channel: fresh.channel, registry, bundle }).install('me@box');
    assert.equal(fresh.service.runningFrom, SHA, `${os}: a fresh machine starts the new version`);
  }
});
