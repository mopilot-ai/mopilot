// Installed rollback binds downgrade authorization to the running or staged version and exact update channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { selectStableUpdate } = createRequire(import.meta.url)('../shared/stableUpdates.cjs');
const { rollbackPolicies, validateRollbackOffer } = createRequire(import.meta.url)('../shared/releaseRollback.cjs');
const { readUpdateFeed } = createRequire(import.meta.url)('../electron/updates/feed.cjs');
const requestId = '87654321-abcd-4321-9876-123456789abc';
const release = (version: string): any => ({
  version,
  platform: 'darwin',
  arch: 'arm64',
  rolloutPct: 100,
  url: `https://github.com/o/r/releases/download/v${version}/app.zip`,
  notes: '',
  pub_date: '2026-11-05T00:00:00Z',
  sha256: 'a'.repeat(64),
  size: 200,
});
const manifest = {
  schema: 1,
  releases: [release('1.9.0')],
  rollbacks: [{ version: '2.0.0', targetVersion: '1.9.0', channel: 'stable', requestId, enabled: true }],
};

test('rollback JSON rejects array values that regex coercion would otherwise mistake for package authority', () => {
  const policy = manifest.rollbacks[0];
  assert.throws(() => rollbackPolicies([{ ...policy, requestId: [requestId] }]), /Invalid rollback/);
  const context = { version: '2.0.0', channel: 'stable', platform: 'darwin', arch: 'arm64', installId: 'install' };
  assert.throws(
    () => selectStableUpdate({ ...manifest, releases: [{ ...release('1.9.0'), sha256: ['a'.repeat(64)] }] }, context),
    /unavailable/,
  );
  const update = {
    name: '1.9.0',
    sha256: 'a'.repeat(64),
    size: 200,
    rollback: { fromVersion: '2.0.0', channel: 'stable', requestId: [requestId] },
  };
  assert.throws(() => validateRollbackOffer(update, context), /Invalid rollback/);
});

test('stable polling explicitly rolls an affected installed client back without changing its artifact version', () => {
  const context = { version: '2.0.0', platform: 'darwin', arch: 'arm64', installId: 'install' };
  const result = selectStableUpdate(manifest, context);
  assert.equal(result?.name, '1.9.0');
  assert.deepEqual(result?.rollback, { fromVersion: '2.0.0', channel: 'stable', requestId });
  assert.equal(selectStableUpdate(manifest, { ...context, version: '1.9.0' }), null);
});

test('rollback scope is exact, running identity wins, and pause blocks redelivery while replacing an unsafe staged copy', () => {
  const context = { version: '1.0.0', platform: 'darwin', arch: 'arm64', installId: 'install' };
  const policy = manifest.rollbacks[0];
  const m = { ...manifest, releases: [...manifest.releases, release('2.0.0'), release('3.0.0')] };
  assert.equal(selectStableUpdate(m, context).name, '3.0.0');
  assert.equal(selectStableUpdate({ ...m, releases: m.releases.slice(0, 2) }, { ...context, version: '1.9.0' }), null);
  assert.equal(selectStableUpdate(m, { ...context, stagedVersion: '2.0.0' }).name, '1.9.0');
  const paused = { ...m, rollbacks: [{ ...policy, enabled: false }] };
  assert.equal(selectStableUpdate(paused, { ...context, version: '2.0.0' }).name, '3.0.0');
  assert.equal(selectStableUpdate(paused, { ...context, version: '2.0.0', stagedVersion: '2.0.0' }).name, '1.9.0');
  const two = {
    ...m,
    rollbacks: [policy, { ...policy, version: '3.0.0', targetVersion: '1.8.0' }],
    releases: [...m.releases, release('1.8.0')],
  };
  assert.equal(selectStableUpdate(two, { ...context, version: '2.0.0', stagedVersion: '3.0.0' }).name, '1.9.0');
});

test('malformed rules, duplicates, private stable rules and unavailable or unchecked targets fail visibly', () => {
  const p = manifest.rollbacks[0],
    context = { version: p.version, platform: 'darwin', arch: 'arm64', installId: 'install' };
  for (const value of [null, {}, 'bad']) assert.throws(() => rollbackPolicies(value), /Invalid rollback/);
  for (const value of [
    null,
    [],
    {},
    { ...p, channel: 'prod' },
    { ...p, enabled: null },
    { ...p, requestId: 'bad' },
    { ...p, version: null },
    { ...p, targetVersion: 'bad' },
    { ...p, targetVersion: p.version },
    { ...p, targetVersion: '3.0.0' },
  ])
    assert.throws(() => rollbackPolicies([value]), /Invalid rollback/);
  assert.throws(() => rollbackPolicies([p, p]), /Duplicate/);
  assert.throws(() => selectStableUpdate({ ...manifest, rollbacks: [{ ...p, channel: 'beta' }] }, context), /Private rollback/);
  for (const r of [
    null,
    release('1.8.0'),
    { ...release('1.9.0'), rolloutPct: 0 },
    { ...release('1.9.0'), sha256: undefined },
    { ...release('1.9.0'), sha256: 'bad' },
    ...[undefined, 0, -1, 0.5, '200'].map((size) => ({ ...release('1.9.0'), size })),
  ])
    assert.throws(() => selectStableUpdate({ ...manifest, releases: r ? [r] : [] }, context), /Rollback target.*unavailable/);
  assert.throws(
    () => selectStableUpdate({ ...manifest, rollbacks: [p, { ...p, version: '1.9.0', targetVersion: '1.8.0', enabled: false }] }, context),
    /unavailable/,
  );
});

test('restricted feeds validate downgrade intent against this client or its staged artifact, including package identity', async () => {
  const context = { version: '2.0.0', channel: 'dogfood', stagedVersion: undefined };
  const r = release('1.9.0');
  const update = {
    name: r.version,
    url: r.url,
    sha256: r.sha256,
    size: r.size,
    rollback: { fromVersion: context.version, channel: context.channel, requestId },
  };
  validateRollbackOffer(update, context);
  validateRollbackOffer(update, { ...context, version: '1.8.0', stagedVersion: '2.0.0' });
  validateRollbackOffer({ name: '3.0.0' }, context);
  for (const bad of [
    { name: '1.9.0' },
    { ...update, rollback: null },
    { ...update, rollback: { ...update.rollback, channel: 'beta' } },
    { ...update, rollback: { ...update.rollback, requestId: 'bad' } },
    { ...update, rollback: { ...update.rollback, fromVersion: '3.0.0' } },
    { ...update, rollback: {} },
    { ...update, name: '2.0.0' },
    { ...update, sha256: 'bad' },
    { ...update, size: 0 },
  ])
    assert.throws(() => validateRollbackOffer(bad, context), /rollback authorization/i);
  const result = await readUpdateFeed({
    ...context,
    url: 'https://mopilot.ai/feed',
    platform: 'darwin',
    arch: 'arm64',
    installId: 'id',
    headers: {},
    fetch: async () => ({ ok: true, json: async () => update }),
  });
  assert.deepEqual(result.rollback, update.rollback);
  assert.equal(result.sha256, r.sha256);
});
