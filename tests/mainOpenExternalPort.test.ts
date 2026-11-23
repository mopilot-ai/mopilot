// Main installs its guarded shell behind the openExternal port (electron/main.cjs), so a shared module that opens a link through the port
// (the Claude Code /design-login) reaches Electron's shell exactly as it did when it required Electron itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

const require = createRequire(import.meta.url);
after(() => unloadMain());

test('a link opened through the port reaches Electron’s shell', async () => {
  const h = await loadMain();
  await h.ready();
  const { openExternal } = require('../electron/platform/ports/openExternal.cjs');
  await openExternal('https://claude.ai/login');
  assert.deepEqual(h.electron.shell.openExternal.mock.calls.at(-1).arguments, ['https://claude.ai/login']);
});
