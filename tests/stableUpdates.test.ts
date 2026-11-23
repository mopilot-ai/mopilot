// Public manifest validation, platform/version selection, and rollout fallbacks through the shared desktop policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const { selectStableUpdate: select, rolloutBucket, STABLE_FEED_URL } = createRequire(import.meta.url)('../shared/stableUpdates.cjs');
const context = { version: '1.0.0', platform: 'darwin', arch: 'arm64', installId: 'id' };
const row = (o: any = {}) => ({
  version: '2.0.0',
  platform: 'darwin',
  arch: 'arm64',
  rolloutPct: 100,
  url: 'https://github.com/o/r/releases/download/v2.0.0/app.zip',
  notes: '',
  pub_date: '2026-10-15T00:00:00Z',
  ...o,
});
const manifest = (rows: any[] = [row()]) => ({ schema: 1, releases: rows });

test('stable selects the newest eligible platform/architecture, with deterministic rollout fallback', () => {
  assert.match(STABLE_FEED_URL, /^https:\/\/raw.githubusercontent.com\/mopilot-ai\/mopilot-code-release\//);
  const old = row({ version: '1.1.0' });
  const m = manifest([old, row({ version: '9.0.0', arch: 'x64' }), row({ version: '3.0.0', rolloutPct: 0 }), row()]);
  assert.equal(select(m, context).name, '2.0.0');
  m.releases[3].rolloutPct = rolloutBucket('id', '2.0.0');
  assert.equal(select(m, context).name, '1.1.0', 'bucket equal to the percentage is excluded');
  assert.equal(select(m, { ...context, arch: 'x64' }).name, '9.0.0');
  assert.equal(select(m, { ...context, platform: 'win32' }), null);
  assert.equal(select(manifest([]), context), null);
  assert.equal(rolloutBucket('id'), createHash('sha256').update(':id').digest().readUInt32BE(0) % 100);
});

test('stable version comparisons handle numeric ordering, equal/lower versions, prerelease installs and large integers', () => {
  for (const [version, installed, wanted] of [
    ['1.10.0', '1.9.0', true],
    ['1.1.10', '1.1.9', true],
    ['1.1.0', '1.2.0', false],
    ['1.1.0', '2.0.0', false],
    ['1.1.0', '1.1.0', false],
    ['1.1.0', 'v1.1.0-beta.9', true],
    ['1.1.9007199254740993', '1.1.9007199254740992', true],
  ])
    assert.equal(!!select(manifest([row({ version })]), { ...context, version: installed }), wanted);
});

test('corrupt shape, fields, insecure URLs, prereleases and unsupported platforms fail instead of appearing up to date', () => {
  for (const m of [null, [], {}, { schema: 2, releases: [] }, { schema: 1, releases: null }])
    assert.throws(() => select(m, context), /Invalid stable update manifest/);
  for (const r of [
    null,
    [],
    row({ version: null }),
    row({ version: 'bad' }),
    row({ version: '2.0.0-beta.1' }),
    row({ platform: 'freebsd' }),
    row({ arch: 'ia32' }),
    row({ platform: 'win32', arch: 'arm64' }),
    ...[-1, 101, 1.5, null, '100'].map((rolloutPct) => row({ rolloutPct })),
    row({ url: null }),
    row({ url: 'http://x' }),
    row({ url: 'https://' }),
    row({ url: 'https://[broken' }),
    row({ notes: null }),
    row({ pub_date: null }),
    row({ pub_date: 'invalid' }),
  ])
    assert.throws(() => select(manifest([r]), context), /Invalid .*stable update manifest/);
  assert.throws(() => select(manifest(), { ...context, version: '' }), /Invalid version/);
  const selected = select({ ...manifest(), extra: true }, context);
  assert.deepEqual(selected, { url: row().url, name: '2.0.0', notes: '', pub_date: row().pub_date });
});

test('promoted builds keep their exact version, rollout and platform, without reinstalling themselves or downgrading', () => {
  const m = {
    ...manifest([row({ version: '1.1.0' })]),
    promotions: [
      row({ version: '2.0.0-dogfood.9' }),
      row({ version: '2.0.0-dogfood.10', rolloutPct: 0 }),
      row({ version: '3.0.0-dogfood.1', platform: 'win32', arch: 'x64' }),
    ],
  };
  assert.equal(select(m, context).name, '2.0.0-dogfood.9');
  assert.equal(select(m, { ...context, version: '2.0.0-dogfood.9' }), null);
  assert.equal(select(m, { ...context, version: '2.0.0' }), null);
  assert.equal(select(m, { ...context, platform: 'win32', arch: 'x64' }).name, '3.0.0-dogfood.1');
  m.promotions[0].rolloutPct = 0;
  assert.equal(select(m, context).name, '1.1.0');
  // A legacy schema-1 reader sees only compatible numeric versions in releases.
  assert.equal(select({ schema: 1, releases: m.releases }, context).name, '1.1.0');
  for (const promotions of [null, {}, 'bad', [row({ url: 'http://bad' })], [null]])
    assert.throws(() => select({ ...manifest(), promotions }, context), /Invalid/);
});

test('promotion ordering compares every prerelease identifier and preserves large numeric identity', () => {
  for (const [candidate, installed, wanted] of [
    ['2.0.0-dogfood.10', '2.0.0-dogfood.9', true],
    ['2.0.0-dogfood.9', '2.0.0-dogfood.10', false],
    ['2.0.0-dogfood.9007199254740993', '2.0.0-dogfood.9007199254740992', true],
    ['2.0.0-dogfood.1', '2.0.0-dogfood.01', false],
    ['2.0.0-beta.1', '2.0.0-dogfood.1', false],
    ['2.0.0-dogfood.1', '2.0.0-beta.1', true],
    ['2.0.0-dogfood', '2.0.0-dogfood.1', false],
    ['2.0.0-dogfood.1', '2.0.0-dogfood', true],
    ['2.0.0-dogfood.1', '2.0.0-dogfood.x', false],
    ['2.0.0-dogfood.x', '2.0.0-dogfood.1', true],
    ['2.0.0-dogfood.1', '2.0.0', false],
    ['2.0.0-dogfood.1', '2.0.0-dogfood.1', false],
  ])
    assert.equal(
      !!select({ schema: 1, releases: [], promotions: [row({ version: candidate })] }, { ...context, version: installed }),
      wanted,
    );
  const m = {
    schema: 1,
    releases: [],
    promotions: ['2.0.0-dogfood.3', '2.0.0-dogfood.12', '2.0.0-dogfood.9'].map((version) => row({ version })),
  };
  assert.equal(select(m, context).name, '2.0.0-dogfood.12');
});

test('Linux stable and promoted updates retain both architectures, exact versions and rollout fallback', () => {
  for (const arch of ['x64', 'arm64']) {
    const current = { ...context, platform: 'linux', arch };
    const stable = row({ platform: 'linux', arch, version: '1.1.0' });
    const promoted = row({ platform: 'linux', arch, version: '2.0.0-dogfood.9', url: `https://github.com/o/r/linux-${arch}.deb` });
    const other = row({ platform: 'linux', arch: arch === 'x64' ? 'arm64' : 'x64', version: '99.0.0' });
    const m = { ...manifest([row({ version: '99.0.0' })]), linuxReleases: [stable, promoted, other] };
    assert.equal(select(m, current).url, promoted.url);
    assert.equal(select(m, { ...current, version: promoted.version }), null);
    promoted.rolloutPct = rolloutBucket('id', promoted.version);
    assert.equal(select(m, current).name, stable.version, 'an excluded promotion retains the stable fallback');
    assert.equal(select({ ...manifest([]), linuxReleases: [stable] }, current).name, stable.version);
    const exact = row({ platform: 'linux', arch, version: '2.0.0-dogfood.9007199254740993' });
    assert.equal(
      select({ ...manifest([]), linuxReleases: [exact] }, { ...current, version: '2.0.0-dogfood.9007199254740992' }).name,
      exact.version,
    );
  }
});

test('Linux promotion validation rejects malformed and foreign rows before returning any update', () => {
  const current = { ...context, platform: 'linux', arch: 'x64' };
  const promoted = row({ platform: 'linux', arch: 'x64', version: '2.0.0-dogfood.1' });
  for (const invalid of [
    { ...promoted, arch: 'ia32' },
    { ...promoted, platform: 'freebsd' },
    { ...promoted, version: 'broken' },
    { ...promoted, rolloutPct: 101 },
    { ...promoted, url: 'http://insecure.test/app' },
    { ...promoted, platform: 'win32', arch: 'arm64' },
    { ...promoted, platform: 'darwin' },
    null,
    [],
  ])
    assert.throws(() => select({ ...manifest([]), linuxReleases: [promoted, invalid] }, current), /Invalid/);
  for (const linuxReleases of [null, {}, 'bad'])
    assert.throws(() => select({ ...manifest([]), linuxReleases }, current), /Invalid stable update manifest/);
  assert.throws(() => select({ ...manifest([]), promotions: [promoted] }, current), /Invalid release/);
  assert.equal(select(manifest([]), current), null);
});
