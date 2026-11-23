// A release that publishes several versions installs only the newest: a newer version replaces a ready update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, autoUpdater, app, make, checked, deferred, feedBody, responses, setPlatform } from './support/updater/fixture.ts';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** The stable manifest offering one version for this platform, or none. */
function publish(version: string | null) {
  responses.fetchImpl = async () =>
    feedBody({
      schema: 1,
      releases: version
        ? [
            {
              version,
              platform: process.platform,
              arch: process.platform === 'win32' ? 'x64' : process.arch,
              rolloutPct: 100,
              url: `https://example.test/dl/${version}.${process.platform === 'win32' ? 'exe' : 'zip'}`,
              notes: `notes ${version}`,
              pub_date: '2026-10-21T00:00:00Z',
            },
          ]
        : [],
    });
}

/** A macOS updater with `version` downloaded and unpacked by Squirrel. */
async function readyMac(version: string, o: any = {}) {
  publish(version);
  const made = make(o);
  await checked(made.u);
  autoUpdater.emit('update-downloaded', {}, `notes ${version}`, version);
  assert.equal(made.u.state.status, 'ready');
  calls.length = 0;
  made.seen.length = 0;
  return made;
}

const downloads = () => calls.filter((c) => c[0] === 'download').map((c) => c[1]);

test('macOS: a version published after one is ready replaces it before the restart, without a second upgrade', async () => {
  const { u, seen } = await readyMac('2.0.0');
  try {
    // the same version again, or a CDN that still serves an older one, keeps the ready update and shows nothing
    for (const version of ['2.0.0', '1.9.0', null]) {
      publish(version);
      assert.equal((await checked(u)).status, 'ready');
    }
    assert.deepEqual(downloads(), []);
    assert.equal(calls.filter((c) => c[0] === 'checkForUpdates').length, 0);
    assert.deepEqual(seen, [], 'a check while ready never flashes Checking');

    publish('2.1.0');
    await checked(u);
    assert.deepEqual(downloads(), ['https://example.test/dl/2.1.0.zip']);
    assert.equal(u.state.status, 'downloading', 'the older update is no longer offered for a restart');
    assert.equal(u.state.progress.version, '2.1.0');
    autoUpdater.emit('update-downloaded', {}, 'notes 2.1.0', '2.1.0');
    assert.equal(u.state.status, 'ready');
    assert.deepEqual(u.state.available, { version: '2.1.0', notes: 'notes 2.1.0' });
    assert.equal(u.state.error, null);
  } finally {
    u.dispose();
  }
});

test('Windows: a newer version replaces the offered installer without flashing Checking', async (t) => {
  setPlatform('win32');
  const arch = process.arch;
  Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
  t.after(() => Object.defineProperty(process, 'arch', { value: arch, configurable: true }));
  publish('2.0.0');
  const { u, seen } = make();
  try {
    await u.check();
    assert.equal(u.state.available.version, '2.0.0');
    seen.length = 0;
    for (const version of ['2.0.0', null]) {
      publish(version);
      await u.check();
    }
    responses.fetchImpl = async () => ({ status: 500, ok: false });
    await assert.rejects(u.check(), /500/);
    assert.deepEqual(seen, []);
    publish('2.1.0');
    await u.check();
    assert.equal(u.state.status, 'ready');
    assert.deepEqual(u.state.available, { version: '2.1.0', notes: 'notes 2.1.0', url: 'https://example.test/dl/2.1.0.exe' });
    assert.ok((seen as any[]).every((s) => s.status === 'ready'));
    assert.equal(await u.install(), true);
    assert.deepEqual(calls.at(-1), ['open', 'https://example.test/dl/2.1.0.exe']);
  } finally {
    u.dispose();
  }
});

test('macOS: a replacement that fails offers the ready update again, with why', async () => {
  // a failed feed read shows nothing (the ready update stays as it was) and reaches the schedule, which backs off
  {
    const { u, seen } = await readyMac('2.0.0');
    responses.fetchImpl = async () => {
      throw new Error('offline');
    };
    await assert.rejects(u.check(), /offline/i);
    assert.equal(u.state.status, 'ready');
    assert.equal(u.state.error, null);
    assert.deepEqual(seen, []);
    assert.equal(u.refreshing, false);
    u.dispose();
    autoUpdater.removeAllListeners();
  }
  // the newer download fails
  {
    const { u } = await readyMac('2.0.0', {
      download: async (o: any) => {
        if (o.url.includes('2.1.0')) throw new Error('download broke');
        return '/tmp/update.zip';
      },
    });
    publish('2.1.0');
    await checked(u);
    assert.equal(u.state.status, 'ready');
    assert.equal(u.state.available.version, '2.0.0');
    assert.equal(u.state.error, 'download broke');
    u.dispose();
    autoUpdater.removeAllListeners();
  }
  // Squirrel cannot unpack the newer one
  {
    const { u } = await readyMac('2.0.0');
    publish('2.1.0');
    await checked(u);
    autoUpdater.emit('error', new Error('code signature invalid'));
    assert.equal(u.state.status, 'ready');
    assert.equal(u.state.available.version, '2.0.0');
    assert.equal(u.state.error, 'Code signature invalid.');
    u.dispose();
  }
});

test('macOS: Restart when idle restarts into the newer update once it is ready, never the one it replaced', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let idle = false;
  const { u } = await readyMac('2.0.0', { idle: async () => idle, gate: async () => true });
  try {
    assert.equal(await u.install({ when: 'idle' }), true);
    publish('2.1.0');
    await checked(u);
    assert.equal(u.state.status, 'downloading');
    idle = true;
    t.mock.timers.tick(3000);
    await flush();
    assert.deepEqual(
      calls.filter((c) => c[0] === 'quitAndInstall'),
      [],
    );
    assert.equal(u.state.restartWhenIdle, true, 'still waits to restart');
    autoUpdater.emit('update-downloaded', {}, 'notes 2.1.0', '2.1.0');
    t.mock.timers.tick(3000);
    await flush();
    assert.deepEqual(calls.at(-1), ['quitAndInstall']);
    assert.equal(u.state.available.version, '2.1.0');
    assert.equal(u.idleTimer, null);
  } finally {
    u.dispose();
  }
});

test('a check while ready leaves a restart awaiting the exit gate alone', async () => {
  const gate = deferred<boolean>();
  const { u } = await readyMac('2.0.0', { gate: () => gate.promise });
  try {
    const install = u.install();
    publish('2.1.0');
    await checked(u);
    assert.deepEqual(calls, []);
    gate.resolve(true);
    assert.equal(await install, true);
    assert.deepEqual(calls, [['quitAndInstall']]);
  } finally {
    u.dispose();
  }
});

test('a restart asked for while a check reads the feed wins over the newer version it finds', async () => {
  const feed = deferred<any>();
  const gate = deferred<boolean>();
  const { u } = await readyMac('2.0.0', { gate: () => gate.promise });
  try {
    responses.fetchImpl = () => feed.promise;
    const check = u.check();
    const install = u.install();
    publish('2.1.0');
    feed.resolve(await responses.fetchImpl('', {}));
    await check;
    assert.deepEqual(downloads(), []);
    gate.resolve(true);
    assert.equal(await install, true);
  } finally {
    u.dispose();
  }
});

test('overlapping checks while ready read the feed once; a channel change or dispose retires the read', async () => {
  for (const retire of ['none', 'channel', 'dispose']) {
    const feed = deferred<any>();
    const { u } = await readyMac('2.0.0', { token: async () => null });
    responses.fetchImpl = () => feed.promise;
    const first = u.check();
    const second = u.check();
    await flush();
    assert.equal(calls.filter((c) => c[0] === 'fetch').length, 1, retire);
    if (retire === 'channel') u.configure({ auto: false, channel: 'beta' });
    if (retire === 'dispose') u.dispose();
    publish('2.1.0');
    feed.resolve(await responses.fetchImpl('', {}));
    await Promise.all([first, second]);
    await u.downloadWork;
    assert.deepEqual(downloads(), retire === 'none' ? ['https://example.test/dl/2.1.0.zip'] : [], retire);
    u.dispose();
    autoUpdater.removeAllListeners();
  }
});

test('a ready update that cannot be compared, or an app moved out of Applications, is not replaced', async () => {
  {
    const { u } = await readyMac('2.0.0');
    u.state.available = { version: 'unnamed', notes: '' };
    publish('2.1.0');
    await checked(u);
    assert.deepEqual(calls, []);
    u.dispose();
    autoUpdater.removeAllListeners();
  }
  {
    const { u } = await readyMac('2.0.0');
    app.inApps = false;
    publish('2.1.0');
    assert.equal((await checked(u, { manual: true })).status, 'ready');
    assert.deepEqual(calls, []);
    u.dispose();
  }
});

test('macOS: a replacement Squirrel never finishes preparing offers the ready update again, and is not started twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { u } = await readyMac('2.0.0');
  try {
    publish('2.1.0');
    await checked(u);
    assert.equal(u.state.preparing, true);
    t.mock.timers.tick(10 * 60_000);
    assert.equal(u.state.status, 'ready');
    assert.equal(u.state.available.version, '2.0.0');
    assert.equal(u.state.error, 'Preparing the update timed out. Restart MoPilot to check again.');
    // Squirrel still owns the replacement: a check downloads nothing more until it ends
    calls.length = 0;
    await checked(u);
    assert.deepEqual(calls, []);
  } finally {
    u.dispose();
  }
});

test('a check that starts while a Restart when idle waits outside ready stops the wait instead of stranding it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { u } = await readyMac('2.0.0', { idle: async () => false, gate: async () => true });
  try {
    assert.equal(await u.install({ when: 'idle' }), true);
    u.state.status = 'error';
    publish(null);
    await checked(u);
    assert.equal(u.state.status, 'ready', 'the staged update is offered again');
    assert.equal(u.state.restartWhenIdle, false);
    assert.equal(u.idleTimer, null);
  } finally {
    u.dispose();
  }
});
