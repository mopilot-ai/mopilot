// Stable GitHub checks reach the real main-process updater on macOS and Windows without reading account tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, autoUpdater, make, checked, responses, setPlatform, feedBody } from './support/updater/fixture.ts';

test('stable main-process checks use the public manifest and download GitHub assets on both platforms', async () => {
  const originalArch = process.arch;
  try {
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    for (const platform of ['darwin', 'win32']) {
      calls.length = 0;
      setPlatform(platform);
      const url = `https://github.com/mopilot-ai/mopilot-code-release/releases/download/v2.0.0/app.${platform === 'win32' ? 'exe' : 'zip'}`;
      responses.fetchImpl = async () =>
        feedBody({
          schema: 1,
          releases: [{ version: '2.0.0', platform, arch: 'x64', rolloutPct: 100, url, notes: 'n', pub_date: '2026-10-15T00:00:00Z' }],
        });
      const { u } = make({ token: async () => assert.fail('stable must not read a private account token') });
      await checked(u);
      assert.deepEqual(calls[0], [
        'fetch',
        'https://raw.githubusercontent.com/mopilot-ai/mopilot-code-release/main/updates/stable.json',
        { accept: 'application/json' },
      ]);
      if (platform === 'darwin') {
        assert.deepEqual(calls[1], ['download', url, {}]);
        autoUpdater.emit('update-not-available');
      } else {
        assert.equal(u.state.status, 'ready');
        assert.equal(u.state.available.url, url);
        assert.equal(await u.install(), true);
        assert.deepEqual(calls.at(-1), ['open', url]);
      }
      u.dispose();
    }
  } finally {
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
  }
});
