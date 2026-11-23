// GitHub stable manifests and authenticated restricted feeds through the real updater network boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { readUpdateFeed } = createRequire(import.meta.url)('../electron/updates/feed.cjs');
const { STABLE_FEED_URL } = createRequire(import.meta.url)('../shared/stableUpdates.cjs');
const base = {
  url: 'https://mopilot.ai/api/update/test',
  channel: 'stable',
  version: '1.0.0',
  platform: 'darwin',
  arch: 'arm64',
  installId: 'id',
  headers: { authorization: 'Bearer private' },
};
const row = {
  version: '2.0.0',
  platform: 'darwin',
  arch: 'arm64',
  rolloutPct: 100,
  url: 'https://github.com/o/r/releases/download/v2.0.0/app.zip',
  notes: 'New',
  pub_date: '2026-10-15T00:00:00Z',
};
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

test('stable polls GitHub without auth or install identity in the URL, selects an update and never falls back to the website', async () => {
  const calls: any[] = [];
  const result = await readUpdateFeed({
    ...base,
    fetch: async (...args: any[]) => (calls.push(args), json({ schema: 1, releases: [row] })),
  });
  assert.deepEqual(result, { url: row.url, name: row.version, notes: row.notes, pub_date: row.pub_date });
  assert.equal(calls[0][0], STABLE_FEED_URL);
  assert.deepEqual(calls[0][1].headers, { accept: 'application/json' });
  assert.equal(calls[0][1].cache, 'no-cache');
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  assert.equal(await readUpdateFeed({ ...base, fetch: async () => json({ schema: 1, releases: [] }) }), null);
  await assert.rejects(
    readUpdateFeed({ ...base, fetch: async () => ({ ok: false, status: 404 }) }),
    /raw.githubusercontent.com answered HTTP 404/,
  );
  assert.equal(calls.length, 1);
});

test('restricted feeds use the site with auth and retain optional metadata, 204, and malformed-file failures', async () => {
  const calls: any[] = [];
  const restricted = { ...base, channel: 'beta' };
  assert.equal(await readUpdateFeed({ ...restricted, fetch: async (...args: any[]) => (calls.push(args), { status: 204 }) }), null);
  assert.equal(calls[0][0], base.url);
  assert.deepEqual(calls[0][1].headers, { accept: 'application/json', ...base.headers });
  assert.deepEqual(await readUpdateFeed({ ...restricted, fetch: async () => json({ url: row.url }) }), {
    url: row.url,
    name: '',
    notes: '',
  });
  assert.deepEqual(
    await readUpdateFeed({ ...restricted, fetch: async () => json({ url: row.url, name: '2.0.0', notes: 'n', pub_date: row.pub_date }) }),
    { url: row.url, name: '2.0.0', notes: 'n', pub_date: row.pub_date },
  );
  for (const body of [null, {}, { url: 'http://insecure' }, { url: 'https://' }, { url: 'https://[broken' }])
    for (const platform of ['darwin', 'win32'])
      await assert.rejects(
        readUpdateFeed({ ...restricted, platform, fetch: async () => json(body) }),
        new RegExp(platform === 'win32' ? 'no installer' : 'no update file'),
      );
});

test('network failures, malformed JSON and corrupt manifests fail explicitly and can be retried', async () => {
  await assert.rejects(
    readUpdateFeed({
      ...base,
      fetch: async () => {
        throw new Error('offline');
      },
    }),
    /could not reach raw.githubusercontent.com. Offline/,
  );
  await assert.rejects(
    readUpdateFeed({
      ...base,
      fetch: async () => ({
        ok: true,
        json: async () => {
          throw new Error('bad json');
        },
      }),
    }),
    /raw.githubusercontent.com sent an update feed that could not be read.*bad json/,
  );
  await assert.rejects(readUpdateFeed({ ...base, fetch: async () => json(null) }), /Invalid stable update manifest/);
  assert.equal(await readUpdateFeed({ ...base, fetch: async () => json({ schema: 1, releases: [] }) }), null);
});
