// Installed rollback preserves exact package intent, native-stage revocation and retry ownership across desktop platforms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { make, checked, autoUpdater, responses, feedBody, calls, setPlatform, deferred } from './support/updater/fixture.ts';

const requestId = '87654321-abcd-4321-9876-123456789abc';
const bytes = Buffer.from('verified signed rollback package fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const rollback = (fromVersion: string) => ({ fromVersion, channel: 'stable', requestId });
function publish(source = '1.2.3', target = '1.2.0', enabled = true) {
  const entry = {
    version: target,
    platform: process.platform,
    arch: process.arch,
    rolloutPct: 100,
    url: `https://example.test/${target}.${process.platform === 'linux' ? 'deb' : 'zip'}`,
    notes: 'known good',
    pub_date: '2026-11-05T00:00:00Z',
    sha256,
    size: bytes.length,
  };
  responses.fetchImpl = async () =>
    feedBody({
      schema: 1,
      releases: process.platform === 'linux' ? [] : [entry],
      ...(process.platform === 'linux' && { linuxReleases: [entry] }),
      rollbacks: [{ version: source, channel: 'stable', targetVersion: target, requestId, enabled }],
    });
}
async function packageFile(t: any) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mopilot-rollback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollback.zip');
  await writeFile(file, bytes);
  return file;
}
async function staged(t: any, overrides: any = {}) {
  const file = await packageFile(t);
  const made = make({ download: async () => file, ...overrides });
  t.after(() => made.u.dispose());
  await checked(made.u);
  autoUpdater.emit('update-downloaded', {}, 'withdrawn', '2.0.0');
  return { ...made, file };
}

test('an installed macOS client verifies and stages the older exact package, then uses its ordinary safe exit gate', async (t) => {
  const file = await packageFile(t);
  let gated = false;
  const { u } = make({ download: async () => file, gate: async () => (gated = true) });
  t.after(() => u.dispose());
  publish();
  await checked(u);
  assert.equal(u.state.preparing, true);
  autoUpdater.emit('update-downloaded', {}, 'known good', '1.2.0');
  assert.deepEqual(u.state.available, { version: '1.2.0', notes: 'known good', rollback: rollback('1.2.3') });
  const fetches = calls.filter((c) => c[0] === 'fetch').length;
  await checked(u);
  assert.equal(calls.filter((c) => c[0] === 'serve').length, 1, 'the same rollback UUID is not installed repeatedly');
  assert.equal(calls.filter((c) => c[0] === 'fetch').length, fetches + 1);
  assert.equal(await u.install(), true);
  assert.equal(gated, true);
  assert.deepEqual(calls.at(-1), ['quitAndInstall']);
});

test('a withdrawn staged update is revoked before replacement; a failed download remains retryable without reviving it', async (t) => {
  const { u, file } = await staged(t, { idle: async () => false });
  assert.equal(await u.install({ when: 'idle' }), true);
  publish('2.0.0', '1.2.3');
  u.o.download = async () => {
    throw new Error('offline');
  };
  await checked(u);
  assert.equal(u.state.status, 'error');
  assert.equal(u.state.available, null);
  assert.match(u.state.error, /may still apply on restart.*offline/);
  assert.equal(u.state.restartWhenIdle, false);
  assert.equal(u.idleTimer, null);
  assert.equal(await u.install(), false);
  // The running version is already safe, but Squirrel still holds 2.0.0: a retry must remember that source.
  u.o.download = async () => file;
  await checked(u);
  assert.equal(u.state.preparing, true);
  autoUpdater.emit('update-downloaded', {}, 'known good', '1.2.3');
  assert.equal(u.state.status, 'ready');
  assert.deepEqual(u.state.available.rollback, rollback('2.0.0'));
  assert.equal(u.state.error, null);
});

test('a wrong rollback hash, wrong size or unreadable package never reaches the native installer', async (t) => {
  const file = await packageFile(t);
  for (const kind of ['hash', 'size', 'missing']) {
    const { u } = make({ download: async () => (kind === 'missing' ? `${file}.missing` : file) });
    publish();
    const fetch = responses.fetchImpl;
    responses.fetchImpl = async (url, init) => {
      const body = await (await fetch(url, init)).json();
      if (kind === 'hash') body.releases[0].sha256 = 'b'.repeat(64);
      if (kind === 'size') body.releases[0].size++;
      return feedBody(body);
    };
    await checked(u);
    assert.equal(u.state.status, 'error', kind);
    assert.match(u.state.error, kind === 'missing' ? /ENOENT/ : /did not match/);
    assert.equal(calls.filter((c) => c[0] === 'serve').length, 0);
    u.dispose();
    autoUpdater.removeAllListeners();
  }
});

test('a rollback native failure or late completion after timeout cannot revive the withdrawn stage', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { u } = await staged(t);
  publish('2.0.0', '1.2.3', false); // Pause still permits replacing a withdrawn staged package.
  await checked(u);
  autoUpdater.emit('error', new Error('signature refused'));
  assert.equal(u.state.status, 'error');
  assert.match(u.state.error, /may still apply on restart.*Signature refused/);
  await checked(u);
  t.mock.timers.tick(10 * 60_000);
  assert.equal(u.state.status, 'error');
  assert.equal(await u.install(), false);
  assert.match(u.state.error, /may still apply on restart.*timed out/);
  autoUpdater.emit('update-downloaded', {}, 'known good', '1.2.3');
  assert.equal(u.state.status, 'error', 'late unowned native completion cannot authorize restart');
  u.configure({ auto: false, channel: 'dogfood' });
  assert.match(u.feedUrl(), /staged=1.2.3/, 'another cohort sees the factual prepared target, not old-channel rollback metadata');
  u.configure({ auto: false, channel: 'stable' });
  await checked(u);
  assert.equal(u.state.preparing, true);
  autoUpdater.emit('update-downloaded', {}, 'known good', '1.2.3');
  assert.equal(u.state.status, 'ready');
});

test('a rollback download that finishes after channel change or dispose cannot stage a package', async (t) => {
  const file = await packageFile(t);
  for (const retire of ['channel', 'dispose']) {
    const download = deferred<string>();
    const { u } = make({ download: () => download.promise });
    publish();
    await u.check();
    if (retire === 'channel') u.configure({ auto: false, channel: 'beta' });
    else u.dispose();
    download.resolve(file);
    await u.downloadWork;
    assert.equal(calls.filter((c) => c[0] === 'serve').length, 0, retire);
    u.dispose();
    autoUpdater.removeAllListeners();
  }
});

test('a channel switch keeps the factual native stage as a hint and requires fresh rollback authority from the new cohort', async (t) => {
  const { u, file } = await staged(t, { token: async () => 'staff-token' });
  u.configure({ auto: false, channel: 'beta' });
  assert.match(u.feedUrl(), /staged=2.0.0/);
  responses.fetchImpl = async () =>
    feedBody({
      name: '1.2.3',
      notes: '',
      url: 'https://example.test/safe.zip',
      sha256,
      size: bytes.length,
      rollback: { ...rollback('2.0.0'), channel: 'beta' },
    });
  u.o.download = async () => {
    throw new Error('offline');
  };
  await checked(u);
  u.configure({ auto: false, channel: 'stable' });
  assert.equal(u.state.status, 'error', 'switching back cannot revive a stage known to be withdrawn');
  u.configure({ auto: false, channel: 'beta' });
  u.o.download = async () => file;
  await checked(u);
  assert.equal(u.state.preparing, true);
  autoUpdater.emit('update-downloaded', {}, 'safe', '1.2.3');
  assert.equal(u.state.status, 'ready');
  assert.equal(u.state.available.rollback.channel, 'beta');
});

for (const [platform, arch] of [
  ['win32', 'x64'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
]) {
  test(`${platform}/${arch} exposes an explicit older package and keeps the user initiated download flow`, async (t) => {
    setPlatform(platform);
    const originalArch = process.arch;
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
    t.after(() => Object.defineProperty(process, 'arch', { value: originalArch, configurable: true }));
    const { u } = make();
    t.after(() => u.dispose());
    publish();
    await u.check();
    assert.equal(u.state.status, 'ready');
    assert.deepEqual(u.state.available.rollback, rollback('1.2.3'));
    assert.equal(await u.install(), true);
    assert.deepEqual(calls.at(-1), ['open', `https://example.test/1.2.0.${platform === 'linux' ? 'deb' : 'zip'}`]);
    assert.equal(calls.filter((c) => c[0] === 'quitAndInstall').length, 0);
  });
}
