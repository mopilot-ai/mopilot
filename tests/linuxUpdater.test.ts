// Linux packaged apps offer the correct architecture's download and leave active chats running during updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, setPlatform, make, responses, feedBody } from './support/updater/fixture.ts';

test('Linux update checks use their own stable and staff feeds, and install opens the package without a restart', async () => {
  setPlatform('linux');
  responses.fetchImpl = async () =>
    feedBody({
      schema: 1,
      releases: [],
      linuxReleases: [
        {
          version: '2.0.0',
          platform: 'linux',
          arch: process.arch,
          rolloutPct: 100,
          url: 'https://example.com/linux.deb',
          notes: 'Linux release',
          pub_date: '2026-11-01T00:00:00Z',
        },
      ],
    });
  const { u } = make();
  assert.equal(await u.ready, true);
  assert.equal(u.manual, true);
  assert.equal((await u.check()).status, 'ready');
  assert.equal(u.state.available.url, 'https://example.com/linux.deb');
  assert.equal(await u.install(), true);
  assert.equal(
    calls.some((call) => call[0] === 'quitAndInstall'),
    false,
  );
  assert.deepEqual(calls.at(-1), ['open', 'https://example.com/linux.deb']);
  u.configure({ auto: false, channel: 'beta' });
  assert.match(u.feedUrl(), new RegExp(`/api/update/linux/${process.arch}/1.2.3\\?`));
  responses.fetchImpl = async () => ({ status: 204 });
  assert.equal((await u.check()).status, 'idle');
  u.dispose();
});

test('Linux promoted stable updates retain their embedded version and open the deb package', async () => {
  setPlatform('linux');
  responses.fetchImpl = async () =>
    feedBody({
      schema: 1,
      releases: [],
      linuxReleases: [
        {
          version: '2.0.0-dogfood.12',
          platform: 'linux',
          arch: process.arch,
          rolloutPct: 100,
          url: 'https://example.com/linux-dogfood.12.deb',
          notes: 'Promoted Linux release',
          pub_date: '2026-11-01T00:00:00Z',
        },
      ],
    });
  const { u } = make();
  try {
    assert.equal(await u.ready, true);
    assert.equal((await u.check()).status, 'ready');
    assert.equal(u.state.available.version, '2.0.0-dogfood.12');
    assert.equal(await u.install(), true);
    assert.deepEqual(calls.at(-1), ['open', 'https://example.com/linux-dogfood.12.deb']);
    assert.equal(
      calls.some((call) => call[0] === 'quitAndInstall'),
      false,
    );
  } finally {
    u.dispose();
  }
});
