// Registry package preparation follows main-owned install completion, cancellation and subscription cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registryPackageRun } = require('../electron/harness/registry/packageRun.cjs');

function fixture(extra: any = {}) {
  const controller = new AbortController();
  const listeners = new Set<Function>();
  const stops: string[] = [];
  const specs: any[] = [];
  const runs = {
    onEnd: (fn: Function) => (listeners.add(fn), () => listeners.delete(fn)),
    launch: (spec: any) => (specs.push(spec), { ok: true, run: { id: 'run' } }),
    stop: (id: string) => stops.push(id),
    list: () => [],
    ...extra,
  };
  return {
    controller,
    listeners,
    stops,
    specs,
    runs,
    spec: { via: 'npm', argv: ['/bin/npm', 'exec', 'a b'], cwd: '/staging', signal: controller.signal },
    end: (run: any) => [...listeners].forEach((fn) => fn(run)),
  };
}

test('successful completion waits for the current run and removes the completion and abort listeners', async () => {
  const f = fixture();
  const work = registryPackageRun(f.runs, 'example', f.spec);
  f.end({ id: 'other', code: 1 });
  assert.equal(f.listeners.size, 1);
  assert.equal(f.specs[0].kind, 'acp:registry-example');
  assert.equal(f.specs[0].cwd, '/staging');
  assert.equal(f.specs[0].command, "'/bin/npm' 'exec' 'a b'");
  assert.equal(f.specs[0].quiet, true);
  f.end({ id: 'run', code: 0 });
  await work;
  assert.equal(f.listeners.size, 0);
  f.controller.abort();
  assert.deepEqual(f.stops, []);
});

test('unavailable, busy, spawn failures, thrown launches and failed exits reject without leaking subscriptions', async () => {
  await assert.rejects(registryPackageRun(null, 'x', fixture().spec), /not ready/);
  for (const error of ['busy', 'spawn', 'throw', 'exit']) {
    const f = fixture({
      launch: () => {
        if (error === 'throw') throw new Error('thrown launch');
        return error === 'exit' ? { ok: true, run: { id: 'run' } } : { ok: false, error };
      },
    });
    const work = registryPackageRun(f.runs, 'x', f.spec);
    if (error === 'exit') f.end({ id: 'run', code: 1 });
    await assert.rejects(work, /running|could not start|thrown launch|did not install/);
    assert.equal(f.listeners.size, 0);
  }
});

test('immediate completion and abort during launch or after subscription cannot strand a pending install', async () => {
  const immediate = fixture({ list: () => [{ id: 'run', state: 'exited', checked: true, code: 0 }] });
  await registryPackageRun(immediate.runs, 'x', immediate.spec);
  assert.equal(immediate.listeners.size, 0);
  const aborted = fixture();
  aborted.controller.abort();
  assert.throws(() => registryPackageRun(aborted.runs, 'x', aborted.spec), /abort/i);
  for (const duringLaunch of [false, true]) {
    const f = fixture();
    if (duringLaunch) {
      const launch = f.runs.launch;
      f.runs.launch = (spec: any) => {
        f.controller.abort();
        return launch(spec);
      };
    }
    const work = registryPackageRun(f.runs, 'x', f.spec);
    if (!duringLaunch) f.controller.abort();
    assert.deepEqual(f.stops, ['run']);
    f.end({ id: 'run', stopped: true, code: 0 });
    await assert.rejects(work, /cancelled/);
    assert.equal(f.listeners.size, 0);
  }
});
