// CM-H19: recovery needs complete native permission evidence; local cleanup and retired calls cannot claim it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { make, ctx, shot } from './support/computer-tools-kit.ts';
import { rig as desktopRig } from './support/desktop-kit.ts';
import { rig as appRig } from './support/app-scoped-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { rig as setupRig } from './support/computer-use-setup-rig.ts';

export const GUARDS = ['electron/capabilities/'];

const require = createRequire(import.meta.url);
const { ComputerHelper } = require('../electron/capabilities/computer.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
const granted = { accessibility: true, screenRecording: true };
const denial = () => Object.assign(new Error('accessibility permission not granted'), { reason: 'permission_denied' });

test('CM-H19: a retired owner cannot clear the current guide at the final recovery boundary', () => {
  for (const retirement of ['refusal', 'recovery', 'lifecycle']) {
    const r = make();
    r.cu.showPermissionGuide('c', 'accessibility');
    const old = r.cu.permissionOwner('c');
    if (retirement === 'recovery') assert.equal(r.cu.clearPermissionGuide('c', old), true);
    if (retirement === 'lifecycle') {
      r.cu.closed = true;
      r.cu.closed = false;
    }
    r.cu.showPermissionGuide('c', 'screenRecording');
    r.cu.showPermissionGuide('other', 'accessibility');
    const guide = r.cu.blocked.get('c');
    const published = r.activity.slice();
    assert.equal(r.cu.clearPermissionGuide('c', old), false, retirement);
    assert.equal(r.cu.blocked.get('c'), guide);
    assert.equal(r.cu.blocked.get('other').permission, 'accessibility');
    assert.deepEqual(r.activity, published);
    assert.equal(r.cu.clearPermissionGuide('c', r.cu.permissionOwner('c')), true);
    assert.equal(r.cu.blocked.has('c'), false);
    assert.equal(r.cu.blocked.has('other'), true);
  }
});

test('CM-H19: unknown permission status never clears a guide through the real client wrapper', async () => {
  for (const status of [
    null,
    undefined,
    false,
    42,
    'not a permission report',
    [],
    {},
    { accessibility: true },
    { screenRecording: true },
    { accessibility: 'true', screenRecording: true },
    { accessibility: true, screenRecording: 1 },
  ]) {
    const native = new ComputerHelper({
      spawn: () => {
        throw new Error('no native launch');
      },
    });
    native.call = async () => status;
    const r = make({ helper: { permissionStatus: () => native.permissionStatus() } });
    r.cu.showPermissionGuide('c', 'accessibility');
    r.cu.showPermissionGuide('other', 'screenRecording');
    const owner = r.cu.permissionOwner('c');
    const guide = r.activity.at(-2);
    assert.equal(await r.cu.recheck('c'), false, JSON.stringify(status));
    assert.deepEqual(r.cu.permissionOwner('c'), owner);
    assert.equal(r.cu.blocked.get('c'), guide[1]);
    assert.equal(r.cu.blocked.get('other').permission, 'screenRecording');
    r.helper.permissionStatus = async () => ({ ...granted, inputMonitoring: false });
    assert.equal(await r.cu.recheck('c'), true);
    assert.equal(r.cu.blocked.has('c'), false);
  }
});

test('CM-H19: Stop, turn retirement and abort during unattended lookup cannot start a permission prompt', async () => {
  for (const retirement of ['stop', 'turn', 'abort', 'token']) {
    const pending = deferred<any>();
    const started = deferred<void>();
    const abort = new AbortController();
    let live = true;
    let lookups = 0;
    let requests = 0;
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
      if (++lookups === 1) return null;
      started.resolve();
      return pending.promise;
    };
    const work = assert.rejects(
      guarded({ token: {}, current: () => live }, () => r.by.computer_key({ key: 'a' }, { ...ctx, signal: abort.signal })),
    );
    await started.promise;
    if (retirement === 'stop') await r.cu.stop('c');
    else if (retirement === 'turn') r.cu.interrupt('c');
    else if (retirement === 'abort') abort.abort();
    else live = false;
    pending.resolve(null);
    await work;
    assert.equal(requests, 0, retirement);
    assert.equal(r.cu.blocked.get('c').permission, 'accessibility');
  }
});

test('CM-H19: a native prompt already in progress stays shared after its initiating chat stops', async () => {
  const pending = deferred<any>();
  const requested = deferred<void>();
  let requests = 0;
  const r = make({
    helper: {
      key: async () => {
        throw denial();
      },
      requestPermission: () => {
        requests++;
        requested.resolve();
        return pending.promise;
      },
    },
  });
  const first = assert.rejects(r.by.computer_key({ key: 'a' }, ctx));
  await requested.promise;
  await r.cu.stop('c');
  const second = assert.rejects(r.by.computer_key({ key: 'b' }, { chatId: 'other' }));
  pending.resolve({ accessibility: false });
  await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(r.cu.blocked.size, 2);
});

test('CM-H19: a native prompt completing after Stop or turn retirement never restarts an observation', async () => {
  for (const retirement of ['stop', 'turn', 'abort', 'token']) {
    const pending = deferred<any>();
    const requested = deferred<void>();
    const abort = new AbortController();
    let live = true;
    let shots = 0;
    const r = make({
      helper: {
        screenshot: async () => {
          if (++shots === 1) throw Object.assign(new Error('screenRecording permission not granted'), { reason: 'permission_denied' });
          return shot();
        },
        requestPermission: () => {
          requested.resolve();
          return pending.promise;
        },
      },
    });
    const work = guarded({ token: {}, current: () => live }, () => r.by.computer_screenshot({}, { ...ctx, signal: abort.signal })).then(
      () => null,
      (error: any) => error,
    );
    await requested.promise;
    if (retirement === 'stop') await r.cu.stop('c');
    else if (retirement === 'turn') r.cu.interrupt('c');
    else if (retirement === 'abort') abort.abort();
    else live = false;
    r.helper.running = false;
    pending.resolve({ screenRecording: true });
    const error = await work;
    assert.equal(r.calls.filter((call) => call[0] === 'start').length, 1, retirement);
    assert.equal(shots, 1, retirement);
    assert.equal(error.permission, 'screenRecording');
  }
});

test('CM-H19: local and fallback desktop successes retain recovery without an automatic probe', async () => {
  const cases: [string, any][] = [
    ['desktop_wait', { duration: 0 }],
    ['desktop_list_granted_applications', {}],
    ['desktop_request_access', { apps: ['Notes'] }],
    ['desktop_open_application', { app: 'Notes' }],
    ['desktop_switch_display', { display: 1 }],
    ['desktop_left_mouse_up', {}],
    ['desktop_cursor_position', {}],
    ['desktop_read_clipboard', {}],
    ['desktop_write_clipboard', { text: 'draft' }],
  ];
  for (const [tool, args] of cases) {
    const r = desktopRig();
    await r.ready();
    r.d.session('c1').clipboardRead = true;
    r.d.session('c1').clipboardWrite = true;
    let probes = 0;
    r.helper.permissionStatus = async (options: any) => {
      if (options?.noLaunch) probes++;
      return granted;
    };
    r.cu.showPermissionGuide('c1', 'accessibility');
    const guide = r.activity.at(-1);
    await r.call(tool, args);
    assert.equal(r.cu.blocked.has('c1'), true, tool);
    assert.deepEqual(r.activity.at(-1), guide, tool);
    assert.equal(probes, 0, tool);
  }
  const r = appRig();
  r.cu.showPermissionGuide('c1', 'accessibility');
  const guide = r.activity.at(-1);
  await r.call('desktop_app_release');
  assert.equal(r.helper.calls.length, 0);
  assert.deepEqual(r.activity.at(-1), guide);
  assert.equal(r.cu.blocked.has('c1'), true);
});

test('CM-H19: a successful native retry needs positive current status before clearing recovery', async () => {
  for (const status of [null, {}, { accessibility: false, screenRecording: true }, granted, new Error('status unavailable')]) {
    const r = make({
      helper: {
        permissionStatus: async () => {
          if (status instanceof Error) throw status;
          return status;
        },
      },
    });
    r.cu.showPermissionGuide('c', 'accessibility');
    await r.by.computer_screenshot({}, ctx);
    assert.equal(r.cu.blocked.has('c'), status !== granted);
  }
});

test('CM-H19: a batch with a failed final capture cannot use its successful envelope to clear recovery', async () => {
  const r = desktopRig();
  await r.ready();
  r.cu.showPermissionGuide('c1', 'screenRecording');
  r.helper.perms = { accessibility: true, screenRecording: false };
  r.helper.fail.screenshot = Object.assign(new Error('screenRecording permission not granted'), { reason: 'permission_denied' });
  const result = await r.call('desktop_batch', { actions: [{ action: 'wait', duration: 0 }] });
  assert.match(result.at(-1).text, /No screenshot after the batch/);
  assert.equal(r.cu.blocked.get('c1').permission, 'screenRecording');
});

test('CM-H19: desktop and app retries keep a guide when their native permission status is denied', async () => {
  const d = desktopRig();
  await d.ready();
  d.cu.showPermissionGuide('c1', 'accessibility');
  d.helper.perms = { accessibility: false, screenRecording: true };
  d.helper.fail.axSnapshot = denial(); // Screenshot content still succeeds after this caught failure.
  const image = await d.call('desktop_screenshot');
  assert.equal(image[0].type, 'image');
  assert.equal(d.cu.blocked.has('c1'), true);
  delete d.helper.fail.axSnapshot;
  d.helper.perms = granted;
  await d.call('desktop_screenshot');
  assert.equal(d.cu.blocked.has('c1'), false);

  const a = appRig();
  a.cu.showPermissionGuide('c1', 'accessibility');
  a.helper.answers['permissions.status'] = () => ({ accessibility: false, screenRecording: true });
  await a.call('desktop_app_screenshot', { app: 'Notes' });
  assert.equal(a.cu.blocked.has('c1'), true);
  a.helper.answers['permissions.status'] = () => granted;
  await a.call('desktop_app_screenshot', { app: 'Notes' });
  assert.equal(a.cu.blocked.has('c1'), false);
  assert.deepEqual(a.helper.calls.filter((c: any) => c.method === 'permissions.status').at(-1).opts, { noLaunch: true });
});

test('CM-H19: an automatic recovery read cannot overwrite a newer refusal, shutdown or stopped call', async () => {
  for (const retire of ['refusal', 'shutdown', 'stop']) {
    const pending = deferred<any>();
    const started = deferred<void>();
    const r = make({
      helper: {
        permissionStatus: (options: any) => {
          assert.deepEqual(options, { noLaunch: true });
          started.resolve();
          return pending.promise;
        },
      },
    });
    r.cu.showPermissionGuide('c', 'accessibility');
    const work = r.by.computer_screenshot({}, ctx);
    await started.promise;
    if (retire === 'refusal') r.cu.showPermissionGuide('c', 'screenRecording');
    else if (retire === 'shutdown') {
      r.cu.closed = true;
      r.cu.closed = false;
    } else await r.cu.stop('c');
    const last = r.activity.at(-1);
    pending.resolve(granted);
    await work;
    assert.deepEqual(r.activity.at(-1), last, retire);
    assert.equal(r.cu.blocked.has('c'), retire !== 'shutdown');
  }
});

test('CM-H19: automatic recovery and explicit Try again share the latest requested status owner', async () => {
  for (const automaticFirst of [false, true]) {
    const pending = deferred<any>();
    const started = deferred<void>();
    let reads = 0;
    const r = make({
      helper: {
        permissionStatus: () => {
          if (++reads === 1) {
            started.resolve();
            return pending.promise;
          }
          return Promise.resolve(granted);
        },
      },
    });
    r.cu.showPermissionGuide('c', 'accessibility');
    const old = automaticFirst ? r.by.computer_screenshot({}, ctx) : r.cu.recheck('c');
    await started.promise;
    if (automaticFirst) assert.equal(await r.cu.recheck('c'), true);
    else await r.by.computer_screenshot({}, ctx);
    const last = r.activity.at(-1);
    pending.resolve({ accessibility: false, screenRecording: true });
    await old;
    assert.deepEqual(r.activity.at(-1), last);
    assert.equal(r.cu.blocked.has('c'), false);
  }
});

test('CM-H19: helper exit before automatic proof never starts a replacement or sends a probe', async () => {
  const r = make();
  r.helper.screenshot = async () => {
    r.helper.running = false;
    return shot();
  };
  r.cu.showPermissionGuide('c', 'accessibility');
  await r.by.computer_screenshot({}, ctx);
  assert.equal(
    r.calls.some((call) => call[0] === 'permissionStatus'),
    false,
  );
  assert.equal(r.cu.blocked.has('c'), true);
});

test('CM-H19: a retired owner cannot dispatch a new native status read', async () => {
  const r = make();
  r.cu.showPermissionGuide('c', 'accessibility');
  const owner = r.cu.permissionOwner('c');
  let reads = 0;
  const read = async () => {
    reads++;
    return granted;
  };
  assert.equal(await r.cu.checkPermissionGuide('c', owner, read, () => false), false);
  r.cu.showPermissionGuide('c', 'screenRecording');
  assert.equal(await r.cu.checkPermissionGuide('c', owner, read), false);
  assert.equal(reads, 0);
});

test('CM-H19: a late Try again IPC after shutdown cannot restart the helper', async () => {
  const main = setupRig();
  const cu = main.runtime.cu;
  let reads = 0;
  cu.helper.freshPermissionStatus = async () => {
    reads++;
    return granted;
  };
  cu.closed = true;
  assert.equal(await main.ipc('computer:recheck', 'c'), false);
  assert.equal(reads, 0);
});
