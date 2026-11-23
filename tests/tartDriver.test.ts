// The real `tart` commands behind the sandbox VM manager (host/src/tartDriver.mjs), over a runner that records them: nothing starts a VM here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createTartDriver } from '../host/src/tartDriver.mjs';

type Row = { Name: string; Running?: boolean; State?: string };
function rig(rows: Row[] = [], over: { fail?: string; stderr?: string } = {}) {
  const calls: string[] = [];
  const started: string[][] = [];
  let clock = 0;
  const driver = createTartDriver({
    exec: async (_bin: string, args: string[]) => {
      calls.push(args.join(' '));
      if (over.fail && args[0] === over.fail) return { code: 2, stdout: '', stderr: over.stderr ?? 'boom' };
      if (args[0] === 'list') return { code: 0, stdout: JSON.stringify(rows), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    start: (_bin: string, args: string[]) => void started.push(args),
    sleep: async () => void (clock += 60_000),
    now: () => clock,
  });
  return { driver, calls, started, rows };
}

test('list, exists and running read tart’s own list, local guests only, running by flag or state', async () => {
  const r = rig([
    { Name: 'a', Running: true },
    { Name: 'b', State: 'running' },
    { Name: 'c', Running: false },
    { Name: 'd', State: 'stopped' },
  ]);
  assert.equal(await r.driver.exists('c'), true);
  assert.equal(await r.driver.exists('zzz'), false);
  assert.deepEqual(await r.driver.running(), ['a', 'b']);
  assert.equal(r.calls[0], 'list --source local --format json');
});

test('clone, suspend and delete are the tart commands; delete stops a running guest first, and a stop that fails preserves it for retry', async () => {
  const r = rig([{ Name: 'g', Running: true }]);
  await r.driver.clone('golden', 'g2');
  await r.driver.suspend('g');
  await r.driver.remove('g');
  assert.deepEqual(
    r.calls.filter((c) => !c.startsWith('list')),
    ['clone golden g2', 'suspend g', 'stop g --timeout 10', 'delete g'],
  );
  const idle = rig([{ Name: 'g', Running: false }]);
  await idle.driver.remove('g');
  assert.deepEqual(
    idle.calls.filter((c) => !c.startsWith('list')),
    ['delete g'],
  );
  const stuck = rig([{ Name: 'g', Running: true }], { fail: 'stop' });
  await assert.rejects(stuck.driver.remove('g'), /tart stop failed/);
  assert.ok(!stuck.calls.includes('delete g'));
});

test('run boots headless and returns once the guest shows as running and has an address', async () => {
  const r = rig([{ Name: 'g', Running: true }]);
  await r.driver.run('g');
  assert.deepEqual(r.started, [
    ['run', '--no-graphics', '--no-audio', '--suspendable', '--no-clipboard', '--no-usb-accessories', '--net-softnet', 'g'],
  ]);
  assert.ok(r.calls.includes('ip g --wait 90'));
});

test('a guest that never shows as running is said so; a tart command that fails says what it said; a list that is not a list is refused', async () => {
  const never = rig([{ Name: 'g', Running: false }]);
  await assert.rejects(never.driver.run('g'), /did not happen within 120 s/);
  const failing = rig([], { fail: 'clone', stderr: 'no space left\n' });
  await assert.rejects(failing.driver.clone('a', 'b'), /tart clone failed: no space left/);
  const quiet = rig([], { fail: 'suspend', stderr: '' });
  await assert.rejects(quiet.driver.suspend('a'), /tart suspend failed: exit 2/);
  const odd = createTartDriver({ exec: async () => ({ code: 0, stdout: '{}', stderr: '' }) });
  await assert.rejects(odd.list(), /did not answer a list/);
});

test('with a real process behind it (a stand-in for tart): the command runs, a guest started detached shows as running, a missing binary and a failing exit are errors', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tart-fake-'));
  const bin = path.join(dir, 'tart');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
  list) if [ -f "${dir}/started" ]; then echo '[{"Name":"g","Running":true}]'; else echo '[{"Name":"g","Running":false}]'; fi ;;
  run) touch "${dir}/started" ;;
  ip) echo 1.2.3.4 ;;
  *) echo nope >&2; exit 3 ;;
esac
`,
    { mode: 0o755 },
  );
  try {
    const driver = createTartDriver({ bin });
    assert.deepEqual(await driver.running(), []);
    await driver.run('g');
    assert.deepEqual(await driver.running(), ['g']);
    await assert.rejects(driver.clone('a', 'b'), /tart clone failed: nope/);
    await assert.rejects(createTartDriver({ bin: path.join(dir, 'missing') }).list(), /tart list failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const bad of [
  null,
  [],
  {},
  { Name: '' },
  { Name: '   ', Running: true },
  { Name: 4, Running: true },
  { Name: 'bad' },
  { Name: 'bad', Running: null },
  { Name: 'bad', State: 'unknown' },
  { Name: 'bad', Running: true, State: 'stopped' },
  { Name: 'bad', Running: false, State: 'running' },
  { Name: 'bad', Running: true, State: 'unknown' },
  { Name: 'bad', Running: 'yes', State: 'running' },
]) {
  test(`ambiguous inventory ${JSON.stringify(bad)} prevents every driver mutation`, async () => {
    const rows = [{ Name: 'golden', Running: false }, bad];
    const r = rig(rows as any);
    for (const action of [
      () => r.driver.list(),
      () => r.driver.clone('golden', 'new'),
      () => r.driver.run('new'),
      () => r.driver.suspend('golden'),
      () => r.driver.remove('golden'),
    ])
      await assert.rejects(action(), /inventory/);
    assert.equal(r.started.length, 0);
    assert.equal(
      r.calls.every((c) => c.startsWith('list ')),
      true,
    );
  });
}

test('duplicate inventory names fail closed, and supported suspended/state+flag rows are accepted', async () => {
  const duplicate = rig([
    { Name: 'a', Running: true },
    { Name: 'a', Running: false },
  ]);
  await assert.rejects(duplicate.driver.list(), /inventory/);
  const valid = rig([
    { Name: 'a', Running: true, State: 'running' },
    { Name: 'b', Running: false, State: 'stopped' },
    { Name: 'c', State: 'suspended' },
  ]);
  assert.deepEqual(await valid.driver.list(), [
    { name: 'a', running: true },
    { name: 'b', running: false },
    { name: 'c', running: false },
  ]);
});

test('manager acquire/release/destroy refuse mixed malformed inventory before any VM effects', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  // @ts-ignore: plain ESM without declarations
  const { createSandboxVms } = await import('../host/src/sandboxVms.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-manager-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const bad of [{ Running: true }, { Name: 'unknown-state' }]) {
    const r = rig([{ Name: 'golden', Running: false }, bad] as any);
    const manager = createSandboxVms({ tart: r.driver, golden: 'golden', file: path.join(dir, 'registry.json') });
    for (const action of [() => manager.acquire('chat'), () => manager.release('chat'), () => manager.destroy('chat')])
      await assert.rejects(action(), /inventory/);
    assert.equal(r.started.length, 0);
    assert.equal(
      r.calls.every((c) => c.startsWith('list ')),
      true,
    );
    assert.equal(fs.existsSync(path.join(dir, 'registry.json')), false);
  }
});

test('the default poll waits for observed running state before requesting the guest address', async () => {
  const calls: string[] = [];
  let started = false;
  let ready = false;
  let observed!: () => void;
  const pendingInventory = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const driver = createTartDriver({
    start: () => {
      started = true;
      calls.push('start');
    },
    exec: async (_bin: string, args: string[]) => {
      calls.push(args[0]);
      if (args[0] === 'list') {
        const stdout = JSON.stringify([{ Name: 'g', Running: ready }]);
        if (started && !ready) observed();
        return { code: 0, stdout, stderr: '' };
      }
      return { code: 0, stdout: '192.0.2.1', stderr: '' };
    },
  });
  // Keep the real default timer: detached process scheduling must not decide whether polling is covered.
  const running = driver.run('g');
  await pendingInventory;
  assert.equal(calls.includes('ip'), false, 'a started process alone does not prove the guest is running');
  ready = true;
  await running;
  assert.deepEqual(calls, ['list', 'start', 'list', 'list', 'ip']);
});

const BAD_NAMES: unknown[] = [
  '',
  ' ',
  '-x',
  '--help',
  'a/b',
  '/abs',
  '../x',
  'x/../mopilot-work',
  'a..b',
  'a b',
  'a\0b',
  'x'.repeat(65),
  'é',
  123,
  null,
  undefined,
  {},
];

test('a VM name that is not a plain name is refused before any tart command, so it cannot reach another VM’s directory', async () => {
  for (const bad of BAD_NAMES) {
    for (const call of ['run', 'suspend', 'remove'] as const) {
      const r = rig([{ Name: 'mopilot-bench', Running: true }]);
      await assert.rejects((r.driver as any)[call](bad), /not a valid VM name/, `${call} ${String(bad)}`);
      assert.deepEqual(r.calls, [], `${call} ${String(bad)} ran no tart command`);
    }
    const r = rig([]);
    await assert.rejects(r.driver.clone('golden', bad as any), /not a valid VM name/, `clone to ${String(bad)}`);
    assert.deepEqual(r.calls, []);
  }
});

test('a clone source is a plain name or an image reference, never a path out of the image store', async () => {
  for (const bad of ['', '-x', '../x', 'a/../b', 'ghcr.io/../x', 'ghcr.io//x', '/abs', 'ghcr.io/x/', 'a b', 'ghcr.io/x@@y']) {
    const r = rig([]);
    await assert.rejects(r.driver.clone(bad, 'mopilot-sbx-0123456789ab'), /not a valid (VM name|image reference)/, bad);
    assert.deepEqual(r.calls, [], bad);
  }
  for (const good of [
    'golden',
    'ghcr.io/cirruslabs/macos-tahoe-base:latest',
    'ghcr.io/cirruslabs/macos-tahoe-base@sha256:4aaa751fa7538902d73c767f27a066fc87e83f183069da4e4b5022863abd4c77',
    'localhost:5000/team/img:v1',
  ]) {
    const r = rig([]);
    await r.driver.clone(good, 'mopilot-sbx-0123456789ab');
    assert.ok(
      r.calls.some((c) => c.startsWith(`clone ${good} `)),
      good,
    );
  }
});

test('the names the manager makes pass', async () => {
  const r = rig([{ Name: 'mopilot-sbx-0123456789ab', Running: true }]);
  await r.driver.suspend('mopilot-sbx-0123456789ab');
  await r.driver.remove('mopilot-sbx-0123456789ab');
  assert.ok(r.calls.includes('suspend mopilot-sbx-0123456789ab'));
  assert.ok(r.calls.includes('delete mopilot-sbx-0123456789ab'));
});
