// Automatic update discovery reaches the feed and download for every release channel and desktop platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoUpdater, calls, make, feedBody, responses, setPlatform } from './support/updater/fixture.ts';
import { tick as flush } from './support/async-scenarios.ts';

for (const platform of ['darwin', 'win32']) {
  for (const channel of ['stable', 'beta', 'dogfood']) {
    test(`${platform}/${channel}: an update published after startup reaches the update action on the next minute`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      t.mock.method(Math, 'random', () => 0);
      setPlatform(platform);
      const arch = process.arch;
      Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
      t.after(() => Object.defineProperty(process, 'arch', { value: arch, configurable: true }));
      let published = false;
      let checks = 0;
      const url = `https://example.test/${platform}/${channel}/2.0.0.${platform === 'darwin' ? 'zip' : 'exe'}`;
      responses.fetchImpl = async () => {
        checks++;
        if (channel !== 'stable') return published ? feedBody({ url, name: '2.0.0', notes: 'New release' }) : { status: 204 };
        return feedBody({
          schema: 1,
          releases: published
            ? [
                {
                  version: '2.0.0',
                  platform,
                  arch: process.arch,
                  url,
                  notes: 'New release',
                  rolloutPct: 100,
                  pub_date: '2026-10-21T00:00:00Z',
                },
              ]
            : [],
        });
      };
      const { u } = make({ token: async () => 'staff-token' });
      t.after(() => u.dispose());
      await u.ready;
      u.configure({ auto: true, channel });
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(checks, 1);
      assert.equal(u.state.status, 'idle');

      published = true;
      const expectedFeed = u.feedUrl(channel);
      t.mock.timers.tick(59_999);
      await flush();
      assert.equal(checks, 1);
      t.mock.timers.tick(1);
      await flush();
      await u.downloadWork;
      assert.equal(checks, 2, 'discover the release without waiting four hours or requiring a manual check');
      assert.equal(calls.filter((call) => call[0] === 'fetch').at(-1)[1], expectedFeed);
      if (platform === 'darwin') {
        assert.deepEqual(
          calls.find((call) => call[0] === 'download'),
          ['download', url, {}],
        );
        assert.equal(u.state.preparing, true);
        autoUpdater.emit('update-downloaded', {}, 'New release', '2.0.0');
      } else {
        assert.equal(u.state.available.url, url);
      }
      assert.equal(u.state.status, 'ready');
      assert.equal(u.state.available.version, '2.0.0');
      t.mock.timers.tick(60_000);
      await flush();
      assert.equal(
        calls.filter((call) => call[0] === 'fetch').at(-1)[1],
        u.feedUrl(channel),
        'ready checks carry the staged version on restricted feeds',
      );
    });
  }
}
