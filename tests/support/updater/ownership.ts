// Updater unit cases for ownership.
import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mock, calls, autoUpdater, app, setPlatform, make, checked, deferred, responses, dialog } from './fixture.ts';

export function registerOwnership() {
  test('native checks retain event ownership until terminal completion and ignore unrelated events', async () => {
    const { u } = make();
    await u.ready;
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-not-available');
    assert.equal(u.state.status, 'idle');
    await checked(u);
    u.configure({ auto: false, channel: 'beta' });
    assert.match((await u.check()).error, /previous update check/);
    autoUpdater.emit('update-not-available');
    assert.equal(u.state.status, 'idle');
    await checked(u);
    autoUpdater.emit('update-downloaded', {}, 'current', '3');
    assert.equal(u.state.status, 'ready');
    u.dispose();
    assert.equal((await u.check()).status, 'ready');
    assert.equal(await u.install(), false);
  });

  test('timeouts release visible pending state but never reassign a still-running native operation', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { u } = make();
      await checked(u);
      mock.timers.tick(10 * 60_000);
      assert.equal(u.state.status, 'error');
      assert.equal(u.state.error, 'Preparing the update timed out. Restart MoPilot to check again.');
      autoUpdater.emit('update-available');
      assert.equal(u.state.status, 'error');
      assert.match((await u.check()).error, /previous update check/);
      autoUpdater.emit('update-downloaded', {}, 'late', '2');
      assert.match(u.state.error, /earlier check.*restart/);
      await checked(u);
      autoUpdater.emit('error', new Error('current network failure'));
      assert.match(u.state.error, /Current network failure/);
      await checked(u);
      autoUpdater.emit('update-not-available');
      assert.match(u.state.error, /earlier check/);
      await checked(u);
      autoUpdater.emit('update-downloaded', {}, 'fresh', '3');
      assert.equal(u.state.status, 'ready');
      u.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test('a queued old timeout cannot change the next operation or a disposed updater', async () => {
    const callbacks: Function[] = [];
    const timer = mock.method(globalThis, 'setTimeout', ((f: Function) => {
      callbacks.push(f);
      return {};
    }) as any);
    try {
      const { u } = make();
      await checked(u);
      autoUpdater.emit('update-not-available');
      await checked(u);
      const state = u.state;
      callbacks[0]();
      assert.equal(u.state, state);
      u.dispose();
      callbacks[1]();
      autoUpdater.emit('update-downloaded', {}, 'disposed', '2');
      assert.equal(u.state, state);
    } finally {
      timer.mock.restore();
    }
  });

  test('stale readiness and dialog answers do not move the app or start an update', async () => {
    const team = deferred<string | null>();
    const { u } = make({ team: () => team.promise });
    const pending = u.check();
    u.configure({ auto: false, channel: 'beta' });
    team.resolve('TEAM');
    await pending;
    assert.equal(
      calls.some((c) => c[0] === 'checkForUpdates'),
      false,
    );
    u.dispose();
    const noTeam = deferred<string | null>();
    const retired = make({ team: () => noTeam.promise });
    retired.u.dispose();
    noTeam.resolve(null);
    await retired.u.ready;
    assert.equal(retired.seen.length, 0);
    app.inApps = false;
    const answer = deferred<any>();
    const dialogMock = mock.method(dialog, 'showMessageBox', () => answer.promise);
    try {
      const next = make().u;
      const checking = next.check({ manual: true });
      await new Promise((r) => setImmediate(r));
      next.configure({ auto: false, channel: 'beta' });
      answer.resolve({ response: 0 });
      await checking;
      assert.equal(
        calls.some((c) => c[0] === 'move'),
        false,
      );
      next.dispose();
    } finally {
      dialogMock.mock.restore();
    }
  });

  test('stale authentication failures and synchronous native failures retain the correct state', async () => {
    const token = deferred<string>();
    const { u } = make({ token: () => token.promise });
    u.configure({ auto: false, channel: 'beta' });
    const pending = u.check();
    await new Promise((r) => setImmediate(r));
    u.configure({ auto: false, channel: 'stable' });
    token.reject(new Error('obsolete credentials'));
    await pending;
    assert.equal(u.state.error, null);
    const checkMock = mock.method(autoUpdater, 'checkForUpdates', () => {
      throw new Error('native check failed');
    });
    try {
      await checked(u);
      assert.equal(u.state.error, 'native check failed');
    } finally {
      checkMock.mock.restore();
      u.dispose();
    }
  });

  test('direct Windows feed checks still work', async () => {
    setPlatform('win32');
    const { u } = make();
    assert.equal((await u.checkFeed()).status, 'idle');
    u.dispose();
  });

  test('duplicate restart requests share approval, while newer artifacts cannot be cleared by older requests', async () => {
    const gate = deferred<boolean>();
    const nextGate = deferred<boolean>();
    let probes = 0;
    const { u } = make({ gate: () => (++probes === 1 ? gate.promise : nextGate.promise) });
    u.state.status = 'ready';
    const first = u.install();
    const duplicate = u.install();
    assert.equal(probes, 1);
    u.state.available = { version: 'new', notes: '' };
    const next = u.install();
    assert.equal(probes, 2);
    gate.resolve(true);
    assert.equal(await first, false);
    assert.equal(await duplicate, false);
    nextGate.resolve(true);
    assert.equal(await next, true);
    assert.equal(calls.filter((c) => c[0] === 'quitAndInstall').length, 1);
    u.dispose();
  });

  test('idle probes do not overlap, and a replaced idle request ignores its old probe', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const first = deferred<boolean>();
      let probes = 0;
      const { u } = make({ idle: () => (++probes === 1 ? first.promise : Promise.resolve(false)) });
      u.state.status = 'ready';
      await u.install({ when: 'idle' });
      mock.timers.tick(6000);
      assert.equal(probes, 1);
      await u.install({ when: 'idle' });
      first.resolve(true);
      await new Promise((r) => setImmediate(r));
      assert.equal(
        calls.some((c) => c[0] === 'quitAndInstall'),
        false,
      );
      assert.equal(u.state.restartWhenIdle, true, 'old probe cannot clear the replacement timer');
      u.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test('obsolete idle restart failures are recorded without changing a replacement channel state', async () => {
    const gate = deferred<boolean>();
    const { u } = make({ idle: async () => true, gate: () => gate.promise });
    u.state.status = 'ready';
    await u.install({ when: 'idle' });
    await new Promise((r) => setImmediate(r));
    u.configure({ auto: false, channel: 'beta' });
    const state = u.state;
    gate.reject(new Error('old gate failure'));
    await new Promise((r) => setImmediate(r));
    assert.equal(u.state, state);
    const { recentIgnored } = createRequire(import.meta.url)('../../../electron/ignored.cjs');
    assert.ok(recentIgnored().some((e: any) => e.context === 'finish an obsolete idle update restart' && e.message === 'old gate failure'));
    u.dispose();
  });

  test('obsolete Windows download failures do not present an old installer dialog', async () => {
    setPlatform('win32');
    for (const change of ['channel', 'artifact', 'dispose']) {
      const opening = deferred<void>();
      responses.openResult = opening.promise;
      const { u } = make();
      u.state.status = 'ready';
      u.state.available = { version: 'old', notes: '', url: 'https://old/Setup.exe' };
      const pending = u.install();
      if (change === 'channel') u.configure({ auto: false, channel: 'beta' });
      if (change === 'artifact') u.state.available = { version: 'new', notes: '', url: 'https://new/Setup.exe' };
      if (change === 'dispose') u.dispose();
      const count = calls.length;
      opening.reject(new Error('obsolete browser failure'));
      assert.equal(await pending, false);
      assert.equal(calls.length, count, 'the initial authorized open is the only external action');
      const { recentIgnored } = createRequire(import.meta.url)('../../../electron/ignored.cjs');
      assert.ok(
        recentIgnored().some((e: any) => e.context === 'open an obsolete update download' && e.message === 'obsolete browser failure'),
      );
      u.dispose();
    }
  });
}
