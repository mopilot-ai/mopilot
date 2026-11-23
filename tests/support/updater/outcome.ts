// Updater unit cases: the states the real updater broadcasts tell the failure watcher what did not land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, autoUpdater, make, checked } from './fixture.ts';

const { failureWatcher } = createRequire(import.meta.url)('../../../electron/updates/outcome.cjs');

const watched = (o: object = {}) => {
  const failures: unknown[] = [];
  const watch = failureWatcher((f: unknown) => failures.push(f));
  return { failures, ...make({ broadcast: watch, ...o }) };
};

export function registerOutcomes() {
  test('a download that fails reports its version and stage', async () => {
    const { u, failures } = watched({
      download: async () => {
        throw new Error('no network');
      },
    });
    await checked(u);
    assert.equal(u.state.status, 'error');
    assert.deepEqual(failures, [{ stage: 'download', version: '2.0.0' }]);
    u.dispose();
  });

  test('an obsolete download that fails reports nothing', async () => {
    let fail: (e: Error) => void = () => {};
    const { u, failures } = watched({
      download: () =>
        new Promise((_ok, bad) => {
          fail = bad;
        }),
    });
    await u.check();
    await new Promise((resolve) => setImmediate(resolve));
    u.configure({ auto: false, channel: 'beta' });
    fail(new Error('aborted'));
    await u.downloadWork;
    assert.deepEqual(failures, []);
    u.dispose();
  });

  test('Squirrel refusing a download reports the prepare stage', async () => {
    const { u, failures } = watched();
    await checked(u);
    autoUpdater.emit('error', new Error('Code signature did not match'));
    assert.deepEqual(failures, [{ stage: 'prepare', version: '2.0.0' }]);
    u.dispose();
  });

  test('a prepare that times out reports the prepare stage', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { u, failures } = watched();
      await checked(u);
      mock.timers.tick(10 * 60_000);
      assert.deepEqual(failures, [{ stage: 'prepare', version: '2.0.0' }]);
      u.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test('a clean update reports nothing', async () => {
    const { u, failures } = watched();
    await checked(u);
    autoUpdater.emit('update-downloaded', {}, 'n', '2.0.0');
    assert.equal(u.state.status, 'ready');
    assert.deepEqual(failures, []);
    u.dispose();
  });

  test('a restart that fails reports the install stage for the waiting version', async () => {
    const { u, failures } = watched();
    await checked(u);
    autoUpdater.emit('update-downloaded', {}, 'n', '2.0.0');
    await u.install();
    assert.equal(u.state.status, 'installing');
    autoUpdater.emit('error', new Error('could not replace the app'));
    assert.deepEqual(failures, [{ stage: 'install', version: '2.0.0' }]);
    u.dispose();
  });
}
