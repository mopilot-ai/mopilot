// Registry package work keeps the actual shared run and manager lock until child closure and process-tree retirement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { agent, fakeInstall, which } from './support/acp-registry.ts';
import { registerRetirementProcessTests } from './support/registry-retirement-process.ts';
import { deferred } from './support/async-scenarios.ts';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { HarnessRuns } = require('../electron/harness/harnessRuns.cjs');
const { spawnQuiet } = require('../electron/harness/quietRun.cjs');
const { registryPackageRun } = require('../electron/harness/registry/packageRun.cjs');
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const reason of ['stop', 'timeout', 'natural'] as const)
  test(`${reason} retains the real registry run and npm lock until child close and tree retirement`, async (t) => {
    const clock = useFakeClock(t);
    const retired = deferred<void>();
    const children: any[] = [];
    let stops = 0;
    const runs = new HarnessRuns({
      pty: { spawn() {}, write() {}, resize() {}, kill() {} },
      home: os.tmpdir,
      broadcast() {},
      afterExit: async () => undefined,
      spawnQuiet: (argv: string[], options: any, handlers: any) =>
        spawnQuiet(argv, options, handlers, {
          spawn: () => {
            const child: any = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
            children.push(child);
            return child;
          },
          args: (bin: string, args: string[], options: any) => [bin, args, options],
          kill: () => {
            stops++;
            return retired.promise;
          },
        }),
    });
    const controller = new AbortController();
    let outcome = 'pending';
    const work = registryPackageRun(runs, 'first', {
      via: 'npm',
      argv: ['npm', 'install'],
      cwd: os.tmpdir(),
      signal: controller.signal,
    }).then(
      () => {
        outcome = 'success';
      },
      () => {
        outcome = 'rejected';
      },
    );
    t.after(async () => {
      retired.resolve();
      for (const child of children) child.emit('close', null);
      await work;
    });
    if (reason === 'stop') controller.abort();
    else if (reason === 'timeout') clock.advance(10 * 60_000);
    else children[0].emit('exit', 0);
    await turn();
    assert.equal(stops, 1);
    assert.equal(outcome, 'pending', 'requesting cancellation cannot release install ownership');
    assert.equal(runs.list()[0].state, 'running');
    assert.equal(
      runs.list()[0].stopped,
      reason !== 'natural',
      'timeouts and manual cancellation publish stopping while ownership is retained',
    );
    const spec = { kind: 'acp:registry-second', purpose: 'install', via: 'npm', command: 'npm install', argv: ['npm', 'install'] };
    assert.equal(runs.launch(spec).error, 'busy', 'a retry cannot overlap the retiring npm process');
    children[0].emit('close', 0);
    await turn();
    assert.equal(outcome, 'pending', 'root closure alone cannot release descendants still retiring');
    retired.resolve();
    await work;
    assert.equal(
      outcome,
      reason === 'natural' ? 'success' : 'rejected',
      'cancellation and natural completion keep their distinct outcomes after retirement',
    );
    assert.equal(runs.list()[0].state, 'exited');
    const retry = runs.launch(spec);
    assert.equal(retry.ok, true);
    runs.stop(retry.run.id);
    await turn();
  });

registerRetirementProcessTests(
  process.platform !== 'linux' && 'the JS fallback reads Linux /proc; other platforms run these cases with the native binding',
);

test('registry disposal drains the actual current package and queued ownership before staging cleanup completes', async (t) => {
  const { RegistryHarnesses } = require('../electron/harness/registry/service.cjs');
  const retired = deferred<void>();
  const child: any = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-registry-drain-'));
  let stage = '';
  let packageCache = '';
  let catalogCloses = 0;
  const runs = new HarnessRuns({
    pty: {},
    home: os.tmpdir,
    broadcast() {},
    afterExit: async () => undefined,
    spawnQuiet: (argv: string[], options: any, handlers: any) =>
      spawnQuiet(argv, options, handlers, {
        spawn: () => child,
        args: (bin: string, args: string[], options: any) => [bin, args, options],
        kill: () => retired.promise,
      }),
  });
  const service = new RegistryHarnesses({
    dir,
    platform: 'linux',
    arch: 'x64',
    which,
    catalog: {
      agents: [agent('first'), agent('second')],
      dispose() {
        catalogCloses++;
      },
    },
    install: async (o: any) => {
      stage = o.stage;
      packageCache = o.packageCache;
      fs.mkdirSync(packageCache, { recursive: true });
      await registryPackageRun(runs, o.agent.id, { via: 'npm', argv: ['npm', 'install'], cwd: stage, signal: o.signal });
      return fakeInstall(o);
    },
  });
  const first = service.install('first', () => {});
  const second = service.install('second', () => {});
  const rejectedFirst = assert.rejects(first, /cancelled/);
  const rejectedSecond = assert.rejects(second, /closed/);
  t.after(async () => {
    retired.resolve();
    child.emit('close', null);
    await Promise.all([rejectedFirst, rejectedSecond]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await turn();
  const drain = service.dispose();
  let drained = false;
  const observed = Promise.resolve(drain).then(() => {
    drained = true;
  });
  await turn();
  assert.equal(drained, false, 'disposal cannot claim completion while an install process still owns its stage');
  assert.equal(fs.existsSync(stage), true);
  assert.equal(fs.existsSync(packageCache), true);
  assert.equal(runs.list()[0].state, 'running');
  assert.equal(service.dispose(), drain, 'repeated disposal shares the current drain');
  child.emit('close', 0);
  await turn();
  assert.equal(drained, false, 'root close still leaves the managed descendants retiring');
  assert.equal(fs.existsSync(packageCache), true);
  retired.resolve();
  await Promise.all([observed, rejectedFirst, rejectedSecond]);
  assert.equal(catalogCloses, 1);
  assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.existsSync(packageCache), false);
  assert.equal(fs.existsSync(service.file), false);
});
