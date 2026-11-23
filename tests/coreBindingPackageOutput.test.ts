// Foreground package output uses actual ChildProcess ownership through ignored signals and naturally orphaned writers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { corePath, loadCore } = require('../electron/platform/core.cjs');
const { HarnessRuns } = require('../electron/harness/harnessRuns.cjs');
const { identityTable } = require('../electron/platform/processIdentity.cjs');
const { packageOutput } = require('../electron/harness/packageOutput.cjs');
const { spawnQuiet } = require('../electron/harness/quietRun.cjs');
const { retireGroup } = require('../electron/platform/winbin.cjs');
const { register } = require('../electron/app/ipc/harnessRuns.cjs');
const addon = loadCore(corePath());
const skip =
  process.platform === 'win32'
    ? 'Windows uses the explicit manual package workflow'
    : process.platform !== 'linux' &&
      !addon &&
      process.env.MOPILOT_CORE_REQUIRED !== '1' &&
      'the native binding supplies this platform process check';

test('the production IPC registrar runs foreground packages through the shared login environment and process owner', {
  skip,
  timeout: 10_000,
}, async () => {
  let output = '';
  const ended = deferred<any>();
  const runs = register(
    { handle() {}, on() {} },
    {
      live: { acpAdmission: { refresh: async () => undefined } },
      server: {},
      shellEnv: { childEnv: () => ({ ...process.env, MOPILOT_PACKAGE_BASE: 'shell', MOPILOT_PACKAGE_CHOICE: 'shell' }) },
      broadcastAll(channel: string, event: any) {
        if (channel === 'harnessRuns:data') output += event.data;
      },
    },
  );
  runs.onEnd((run: any) => ended.resolve(run));
  const started = runs.launch({
    kind: 'acp:foreground-test',
    purpose: 'install',
    via: 'npm',
    command: 'environment check',
    argv: [process.execPath, '-e', 'console.log(process.env.MOPILOT_PACKAGE_BASE + "/" + process.env.MOPILOT_PACKAGE_CHOICE)'],
    env: { MOPILOT_PACKAGE_CHOICE: 'run' },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const run = await ended.promise;
  assert.equal(run.code, 0);
  assert.equal(run.quiet, false, 'foreground remains visible');
  assert.match(output, /shell\/run/);
  await runs.close();
});

for (const natural of [false, true])
  test(`actual foreground package ${natural ? 'natural exit' : 'Stop'} retires a writing child before releasing the package lock`, {
    skip,
    timeout: 20_000,
  }, async (t) => {
    assert.ok(addon || process.platform === 'linux', 'the native core or Linux proc reader supplies exact identities');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-package-output-'));
    const writes = path.join(dir, 'writes');
    const gate = path.join(dir, 'contained');
    const writer = path.join(dir, 'writer.cjs');
    const parent = path.join(dir, 'parent.cjs');
    fs.writeFileSync(
      writer,
      `const fs = require('node:fs');
process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {});
setInterval(() => fs.appendFileSync(process.argv[2], '.'), 5);
fs.appendFileSync(process.argv[2], '.'); process.stdout.write('ready');
`,
    );
    fs.writeFileSync(
      parent,
      `const fs = require('node:fs');
process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {});
const timer = setInterval(() => { if (!fs.existsSync(process.argv[4])) return; clearInterval(timer);
 const child = require('node:child_process').spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: ['ignore', 'pipe', 'inherit'] });
 child.stdout.once('data', () => { process.stdout.write('OWN ' + child.pid + '\\n'); ${natural ? 'setTimeout(() => process.exit(0), 100);' : 'setInterval(() => {}, 1000);'} });
}, 5);
`,
    );
    const ready = deferred<void>();
    const ended = deferred<any>();
    let child: any;
    let root: number | undefined;
    let output = '';
    let complete = false;
    const runs = new HarnessRuns({
      pty: packageOutput((argv: string[], options: any, handlers: any) =>
        spawnQuiet(argv, options, handlers, {
          spawn: (...args: any[]) => {
            child = (spawn as any)(...args);
            root = child.pid;
            return child;
          },
        }),
      ),
      home: () => dir,
      afterExit: async () => undefined,
      broadcast(channel: string, payload: any) {
        if (channel !== 'harnessRuns:data') return;
        output += payload.data;
        if (/OWN (\d+)/.test(output)) ready.resolve();
      },
    });
    runs.onEnd((run: any) => ended.resolve(run));
    const started = runs.launch({
      kind: 'acp:foreground-test',
      purpose: 'install',
      via: 'npm',
      command: 'package test',
      argv: [process.execPath, parent, writer, writes, gate],
      cwd: dir,
      env: { ...process.env },
    });
    t.after(async () => {
      if (child) await retireGroup(child);
      if (complete) fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.ok(root);
    fs.writeFileSync(gate, 'ready');
    await ready.promise;
    const writerPid = Number(/OWN (\d+)/.exec(output)![1]);
    if (!natural) runs.stop(started.run.id);
    assert.equal(runs.list()[0].state, 'running');
    assert.equal(runs.launch({ kind: 'claude', purpose: 'install', via: 'npm', command: 'next', argv: ['next'] }).error, 'busy');
    const result = await ended.promise;
    assert.equal(result.code, natural ? 0 : null);
    const rows = await identityTable();
    assert.equal(
      rows.some(([pid]: number[]) => pid === root || pid === writerPid),
      false,
    );
    const bytes = fs.statSync(writes).size;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.statSync(writes).size, bytes);
    complete = true;
  });
