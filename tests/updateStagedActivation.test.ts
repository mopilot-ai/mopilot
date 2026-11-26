// Drives staged macOS updates through the real updater, including approval, refresh, cancellation and helper loss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calls, checked, deferred, feedBody, make, mock, responses } from './support/updater/fixture.ts';

function stage() {
  let usable = true;
  return {
    ready: () => usable,
    commit: mock.fn(async (_restart: boolean) => {
      usable = false;
    }),
    cancel: mock.fn(() => {
      usable = false;
    }),
  };
}

function publish(version: string, notes = version) {
  responses.fetchImpl = async () =>
    feedBody({
      schema: 1,
      releases: [
        {
          version,
          platform: 'darwin',
          arch: process.arch,
          url: `https://example.test/${version}.zip`,
          rolloutPct: 100,
          notes,
          pub_date: '2026-10-21T00:00:00Z',
        },
      ],
    });
}

test('retirement during ZIP cleanup cannot publish the stage', async (t) => {
  const preparing = deferred<void>();
  const cleanup = deferred<void>();
  const prepared = stage();
  t.mock.method(fs.promises, 'rm', () => (preparing.resolve(), cleanup.promise));
  const { u } = make({ macInstaller: { prepare: async () => prepared } });
  t.after(() => u.dispose());
  await u.check();
  await preparing.promise;
  u.dispose();
  cleanup.resolve();
  await u.downloadWork;
  assert.equal(prepared.cancel.mock.callCount(), 1);
  assert.equal(u.state.status, 'downloading');
});

test('an already dead worker stays unready and a failed activation settles the quit task', async (t) => {
  const prepared = stage();
  const dead = { ...stage(), ready: () => false };
  const macInstaller = { prepare: mock.fn(async () => dead) };
  const activationAttempt = mock.fn();
  const { u } = make({ macInstaller, activationAttempt });
  t.after(() => u.dispose());
  assert.equal((await checked(u)).status, 'error');
  publish('2.0.0', '');
  macInstaller.prepare.mock.mockImplementationOnce(async () => prepared);
  assert.deepEqual((await checked(u)).available, { version: '2.0.0', notes: '' });
  prepared.commit.mock.mockImplementationOnce(async () => {
    throw new Error('installer disconnected');
  });
  await u.installOnQuit();
  assert.equal(prepared.commit.mock.callCount(), 1);
  assert.deepEqual(activationAttempt.mock.calls[0].arguments, ['2.0.0', 'stable']);
});

for (const action of ['restart', 'quit'] as const) {
  test(`a staged update waits for preparation and confirmed ${action} before the helper can activate it`, async (t) => {
    const ready = deferred<ReturnType<typeof stage>>();
    const preparing = deferred<void>();
    const prepared = stage();
    const gate = mock.fn(async () => true);
    const activationAttempt = mock.fn();
    const macInstaller = {
      prepare: mock.fn((_file, _version) => {
        preparing.resolve();
        return ready.promise;
      }),
    };
    const { u } = make({ macInstaller, gate, activationAttempt });
    t.after(() => u.dispose());
    await u.check();
    await preparing.promise;
    assert.equal(u.state.preparing, true);
    assert.equal(await u.install(), false);
    ready.resolve(prepared);
    await u.downloadWork;
    assert.equal(u.state.status, 'ready');
    assert.deepEqual(macInstaller.prepare.mock.calls[0].arguments.slice(0, 2), ['/tmp/update.zip', '2.0.0']);
    assert.ok(!calls.some(([name]) => ['serve', 'checkForUpdates', 'quitAndInstall'].includes(name)));
    if (action === 'restart') {
      gate.mock.mockImplementationOnce(async () => false);
      assert.equal(await u.install(), false);
      assert.equal(prepared.commit.mock.callCount(), 0);
      assert.equal(await u.install(), true);
      assert.deepEqual(calls.at(-1), ['quit']);
    } else assert.equal(prepared.commit.mock.callCount(), 0);
    await u.installOnQuit();
    assert.deepEqual(
      prepared.commit.mock.calls.map(({ arguments: args }) => args),
      [[action === 'restart']],
    );
    assert.deepEqual(activationAttempt.mock.calls[0].arguments, ['2.0.0', 'stable']);
  });
}

test('a new stage retires the old helper only when ready, and a channel change retires that stage too', async (t) => {
  const old = stage();
  const replacement = stage();
  const macInstaller = {
    prepare: mock.fn(async () => old),
  };
  const { u } = make({ macInstaller });
  t.after(() => u.dispose());
  await checked(u);
  publish('3.0.0');
  macInstaller.prepare.mock.mockImplementationOnce(async () => {
    throw new Error('unpack failed');
  });
  assert.equal((await checked(u)).available.version, '2.0.0');
  assert.equal(old.cancel.mock.callCount(), 0);
  macInstaller.prepare.mock.mockImplementationOnce(async () => replacement);
  assert.equal((await checked(u)).available.version, '3.0.0');
  assert.equal(old.cancel.mock.callCount(), 1);
  u.configure({ auto: false, channel: 'beta' });
  assert.equal(replacement.cancel.mock.callCount(), 1);
  await u.installOnQuit();
  assert.equal(replacement.commit.mock.callCount(), 0);
  assert.equal(u.state.status, 'idle');
});

test('Restart keeps MoPilot open when activation cannot be delivered, and the next check can retry', async (t) => {
  const prepared = stage();
  const next = stage();
  const prepare = mock.fn(async () => prepared);
  const gate = mock.fn(async () => true);
  const { u } = make({ macInstaller: { prepare }, gate });
  t.after(() => u.dispose());
  await checked(u);
  prepared.commit.mock.mockImplementationOnce(async () => {
    throw new Error('write EPIPE');
  });
  assert.equal(await u.install(), false);
  assert.ok(!calls.some(([name]) => name === 'quit'));
  assert.equal(u.state.status, 'error');
  assert.match(u.state.error, /Check for updates to try again/);
  prepare.mock.mockImplementationOnce(async () => next);
  await checked(u);
  assert.equal(await u.install(), true);
  assert.deepEqual(calls.at(-1), ['quit']);
});

test('an already authorized Quit shares an explicit restart handoff, including its failure', async (t) => {
  const prepared = stage();
  const writing = deferred<void>();
  const writingStarted = deferred<void>();
  prepared.commit.mock.mockImplementationOnce(() => (writingStarted.resolve(), writing.promise));
  const { u } = make({ macInstaller: { prepare: async () => prepared } });
  t.after(() => u.dispose());
  await checked(u);
  const restarting = u.install();
  await writingStarted.promise;
  const quitting = u.installOnQuit();
  assert.equal(prepared.commit.mock.callCount(), 1);
  writing.reject(new Error('lost handoff'));
  assert.equal(await restarting, false);
  await quitting;
  assert.match(u.state.error, /Check for updates to try again/);
});

test('a revoked stage refuses an explicit restart even if a window still shows Ready', async (t) => {
  const prepared = stage();
  const { u } = make({ macInstaller: { prepare: async () => prepared } });
  t.after(() => u.dispose());
  await checked(u);
  u.stagedArtifact.valid = false;
  assert.equal(await u.install(), false);
  assert.equal(prepared.commit.mock.callCount(), 0);
  assert.ok(!calls.some(([name]) => name === 'quit'));
});

test('Squirrel still owns activation on ordinary quit when the new helper is unavailable', async (t) => {
  const { u } = make({ macInstaller: null });
  t.after(() => u.dispose());
  await checked(u);
  assert.equal(u.installOnQuit(), undefined);
  assert.equal(u.state.preparing, true);
  assert.ok(calls.some(([name]) => name === 'checkForUpdates'));
  assert.ok(!calls.some(([name]) => name === 'quitAndInstall'));
});

test('quit retires an in-flight feed check before transferring the last ready stage', async (t) => {
  const prepared = stage();
  const response = deferred<ReturnType<typeof feedBody>>();
  const requested = deferred<void>();
  const writing = deferred<void>();
  const prepare = mock.fn(async () => prepared);
  const { u } = make({ macInstaller: { prepare } });
  t.after(() => u.dispose());
  await checked(u);
  responses.fetchImpl = () => (requested.resolve(), response.promise);
  const checking = u.check();
  await requested.promise;
  prepared.commit.mock.mockImplementationOnce(() => writing.promise);
  const quitting = u.installOnQuit();
  response.resolve(
    feedBody({
      schema: 1,
      releases: [
        {
          version: '1.2.3',
          platform: 'darwin',
          arch: process.arch,
          url: 'https://example.test/rollback.zip',
          rolloutPct: 100,
          notes: '',
          pub_date: '2026-10-21T00:00:00Z',
          sha256: 'a'.repeat(64),
          size: 7,
        },
      ],
      rollbacks: [
        {
          version: '2.0.0',
          channel: 'stable',
          targetVersion: '1.2.3',
          requestId: '87654321-abcd-4321-9876-123456789abc',
          enabled: true,
        },
      ],
    }),
  );
  await checking;
  assert.equal(prepared.commit.mock.callCount(), 1);
  assert.equal(u.stagedArtifact.valid, true);
  assert.equal(prepare.mock.callCount(), 1);
  assert.equal(u.disposed, true);
  writing.resolve();
  await quitting;
});

test('an obsolete preparation completion closes its worker without publishing Ready', async (t) => {
  const started = deferred<void>();
  const pending = deferred<ReturnType<typeof stage>>();
  const prepared = stage();
  const { u } = make({ macInstaller: { prepare: () => (started.resolve(), pending.promise) } });
  t.after(() => u.dispose());
  await u.check();
  await started.promise;
  u.configure({ auto: false, channel: 'beta' });
  pending.resolve(prepared);
  await u.downloadWork;
  assert.equal(prepared.cancel.mock.callCount(), 1);
  assert.equal(u.state.status, 'idle');
});

for (const phase of ['ready', 'installing', 'downloading'] as const) {
  test(`losing a staged helper while ${phase} retires only its own artifact`, async (t) => {
    const prepared = stage();
    const next = deferred<ReturnType<typeof stage>>();
    const started = deferred<void>();
    let lost!: (artifact: ReturnType<typeof stage>, error: Error) => void;
    const macInstaller = {
      prepare: mock.fn(async (_file, _version, _signal, onLost) => {
        lost = onLost;
        return prepared;
      }),
    };
    const { u } = make({ macInstaller });
    t.after(() => u.dispose());
    await checked(u);
    lost(stage(), new Error('obsolete worker'));
    assert.equal(u.state.status, 'ready');
    if (phase === 'installing') assert.equal(await u.install(), true);
    if (phase === 'downloading') {
      macInstaller.prepare.mock.mockImplementationOnce(() => (started.resolve(), next.promise));
      publish('3.0.0');
      await u.check();
      await started.promise;
    }
    lost(prepared, new Error('no worker'));
    assert.equal(u.state.available, null);
    if (phase === 'downloading') {
      assert.equal(u.state.status, 'downloading');
      next.resolve(stage());
      await u.downloadWork;
      assert.equal(u.state.available.version, '3.0.0');
    } else {
      assert.equal(u.state.status, 'error');
      assert.equal(u.state.error, 'no worker');
    }
  });
}
