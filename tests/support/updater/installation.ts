// Updater unit cases for installation.
import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mock, calls, autoUpdater, make, checked, deferred } from './fixture.ts';

export function registerInstallOwnership() {
  test('every staged artifact retains its channel through preferences, checks, and timeouts', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { u } = make();
      u.configure({ auto: false, channel: 'beta' });
      await checked(u);
      autoUpdater.emit('update-downloaded', {}, 'beta release', '2');
      u.configure({ auto: false, channel: 'stable' });
      assert.equal(u.state.status, 'error');
      assert.match(u.state.error, /previous channel.*restart/);
      assert.equal(await u.install(), false);
      u.configure({ auto: false, channel: 'dogfood' });
      assert.match(u.state.error, /previous channel/);
      const warning = u.state.error;
      await checked(u);
      autoUpdater.emit('checking-for-update');
      assert.equal(u.state.error, warning);
      autoUpdater.emit('update-available');
      assert.equal(u.state.error, warning, 'progress events do not prepend the warning again');
      mock.timers.tick(10 * 60_000);
      assert.match(u.state.error, /previous channel.*timed out/);
      autoUpdater.emit('update-not-available');
      assert.match(u.state.error, /previous channel/);
      u.configure({ auto: false, channel: 'beta' });
      assert.equal(u.state.status, 'ready', 'returning to the verified staged artifact channel restores its metadata');
      assert.equal(u.state.available.version, '2');
      u.configure({ auto: false, channel: 'stable' });
      await checked(u);
      autoUpdater.emit('update-downloaded', {}, 'stable release', '3');
      assert.equal(u.state.status, 'ready');
      assert.equal(u.state.error, null);
      assert.equal(u.state.available.version, '3');
      u.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test('mixed now/idle requests share one actual install regardless of scheduling order', async () => {
    for (const idleFirst of [false, true]) {
      const gate = deferred<boolean>();
      const idle = deferred<boolean>();
      let approvals = 0;
      const { u } = make({
        idle: () => idle.promise,
        gate: () => {
          approvals++;
          return gate.promise;
        },
      });
      u.state.status = 'ready';
      let installing: Promise<boolean>;
      if (idleFirst) {
        await u.install({ when: 'idle' });
        installing = u.install();
      } else {
        installing = u.install();
        await u.install({ when: 'idle' });
      }
      idle.resolve(true);
      await new Promise((r) => setImmediate(r));
      assert.equal(approvals, 1);
      const before = calls.filter((c) => c[0] === 'quitAndInstall').length;
      gate.resolve(true);
      assert.equal(await installing, true);
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.filter((c) => c[0] === 'quitAndInstall').length, before + 1);
      u.dispose();
    }
  });
}

export function registerInstallation() {
  test('install: only when ready; the exit gate can refuse; without a gate it restarts at once', async () => {
    const gated: string[] = [];
    let allow = false;
    const { u } = make({ gate: async (r: string) => (gated.push(r), allow) });
    assert.equal(await u.install(), false);
    u.state.status = 'ready';
    assert.equal(await u.install(), false);
    allow = true;
    assert.equal(await u.install(), true);
    assert.deepEqual(gated, ['update', 'update']);
    assert.deepEqual(calls, [['quitAndInstall']]);

    const plain = make().u;
    plain.state.status = 'ready';
    assert.equal(await plain.install({ when: 'idle' }), true); // no idle probe: restart now
    assert.equal(calls.length, 2);
  });

  test('install when idle polls until nothing would stop, then restarts through the gate', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const answers: any[] = [
        async () => false,
        async () => {
          throw new Error('x');
        },
        async () => true,
      ];
      const { u } = make({ idle: () => answers.shift()(), gate: async () => true });
      const { recentIgnored } = createRequire(import.meta.url)('../../../electron/ignored.cjs');
      u.state.status = 'ready';
      assert.equal(await u.install({ when: 'idle' }), true);
      assert.equal(u.state.restartWhenIdle, true);
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.length, 0);
      mock.timers.tick(3000);
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.length, 0);
      mock.timers.tick(3000);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      assert.equal(u.idleTimer, null);
      assert.deepEqual(calls, [['quitAndInstall']]);
      // the probe that failed counted as busy, and is recorded
      assert.ok(
        recentIgnored().some((e: any) => e.context === 'check whether the app is idle to restart for an update' && e.message === 'x'),
      );
      mock.timers.tick(9000);
      assert.equal(calls.length, 1);
    } finally {
      mock.timers.reset();
    }
  });

  test('install when idle: a restart that fails offers it again, with why, instead of staying "Restarting when idle"', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const { u, seen } = make({
        idle: async () => true,
        gate: async () => {
          throw new Error('gate broke');
        },
      });
      u.state.status = 'ready';
      assert.equal(await u.install({ when: 'idle' }), true);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      assert.equal(u.state.restartWhenIdle, false);
      assert.equal(u.state.error, 'gate broke');
      assert.equal(seen.at(-1).restartWhenIdle, false);
      assert.equal(u.idleTimer, null);
      assert.deepEqual(calls, []);
    } finally {
      mock.timers.reset();
    }
  });

  test('install when idle: a restart the exit gate refuses offers it again instead of staying "Restarting when idle"', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const { u } = make({ idle: async () => true, gate: async () => false });
      u.state.status = 'ready';
      assert.equal(await u.install({ when: 'idle' }), true);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      assert.equal(u.state.restartWhenIdle, false);
      assert.equal(u.idleTimer, null);
      assert.deepEqual(calls, []);
    } finally {
      mock.timers.reset();
    }
  });

  test('restart to update shows Installing until the app quits; checks wait, and dispose drops the timeout', async () => {
    const { u, seen } = make({ gate: async () => true });
    u.state.status = 'ready';
    u.state.available = { version: '2.0.0', notes: '' };
    assert.equal(await u.install(), true);
    assert.equal(u.state.status, 'installing');
    assert.equal(u.state.error, null);
    assert.equal(seen.at(-1).status, 'installing', 'the rail hears Installing before the app quits');
    assert.deepEqual(calls, [['quitAndInstall']]);
    assert.equal((await u.check()).status, 'installing', 'a check never replaces a restart in progress');
    u.configure({ auto: false, channel: 'beta' });
    assert.equal(u.state.status, 'installing', 'nor does a channel change that lands while the app quits');
    assert.ok(u.installTimer);
    u.dispose();
    // a late timeout or error after dispose changes nothing
    u.installFailed('late');
    assert.equal(u.state.status, 'installing');
  });

  test('a restart to update that fails offers the update again, with why', async () => {
    const available = { version: '2.0.0', notes: '' };
    // Squirrel reports the failure as an error event with no check in flight
    {
      const { u } = make({ gate: async () => true });
      u.state.status = 'ready';
      u.state.available = available;
      await u.install();
      autoUpdater.emit('error', new Error('could not replace the app'));
      assert.equal(u.state.status, 'ready');
      assert.equal(u.state.available, available);
      assert.equal(u.state.error, 'Could not replace the app.');
      assert.equal(u.installTimer, undefined);
      // and the same update can be installed again
      calls.length = 0;
      assert.equal(await u.install(), true);
      assert.deepEqual(calls, [['quitAndInstall']]);
      u.dispose();
      autoUpdater.removeAllListeners();
    }
    // quitAndInstall throws
    {
      const { u } = make({ gate: async () => true });
      u.state.status = 'ready';
      u.state.available = available;
      const real = autoUpdater.quitAndInstall;
      autoUpdater.quitAndInstall = () => {
        throw new Error('no update staged');
      };
      try {
        assert.equal(await u.install(), false);
      } finally {
        autoUpdater.quitAndInstall = real;
      }
      assert.equal(u.state.status, 'ready');
      assert.equal(u.state.error, 'no update staged');
      u.dispose();
      autoUpdater.removeAllListeners();
    }
  });

  test('a Restart when idle whose restart fails stops saying it waits for idle', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const { u } = make({ idle: async () => true, gate: async () => true });
      u.state.status = 'ready';
      u.state.available = { version: '2.0.0', notes: '' };
      assert.equal(await u.install({ when: 'idle' }), true);
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      assert.equal(u.state.status, 'installing');
      assert.equal(u.state.restartWhenIdle, true);
      autoUpdater.emit('error', new Error('could not replace the app'));
      assert.equal(u.state.status, 'ready');
      assert.equal(u.state.restartWhenIdle, false);
      assert.equal(u.idleTimer, null);
      u.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test('a restart to update that never quits stops showing Installing after a minute', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { u } = make({ gate: async () => true });
      u.state.status = 'ready';
      u.state.available = { version: '2.0.0', notes: '' };
      await u.install();
      mock.timers.tick(59_999);
      assert.equal(u.state.status, 'installing');
      mock.timers.tick(1);
      assert.equal(u.state.status, 'ready');
      assert.equal(u.state.error, 'The restart to update did not finish. Try again.');
      // an error that arrives after giving up is not a check's, and leaves the offered update alone
      autoUpdater.emit('error', new Error('late'));
      assert.equal(u.state.status, 'ready');
      assert.equal(u.state.error, 'The restart to update did not finish. Try again.');
      u.dispose();
    } finally {
      mock.timers.reset();
    }
  });
}
