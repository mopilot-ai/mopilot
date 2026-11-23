// CM-H19: chat-owned permission recovery survives turn/read/helper cleanup, on every harness and without a window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/computer-use-setup-rig.ts';
import { make, ctx, shot } from './support/computer-tools-kit.ts';
import { deferred, tick as settle } from './support/async-scenarios.ts';

export const GUARDS = ['electron/capabilities/'];

const require = createRequire(import.meta.url);
const { DesktopControl } = require('../electron/capabilities/tools/desktop.cjs');
const { AppScopedControl } = require('../electron/capabilities/tools/appScoped.cjs');
const { NativeDesktopHolds } = require('../electron/capabilities/nativeDesktopHold.cjs');
const denial = (permission = 'accessibility') =>
  Object.assign(new Error(`${permission} permission not granted`), { reason: 'permission_denied' });

test('CM-H19: a completed older tool cannot clear a newer refusal, including mixed computer, desktop and app calls', async () => {
  for (const old of ['computer', 'desktop', 'app']) {
    for (const first of ['read', 'refusal']) {
      const pending = deferred<any>();
      const started = deferred<void>();
      const r = make({
        helper: {
          screenshot: () => {
            started.resolve();
            return pending.promise;
          },
          key: async () => {
            throw denial();
          },
        },
      });
      const desktop = new DesktopControl({ helper: r.helper, cu: r.cu, grants: r.cu.grants, broker: r.cu.broker });
      desktop.dispatch = async () => {
        started.resolve();
        return pending.promise;
      };
      const apps = new AppScopedControl({ desktop, helper: r.helper, cu: r.cu, broker: r.cu.broker });
      apps.dispatch = desktop.dispatch;
      const read = () =>
        old === 'computer'
          ? r.by.computer_screenshot({}, ctx)
          : old === 'desktop'
            ? desktop.run('desktop_screenshot', {}, ctx)
            : apps.run('desktop_app_screenshot', {}, ctx);
      // Use the actual outer tool handlers: reading() alone misses success clearing.
      const readDone = read();
      await started.promise;
      if (first === 'read') {
        pending.resolve(shot());
        await readDone;
      }
      await assert.rejects(r.by.computer_key({ key: 'a' }, ctx), (e: any) => e.permission === 'accessibility');
      const guide = r.activity.at(-1);
      if (first === 'refusal') {
        pending.resolve(shot());
        await readDone;
      }
      assert.ok(r.cu.blocked.has('c'));
      assert.deepEqual(r.activity.at(-1), guide);
      // A call started after the refusal is a current retry and still clears it on success.
      await read();
      assert.equal(r.cu.blocked.has('c'), false);
    }
  }
});

test('CM-H19: native lock refusal keeps a newer guide and main release still publishes the released controller', async () => {
  const pending = deferred<void>();
  const r = make({
    helper: {
      acquireControl: () => pending.promise,
      key: async () => {
        throw denial();
      },
    },
  });
  const holds = new NativeDesktopHolds({ cu: r.cu, isNativeThread: () => true, chatOf: () => 'c', onBusy: () => {} });
  holds.take('thread', 'turn', 'B');
  await assert.rejects(r.by.computer_key({ key: 'a' }, ctx), (e: any) => e.permission === 'accessibility');
  const guide = r.activity.at(-1);
  pending.reject({ reason: 'lock_busy' });
  await settle();
  assert.equal(r.cu.controlling, null);
  assert.deepEqual(r.activity.at(-1), guide);

  const main = rig();
  const { cu, desktop } = main.runtime;
  cu.helper.releaseControl = async () => {};
  cu.controlling = 'c';
  await desktop.explain('c', denial());
  const mainGuide = main.patches.at(-1);
  await cu.release('c');
  assert.deepEqual(main.patches.at(-1), mainGuide);
  assert.deepEqual(main.log.filter((e) => e[0] === 'controlling').at(-1), ['controlling', null]);
});

test('CM-H19: a delayed native permission response cannot republish or retry after shutdown or reenable', async () => {
  for (const tool of ['computer_key', 'computer_screenshot'])
    for (const reopen of [false, true]) {
      const pending = deferred<any>();
      const started = deferred<void>();
      let calls = 0;
      const fail = async () => {
        calls++;
        throw denial();
      };
      const r = make({
        helper: {
          key: fail,
          screenshot: fail,
          requestPermission: () => {
            started.resolve();
            return pending.promise;
          },
        },
      });
      const failed = assert.rejects(r.by[tool]({ key: 'a' }, ctx), (e: any) => e.permission === 'accessibility');
      await started.promise;
      r.cu.closed = true;
      r.cu.closed = true;
      await r.cu.release('c');
      if (reopen) r.cu.closed = false;
      const last = r.activity.at(-1);
      pending.resolve({ accessibility: true });
      await failed;
      assert.deepEqual(r.activity.at(-1), last);
      assert.equal(r.cu.blocked.has('c'), false);
      assert.equal(calls, 1, 'an observation whose permission request belonged to the retired lifecycle is not retried');
    }
});

test('CM-H19: a delayed recheck cannot clear a newer refusal or restore shutdown activity', async () => {
  for (const shutdown of [false, true])
    for (const granted of [false, true]) {
      const pending = deferred<any>();
      const r = make({
        helper: {
          key: async () => {
            throw denial();
          },
          permissionStatus: () => pending.promise,
        },
      });
      await assert.rejects(r.by.computer_key({ key: 'a' }, ctx));
      const check = r.cu.recheck('c');
      r.cu.helper.key = async () => {
        throw denial('screenRecording');
      };
      await assert.rejects(r.by.computer_key({ key: 'b' }, ctx));
      if (shutdown) {
        r.cu.closed = true;
        await r.cu.release('c');
      }
      const last = r.activity.at(-1);
      pending.resolve({ accessibility: granted, screenRecording: true });
      assert.equal(await check, false);
      assert.deepEqual(r.activity.at(-1), last);
    }
});

test('CM-H19: lifecycle retirement also protects desktop and app failures and a recheck started without a guide', async () => {
  for (const route of ['desktop', 'app', 'recheck'])
    for (const permission of ['accessibility', 'screenRecording']) {
      const pending = deferred<any>();
      let stops = 0;
      const r = make({
        helper: {
          permissionStatus: () => pending.promise,
          stop: () => {
            stops++;
          },
        },
      });
      const desktop = new DesktopControl({ helper: r.helper, cu: r.cu, grants: r.cu.grants, broker: r.cu.broker });
      const apps = new AppScopedControl({ desktop, helper: r.helper, cu: r.cu, broker: r.cu.broker });
      desktop.dispatch = apps.dispatch = () => pending.promise;
      const work =
        route === 'recheck'
          ? r.cu.recheck('c')
          : assert.rejects(route === 'desktop' ? desktop.run('desktop_screenshot', {}, ctx) : apps.run('desktop_app_screenshot', {}, ctx));
      r.cu.closed = true;
      r.cu.closed = false;
      if (route === 'recheck') pending.resolve({ accessibility: true, screenRecording: true });
      else pending.reject(denial(permission));
      assert.equal(await work, route === 'recheck' ? false : undefined);
      assert.equal(r.cu.blocked.has('c'), false);
      assert.deepEqual(r.activity, []);
      assert.equal(stops, 0, 'an obsolete Screen Recording failure cannot stop the current helper');
    }
});

test('CM-H19: an older native prompt cannot retry over a newer refusal or resurrect it after recovery', async () => {
  for (const granted of [false, true])
    for (const recover of [false, true]) {
      const pending = deferred<any>();
      const requested = deferred<void>();
      let shots = 0;
      const r = make({
        helper: {
          screenshot: async () => {
            if (++shots === 1) throw denial('screenRecording');
            return shot();
          },
          key: async () => {
            throw denial();
          },
          requestPermission: (permission: string) => {
            if (permission !== 'screenRecording') return Promise.resolve({ accessibility: false });
            requested.resolve();
            return pending.promise;
          },
        },
      });
      const older = assert.rejects(r.by.computer_screenshot({}, ctx), (e: any) => e.permission === 'screenRecording');
      await requested.promise;
      await assert.rejects(r.by.computer_key({ key: 'a' }, ctx));
      if (recover) {
        r.helper.key = async () => {};
        await r.by.computer_key({ key: 'b' }, ctx);
      }
      const last = r.activity.at(-1);
      const before = shots;
      pending.resolve({ screenRecording: granted });
      await older;
      assert.equal(shots, before, 'an obsolete prompt never starts another observation');
      assert.deepEqual(r.activity.at(-1), last);
      assert.equal(r.cu.blocked.has('c'), !recover);
    }
});

test('CM-H19: retiring a pending unattended check never starts a new native prompt', async () => {
  const pending = deferred<any>();
  const started = deferred<void>();
  let requests = 0;
  let lookups = 0;
  const r = make({
    helper: {
      key: async () => {
        throw denial();
      },
      requestPermission: async () => {
        requests++;
      },
    },
  });
  r.cu.unattended = () => {
    if (++lookups === 1) return null; // authorize() finishes before the permission failure.
    started.resolve();
    return pending.promise;
  };
  const work = assert.rejects(r.by.computer_key({ key: 'a' }, ctx));
  await started.promise;
  assert.equal(r.activity.at(-1)[1].state, 'permission');
  r.cu.closed = true;
  r.cu.closed = false;
  pending.resolve(null);
  await work;
  assert.equal(requests, 0);
  assert.equal(r.cu.blocked.has('c'), false);
});

test('CM-H19: the latest requested recheck wins in both completion orders and stays scoped to its chat', async () => {
  for (const oldMissing of [false, true])
    for (const newMissing of [false, true])
      for (const first of [0, 1]) {
        const pending = [deferred<any>(), deferred<any>(), deferred<any>()];
        let reads = 0;
        const r = make({ helper: { permissionStatus: () => pending[reads++].promise } });
        r.cu.showPermissionGuide('c', 'accessibility');
        r.cu.showPermissionGuide('other', 'screenRecording');
        const checks = [r.cu.recheck('c'), r.cu.recheck('c'), r.cu.recheck('other')];
        const missing = [oldMissing, newMissing];
        for (const index of [first, 1 - first]) {
          pending[index].resolve({ accessibility: !missing[index], screenRecording: true });
          assert.equal(await checks[index], index === 1 && !newMissing);
        }
        assert.equal(r.cu.blocked.has('c'), newMissing);
        pending[2].resolve({ accessibility: true, screenRecording: true });
        assert.equal(await checks[2], true);
        assert.equal(r.cu.blocked.has('other'), false);
      }
});

test('CM-H19: waiting cleanup and activity progress keep the guide without holding native control', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const stopped of [false, true]) {
    const r = make({
      waitMs: 10,
      helper: {
        key: async () => {
          throw denial();
        },
      },
    });
    await assert.rejects(r.by.computer_key({ key: 'a' }, ctx));
    const guide = r.activity.at(-1);
    r.cu.controlling = 'other';
    const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
    const waiting = assert.rejects(
      guarded({ epoch: () => r.cu.epoch('c') }, () => r.cu.control('c', { name: 'B' })),
      (e: any) => e.code === (stopped ? 'stopped' : 'busy'),
    );
    assert.deepEqual(r.activity.at(-1), guide, 'waiting progress cannot cover the recovery guide');
    if (stopped) r.cu.interrupt('c');
    t.mock.timers.tick(10);
    await waiting;
    assert.deepEqual(r.activity.at(-1), guide);
    assert.equal(r.cu.controlling, 'other');
  }
});

test('CM-H19: late computer and desktop acquisition or Resume progress cannot cover a refusal or revive shutdown activity', async () => {
  for (const route of ['computer', 'desktop', 'resume'])
    for (const shutdown of [false, true]) {
      const pending = deferred<void>();
      const started = deferred<void>();
      const wait = () => {
        started.resolve();
        return pending.promise;
      };
      const r = make({ helper: { acquireControl: wait, resumeControl: wait } });
      const desktop = new DesktopControl({ helper: r.helper, cu: r.cu, grants: r.cu.grants, broker: r.cu.broker });
      if (route === 'resume') {
        r.cu.controlling = 'c';
        r.cu.paused('takeover');
      }
      const work =
        route === 'computer' ? r.cu.control('c', { name: 'B' }) : route === 'desktop' ? desktop.acquire('c', 'B') : r.cu.resume('c');
      await started.promise;
      await desktop.explain('c', denial());
      if (shutdown) r.cu.closed = true;
      const guide = r.activity.at(-1);
      pending.resolve();
      await work;
      assert.deepEqual(r.activity.at(-1), guide);
      await r.cu.release('c');
    }
});

test('CM-H19: a helper exit releases its hold without erasing an unresolved permission guide', async () => {
  for (const kind of ['codex', 'claude', 'acp']) {
    const r = rig({ kind });
    const { cu, helper, desktop } = r.runtime;
    // The service reads a scripted helper event; this unit test never starts a native helper.
    desktop.helperExited = async () => {};
    cu.controlling = 'c';
    cu.app = 'Notes';
    await desktop.explain('c', { reason: 'permission_denied', message: 'accessibility permission not granted' });
    const guide = r.patches.at(-1);
    assert.equal(guide[1].computer.state, 'permission');
    helper.emit('exit');
    assert.equal(cu.controlling, null);
    assert.deepEqual(r.patches.at(-1), guide, `${kind}: the chat-owned guide outlives the helper hold`);
  }
});

test('CM-H19: a permission guide outlives release and Stop, while native control is still released', async () => {
  for (const end of ['release', 'stop', 'retired turn']) {
    const { by, cu, activity, calls } = make({
      helper: {
        key: async () => {
          throw { reason: 'permission_denied', message: 'accessibility permission not granted' };
        },
      },
    });
    await assert.rejects(by.computer_key({ key: 'a' }, ctx), (e: any) => e.permission === 'accessibility');
    const guide = activity.at(-1);
    assert.equal(guide[1].state, 'permission');
    if (end === 'retired turn') {
      cu.holderLive = () => false;
      assert.equal(cu.liveHolder(), null);
      await new Promise((resolve) => setImmediate(resolve));
    } else await cu[end]('c');
    assert.equal(cu.controlling, null);
    assert.ok(calls.some((c) => c[0] === 'release'));
    assert.deepEqual(activity.at(-1), guide, 'turn cleanup must leave Try again available');
    cu.helper.permissionStatus = async () => ({ accessibility: true, screenRecording: true });
    assert.equal(await cu.recheck('c'), true);
    assert.deepEqual(activity.at(-1), ['c', null]);
  }
});

test('CM-H19: both read/refusal orders, including an old read rejection, preserve the permission guide and chat isolation', async () => {
  for (const holding of [false, true]) {
    for (const first of ['read', 'refusal']) {
      for (const readFails of [false, true]) {
        let refuse!: (e: Error) => void;
        const { by, cu, activity } = make({
          helper: {
            key: () =>
              new Promise((_resolve, reject) => {
                refuse = reject;
              }),
          },
        });
        if (holding) cu.controlling = 'c';
        let finish!: () => void;
        const reading = cu.reading(
          'c',
          { name: 'B' },
          {},
          () =>
            new Promise<void>((resolve, reject) => {
              finish = () => (readFails ? reject(new Error('old read failed')) : resolve());
            }),
        );
        const readDone = readFails ? assert.rejects(reading, /old read failed/) : reading;
        const denied = assert.rejects(by.computer_key({ key: 'a' }, ctx), (e: any) => e.permission === 'accessibility');
        await new Promise((resolve) => setImmediate(resolve));
        if (first === 'read') {
          finish();
          await readDone;
        }
        refuse(Object.assign(new Error('accessibility permission not granted'), { reason: 'permission_denied' }));
        await denied;
        const guide = activity.at(-1);
        if (first === 'refusal') {
          finish();
          await readDone;
        }
        assert.deepEqual(activity.at(-1), guide);
        await cu.reading('other', { name: 'B' }, {}, async () => {});
        assert.deepEqual(activity.at(-1), ['other', null], 'the block belongs only to its own chat');
        cu.closed = true;
        await cu.release('c');
        assert.deepEqual(activity.at(-1), ['c', null], 'shutdown invalidates the permission guide');
      }
    }
  }
});
