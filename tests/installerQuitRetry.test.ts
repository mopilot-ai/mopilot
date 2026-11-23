// A no-window package install retries failed process verification on a second Quit through the actual shared owners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { tick } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { installerQuitHold } = require('../electron/app/installerQuit.cjs');
const { HarnessRuns } = require('../electron/harness/harnessRuns.cjs');
const { spawnQuiet } = require('../electron/harness/quietRun.cjs');

test('a repeated Quit retries an unavailable monitor without releasing or replacing the original drain', async (t) => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  let attempts = 0;
  let quits = 0;
  let output = '';
  const runs = new HarnessRuns({
    home: () => '/tmp',
    platform: 'darwin',
    pty: {},
    afterExit: () => assert.fail('no shutdown probe'),
    broadcast(channel: string, event: any) {
      if (channel === 'harnessRuns:data') output += event.data;
    },
    spawnQuiet: (argv: string[], options: any, events: any) =>
      spawnQuiet(argv, options, events, {
        spawn: () => child,
        args: (bin: string, args: string[], options: any) => [bin, args, options],
        kill: async () => {
          if (++attempts === 1) throw new Error('monitor unavailable');
        },
      }),
  });
  const run = runs.launch({
    kind: 'acp:kimi',
    purpose: 'update',
    via: 'npm',
    command: 'npm update',
    argv: ['npm', 'update'],
    quiet: true,
  }).run;
  t.after(async () => {
    runs.stop(run.id);
    child.emit('close', 0);
    await tick();
  });
  const hold = installerQuitHold({ defer: (fn: Function) => fn() });
  const event = { preventDefault() {} };
  assert.equal(
    hold(event, runs, null, () => {
      quits++;
    }),
    true,
  );
  const drain = runs.draining;
  child.emit('close', 0);
  await tick();
  await tick();
  assert.match(output, /cleanup failed: Monitor unavailable\./);
  assert.equal(quits, 0);
  assert.equal(runs.attach(run.id).run.state, 'running');
  assert.equal(
    hold(event, runs, null, () => {
      quits++;
    }),
    true,
  );
  await tick();
  await tick();
  assert.equal(attempts, 2, 'the second Quit must retry the failed process verification');
  assert.equal(runs.draining, drain);
  assert.equal(quits, 1);
});
