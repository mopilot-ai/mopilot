// A test process exits once the command that started it is gone, instead of running on as an orphan.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exitWithParent } from '../scripts/exit-with-parent.mjs';
import { EXIT_WITH_PARENT } from '../scripts/test-slots.mjs';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';

test('the watchdog polls the parent id, exits 143 once it changes, and never holds the process open', () => {
  const ids = [10, 10, 1];
  const exits: number[] = [];
  let tick = () => {};
  let unref = 0;
  const every = (fn: () => void, ms: number) => {
    assert.equal(ms, 1000);
    tick = fn;
    return { unref: () => unref++ };
  };
  exitWithParent({ ppid: () => ids.shift() as number, exit: (code: number) => exits.push(code), every: every as never });
  assert.equal(unref, 1);
  tick();
  assert.deepEqual(exits, []);
  tick();
  assert.deepEqual(exits, [143]);
});

test("a killed command takes its test runner and the runner's test files with it", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exit-with-parent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePid = path.join(dir, 'file.pid');
  // a test file that never ends, and says it is running
  writeFileSync(
    path.join(dir, 'hang.test.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(filePid)}, process.pid + '\\n'); setInterval(() => {}, 1000);`,
  );
  // the command: starts the runner as the coverage command and npm test do, prints its pid once the file runs, waits to be killed
  const command = `
    const { spawn } = require('node:child_process');
    const { readJsonLineLog } = require(${JSON.stringify(path.resolve('scripts/fixture-json-log.mjs'))});
    const runner = spawn(process.execPath, [...${JSON.stringify(EXIT_WITH_PARENT)}, '--test', 'hang.test.mjs'], { cwd: ${JSON.stringify(dir)}, stdio: 'ignore' });
    const ready = setInterval(() => { if (readJsonLineLog(${JSON.stringify(filePid)}).length) { clearInterval(ready); console.log(runner.pid); } }, 50);
    setInterval(() => {}, 1000);`;
  // a runner started inside a test file would otherwise act as that file's child instead of running its own files
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const parent = spawn(process.execPath, ['-e', command], { stdio: ['ignore', 'pipe', 'inherit'], env });
  const runnerPid = await new Promise<number>((resolve) => parent.stdout.once('data', (data) => resolve(Number(String(data).trim()))));
  const pids = [runnerPid, readJsonLineLog(filePid)[0]];
  parent.kill('SIGKILL');
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 15_000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const left = pids.filter(alive);
  for (const pid of left) process.kill(pid, 'SIGKILL');
  assert.deepEqual(left, [], 'the runner and its file exited by themselves');
});
