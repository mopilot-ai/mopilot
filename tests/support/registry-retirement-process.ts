// Real package-process cases shared by Linux fallback unit tests and the native-core binding's platform checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { deferred } from './async-scenarios.ts';
const require = createRequire(import.meta.url);
const { HarnessRuns } = require('../../electron/harness/harnessRuns.cjs');
const { spawnQuiet } = require('../../electron/harness/quietRun.cjs');
const { registryPackageRun } = require('../../electron/harness/registry/packageRun.cjs');
const { processTable } = require('../../electron/platform/processTree.cjs');
const { retireGroup } = require('../../electron/platform/winbin.cjs');

export function registerRetirementProcessTests(skip: boolean | string) {
  for (const natural of [false, true])
    test(`real package ${natural ? 'natural root exit with inherited pipes' : 'Stop with ignored TERM'} waits for its writing descendant`, {
      skip,
      timeout: 20_000,
    }, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-registry-retirement-'));
      const output = path.join(dir, 'writes');
      const gate = path.join(dir, 'contained');
      const writer = path.join(dir, 'writer.cjs');
      const parent = path.join(dir, 'parent.cjs');
      fs.writeFileSync(
        writer,
        `process.on('SIGTERM', () => {});
const fs = require('node:fs');
fs.appendFileSync(process.argv[2], '.');
setInterval(() => fs.appendFileSync(process.argv[2], '.'), 5);
process.stdout.write('ready');
`,
      );
      fs.writeFileSync(
        parent,
        `process.on('SIGTERM', () => {});
const fs = require('node:fs');
const gate = setInterval(() => {
 if (!fs.existsSync(process.argv[4])) return;
 clearInterval(gate);
 const child = require('node:child_process').spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: ['ignore', 'pipe', 'inherit'] });
 child.stdout.once('data', () => {
   process.stdout.write('OWN ' + process.pid + ' ' + child.pid + '\\n');
   ${natural ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'}
 });
}, 5);
`,
      );
      let child: any;
      let writerPid: number | null = null;
      let complete = false;
      const ready = deferred<void>();
      const runs = new HarnessRuns({
        pty: {},
        home: os.tmpdir,
        broadcast() {},
        afterExit: async () => undefined,
        spawnQuiet: (argv: string[], options: any, handlers: any) =>
          spawnQuiet(
            argv,
            options,
            {
              ...handlers,
              onData: (data: string) => {
                handlers.onData(data);
                const found = /OWN (\d+) (\d+)/.exec(data);
                if (found) {
                  writerPid = Number(found[2]);
                  ready.resolve();
                }
              },
            },
            { spawn: (...args: any[]) => (child = (spawn as any)(...args)) },
          ),
      });
      const controller = new AbortController();
      const work = registryPackageRun(runs, 'real-writer', {
        via: 'npm',
        argv: [process.execPath, parent, writer, output, gate],
        cwd: dir,
        env: { ...process.env },
        signal: controller.signal,
      });
      const outcome = natural ? work : assert.rejects(work, /cancelled/);
      t.after(async () => {
        if (!complete) controller.abort();
        if (child) await retireGroup(child);
        await outcome;
        if (complete) fs.rmSync(dir, { recursive: true, force: true });
      });
      fs.writeFileSync(gate, 'ready');
      await ready.promise;
      if (!natural) controller.abort();
      assert.equal(runs.list()[0].state, 'running');
      assert.equal(
        runs.launch({ kind: 'other', purpose: 'install', via: 'npm', command: 'npm install', argv: ['npm', 'install'] }).error,
        'busy',
      );
      await outcome;
      assert.equal(runs.list()[0].state, 'exited');
      assert.equal(runs.list()[0].code, natural ? 0 : null);
      const rows = await processTable();
      assert.equal(
        rows.some(([pid]: number[]) => pid === child.pid || pid === writerPid),
        false,
      );
      const bytes = fs.statSync(output).size;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fs.statSync(output).size, bytes, 'no postinstall writer remains after ownership is released');
      complete = true;
    });
}
