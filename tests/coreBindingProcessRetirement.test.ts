// The real POSIX process-identity reader is exercised through actual package-process owners; Windows uses explicit manual execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { registerRetirementProcessTests } from './support/registry-retirement-process.ts';
import { waitForRecordedProcess } from './support/recorded-process.ts';
const require = createRequire(import.meta.url);
const { corePath, loadCore, coreCall } = require('../electron/platform/core.cjs');
const { identityTable } = require('../electron/platform/processIdentity.cjs');
const { TreeWatcher } = require('../electron/platform/processTree.cjs');
const { spawnGroup, retireGroup } = require('../electron/platform/winbin.cjs');
const addon = loadCore(corePath());
const skip = !addon && process.env.MOPILOT_CORE_REQUIRED !== '1' && 'a native binding is required for this platform process check';

test('the required binding supplies coherent stable process birth identities', { skip: skip || process.platform === 'win32' }, async () => {
  assert.ok(addon, 'the requested native core loads');
  const first = await coreCall('proc.identities', addon);
  const own = first.find(([pid]: number[]) => pid === process.pid);
  assert.equal(own[1], process.ppid);
  assert.equal(typeof own[3], 'string');
  assert.notEqual(own[3], '');
  const second = await coreCall('proc.identities', addon);
  assert.deepEqual(
    second.find(([pid]: number[]) => pid === process.pid),
    own,
  );
});
registerRetirementProcessTests(process.platform === 'win32' ? 'Windows uses the explicit manual package workflow' : skip);

test('a recorded real writer keeps the same birth across setsid and retires after its parent exits', {
  skip: process.platform === 'win32' || (process.platform !== 'linux' && skip),
  timeout: 20_000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-recorded-group-move-'));
  const writer = path.join(dir, 'writer.py');
  const parent = path.join(dir, 'parent.cjs');
  const ready = path.join(dir, 'ready');
  const move = path.join(dir, 'move');
  const moved = path.join(dir, 'moved');
  const exit = path.join(dir, 'exit');
  const writes = path.join(dir, 'writes');
  fs.writeFileSync(
    writer,
    `import os, signal, sys, time
from pathlib import Path
ready, move, moved, writes = map(Path, sys.argv[1:])
signal.signal(signal.SIGTERM, lambda *_: None)
ready.write_text(str(os.getpid()) + '\\n')
while not move.exists(): time.sleep(0.01)
os.setsid()
moved.write_text('moved')
while True:
    with writes.open('a') as output: output.write('.')
    time.sleep(0.005)
`,
  );
  fs.writeFileSync(
    parent,
    `const fs = require('node:fs');
require('node:child_process').spawn('/usr/bin/python3', process.argv.slice(2), { stdio: 'ignore' });
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(exit)})) { clearInterval(timer); process.exit(0); } }, 5);
`,
  );
  const root = spawnGroup(spawn, process.execPath, [parent, writer, ready, move, moved, writes], { managed: true, stdio: 'ignore' });
  const watcher = new TreeWatcher({ table: identityTable, setTimer: () => null });
  const watch = watcher.watch(root.pid);
  let writerPid: number | undefined;
  let birth: string | undefined;
  let complete = false;
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'the controlled writer reaches its next phase');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  t.after(async () => {
    watch.stop();
    if (!complete) await retireGroup(root);
    if (complete) fs.rmSync(dir, { recursive: true, force: true });
  });
  ({ pid: writerPid, birth } = await waitForRecordedProcess({ ready, watcher, watch }));
  root.watch.known = watch.known;
  root.watch.births = watch.births;
  watch.stop();
  fs.writeFileSync(move, 'move');
  await until(() => fs.existsSync(moved) && fs.existsSync(writes));
  const movedRow = (await identityTable()).find(([pid]: number[]) => pid === writerPid);
  assert.equal(movedRow[3], birth);
  assert.equal(movedRow[2], writerPid);
  const closed = new Promise((resolve) => root.once('close', resolve));
  fs.writeFileSync(exit, 'exit');
  await closed;
  await retireGroup(root);
  assert.equal(
    (await identityTable()).some(([pid]: number[]) => pid === writerPid),
    false,
  );
  const bytes = fs.statSync(writes).size;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.statSync(writes).size, bytes);
  complete = true;
});
