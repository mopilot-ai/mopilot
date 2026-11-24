// What a machine's row says of updating its Host from the app (electron/host/updateStates.cjs): not the app's build, uploading, waiting for a turn to end, failed with the cause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { createUpdateStates, WAIT_MS } = require('../electron/host/updateStates.cjs');

test('a Host of another build is stale once it has answered; the same build, an unknown app build and a silent machine are not', () => {
  const s = createUpdateStates({ appBuild: () => 'b2', appVersion: () => '1.0.0' });
  assert.deepEqual(s.rowFor('m', 'b1', true), { hostStale: true });
  assert.deepEqual(s.rowFor('m', '', true), { hostStale: true }, 'a Host that names no build is older');
  assert.deepEqual(s.rowFor('m', 'b2', true), {});
  assert.deepEqual(s.rowFor('m', '', false), {}, 'a machine that never answered says nothing');
  assert.deepEqual(createUpdateStates({ appBuild: () => '' }).rowFor('m', 'b1', true), {});
});

test('#4923: the order of a Host and the app is told by the version the Host reports, and never guessed when it cannot be', () => {
  const s = createUpdateStates({ appBuild: () => 'b2', appVersion: () => '0.4.27' });
  assert.deepEqual(s.rowFor('m', 'b1', true, '0.4.26'), { hostStale: true });
  assert.deepEqual(s.rowFor('m', 'b1', true, ''), { hostStale: true }, 'a Host that reports no version predates this app');
  assert.deepEqual(s.rowFor('m', 'b1', true, '0.4.28'), { hostNewer: true });
  assert.deepEqual(s.rowFor('m', 'b1', true, '0.4.27'), { hostStale: true, hostDiffers: true }, 'same version, other build: no order');
  assert.deepEqual(s.rowFor('m', 'b2', true, '0.4.28'), {}, 'the same build is current whatever it says');
  assert.deepEqual(s.rowFor('m', '', true, '0.4.28'), { hostStale: true }, 'no build is older, whatever else it says');
  assert.deepEqual(s.rowFor('m', 'b1', false, '0.4.28'), {});
  // an app that knows no version of its own cannot order anything: differ
  const blind = createUpdateStates({ appBuild: () => 'b2', appVersion: () => '' });
  assert.deepEqual(blind.rowFor('m', 'b1', true, '0.4.28'), { hostStale: true, hostDiffers: true });
  assert.deepEqual(blind.rowFor('m', 'b1', true, ''), { hostStale: true, hostDiffers: true });
  // no appVersion function at all is the same
  assert.deepEqual(createUpdateStates({ appBuild: () => 'b2' }).rowFor('m', 'b1', true, '1.0.0'), { hostStale: true, hostDiffers: true });
});

test('an update runs, waits for the Host to restart, and is gone once the Host says this app’s build', async (t) => {
  installFakeClock(t, 1_000);
  const s = createUpdateStates({ appBuild: () => 'b2', appVersion: () => '1.0.0' });
  let seen: unknown;
  const out = await s.run(
    'm',
    async () => ((seen = s.rowFor('m', 'b1', true).update), 'ok'),
    () => undefined,
  );
  assert.equal(out, 'ok');
  assert.equal(seen, 'running');
  assert.equal(s.rowFor('m', 'b1', true).update, 'waiting');
  assert.deepEqual(s.rowFor('m', 'b2', true), {});
});

test('a Host still not restarted after ten minutes is a failure that says why', async (t) => {
  const clock = installFakeClock(t, 1_000);
  const s = createUpdateStates({ appBuild: () => 'b2', appVersion: () => '1.0.0' });
  await s.run(
    'm',
    async () => 1,
    () => undefined,
  );
  clock.advance(WAIT_MS + 1);
  const row = s.rowFor('m', 'b1', true);
  assert.equal(row.update, 'failed');
  assert.match(row.updateError, /A turn may still be running/);
});

test('a failure keeps its cause for the row, a second request while one runs is refused, and forgetting clears it', async (t) => {
  installFakeClock(t, 1_000);
  const s = createUpdateStates({ appBuild: () => 'b2', appVersion: () => '1.0.0' });
  let changes = 0;
  await assert.rejects(
    s.run(
      'm',
      async () => Promise.reject(Object.assign(new Error('Connection lost.'), { code: 'update_failed' })),
      () => changes++,
    ),
    /Connection lost/,
  );
  assert.equal(changes, 2);
  assert.deepEqual(s.rowFor('m', 'b1', true), { hostStale: true, update: 'failed', updateError: 'Connection lost.' });
  let release: () => void = () => undefined;
  const first = s.run(
    'm',
    () => new Promise<void>((r) => (release = r)),
    () => undefined,
  );
  await assert.rejects(
    s.run(
      'm',
      async () => 1,
      () => undefined,
    ),
    (e: any) => e.code === 'busy',
  );
  release();
  await first;
  s.forget('m');
  assert.equal(s.rowFor('m', 'b2', true).update, undefined);
});

test('only an actual pairing refusal marks Pair again; retryable transport errors do not', async () => {
  const s = createUpdateStates({ appBuild: () => 'b', appVersion: () => '1.0.0' });
  for (const code of ['unknown_client', 'not_paired', 'timed_out']) {
    await assert.rejects(
      s.run(
        'm',
        async () => {
          throw Object.assign(new Error('refused'), { code });
        },
        () => undefined,
      ),
    );
    assert.equal(s.rowFor('m', 'b', true).updateNeedsPair, code === 'timed_out' ? undefined : true);
    s.forget('m');
  }
});

test('a missing restart acknowledgment clears when the Host reports the update took effect', async () => {
  for (const appBuild of ['b2', '']) {
    const s = createUpdateStates({ appBuild: () => appBuild, appVersion: () => '1.0.0' });
    await assert.rejects(
      s.run(
        'm',
        async () => {
          throw Object.assign(new Error('Restart unconfirmed'), { code: 'update_restart_unconfirmed' });
        },
        () => undefined,
      ),
    );
    assert.equal(s.rowFor('m', '', false).update, 'failed', 'no answer keeps the recovery action');
    assert.equal(s.rowFor('m', 'b2', true).update, appBuild ? undefined : 'failed');
  }
});

test('a removed update cannot publish over a newer update of the same id', async () => {
  for (const fail of [false, true]) {
    const s = createUpdateStates({ appBuild: () => 'b', appVersion: () => '1.0.0' });
    let finish!: () => void;
    let changes = 0;
    const old = s.run(
      'm',
      () =>
        new Promise<void>((resolve, reject) => {
          finish = () => (fail ? reject(new Error('old failure')) : resolve());
        }),
      () => changes++,
    );
    s.forget('m');
    let endNew!: () => void;
    const current = s.run(
      'm',
      () => new Promise<void>((r) => (endNew = r)),
      () => changes++,
    );
    finish();
    if (fail) await assert.rejects(old);
    else await old;
    assert.equal(s.rowFor('m', 'other', true).update, 'running');
    assert.equal(changes, 2, 'retired completion does not publish');
    endNew();
    await current;
  }
});

test('a retry keeps the cause of the failure it follows on the row until it ends', async (t) => {
  installFakeClock(t, 1_000);
  const s = createUpdateStates({ appBuild: () => 'b2', appVersion: () => '1.0.0' });
  await assert.rejects(
    s.run(
      'm',
      async () => Promise.reject(new Error('No route.')),
      () => undefined,
    ),
    /No route/,
  );
  let during: any;
  await s.run(
    'm',
    async () => ((during = s.rowFor('m', 'b1', true, '0.9.0')), 'ok'),
    () => undefined,
  );
  assert.equal(during.update, 'running');
  assert.equal(during.updateError, 'No route.', 'the last cause is still readable while the next try uploads');
});

test('a deferred automatic update restores the previous row state', async () => {
  const s = createUpdateStates({ appBuild: () => 'b2', appVersion: () => '1.0.0' });
  const fail = (e: Error) =>
    s.run(
      'm',
      async () => Promise.reject(e),
      () => undefined,
    );
  const defer = () => fail(Object.assign(new Error('Waiting for the Host'), { code: 'update_deferred' }));
  const row = () => s.rowFor('m', 'b1', true, '0.9.0');
  await assert.rejects(defer());
  assert.equal(row().update, undefined);
  await assert.rejects(fail(new Error('No route.')));
  await assert.rejects(defer());
  assert.equal(row().update, 'failed');
  assert.equal(row().updateError, 'No route.');
});

test('automatic eligibility needs a distinct known app build and an older or legacy Host', () => {
  const options = { appBuild: () => 'mine', appVersion: () => '0.4.62' };
  const status = { id: 'm', hostBuild: 'older', hostAppVersion: '0.4.61' };
  const { isOlder } = createUpdateStates(options).forUpdater;
  assert.equal(isOlder(status), true);
  assert.equal(isOlder({ ...status, hostBuild: '', hostAppVersion: '' }), true);
  assert.equal(isOlder({ ...status, hostBuild: 'mine' }), false);
  assert.equal(isOlder({ ...status, hostBuild: '', hostAppVersion: '0.4.63' }), false);
  assert.equal(createUpdateStates({ ...options, appBuild: () => '' }).isOlder(status), false);
  assert.equal(createUpdateStates({ ...options, appVersion: () => '' }).isOlder(status), false);
});
