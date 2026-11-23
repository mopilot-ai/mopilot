// Every unit test file carries an exit watchdog (tests/support/exit-watchdog.ts, started by register.ts): a file whose
// tests passed but which stays alive on a leaked timer or socket fails with what is open, instead of stalling the run (#1759).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { armExitWatchdog, DEFAULT_GRACE_MS, exitGraceMs, openResources, startExitWatchdog } from './support/exit-watchdog.ts';

export const GUARDS = ['package.json', 'tests/support/'];

const ROOT = path.join(import.meta.dirname, '..');
const REGISTER = path.join(ROOT, 'tests/support/register.ts');

/** Runs one test file under node --test with the register hook and a short grace. */
function runTestFile(t: import('node:test').TestContext, source: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'exit-watchdog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'case.test.ts');
  writeFileSync(file, source);
  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    ['--test', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', REGISTER, file],
    // a run of its own, not a child of this one
    {
      cwd: ROOT,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, UNIT_TEST_EXIT_GRACE_MS: '1000' },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  return { ...r, ms: Date.now() - started };
}

test('the grace is UNIT_TEST_EXIT_GRACE_MS when it is a positive number, else 15 seconds', () => {
  assert.equal(DEFAULT_GRACE_MS, 15_000);
  assert.equal(exitGraceMs({ UNIT_TEST_EXIT_GRACE_MS: '500' }), 500);
  for (const v of [undefined, '', '0', '-5', 'soon']) assert.equal(exitGraceMs({ UNIT_TEST_EXIT_GRACE_MS: v }), 15_000);
});

test('open resources are counted by kind', () => {
  assert.equal(openResources(['Timeout', 'TCPSocketWrap', 'Timeout']), 'Timeout ×2, TCPSocketWrap');
  assert.equal(openResources([]), 'nothing node reports');
});

test('the armed timer is unreferenced; when it fires it names the file and what is open, and exits 1', () => {
  let fire: () => void = () => {};
  let unrefs = 0;
  const written: string[] = [];
  const exits: number[] = [];
  armExitWatchdog({
    ms: 2000,
    resources: () => ['Timeout', 'PipeWrap'],
    write: (s) => written.push(s),
    exit: (c) => exits.push(c),
    setTimer: (fn) => {
      fire = fn;
      return { unref: () => unrefs++ };
    },
    what: 'tests/x.test.ts',
  });
  assert.equal(unrefs, 1);
  assert.deepEqual(exits, []);
  fire();
  assert.match(
    written[0],
    /\[exit-watchdog\] tests\/x\.test\.ts finished its tests but was still running 2s later\. Still open: Timeout, PipeWrap\./,
  );
  assert.deepEqual(exits, [1]);
});

test('only a node --test process running a test file arms it, once its tests are done', () => {
  const hooks: (() => void)[] = [];
  const hook = (fn: () => void) => hooks.push(fn);
  assert.equal(startExitWatchdog({}, '/r/tests/a.test.ts', hook), false);
  // a script a test started inherits the context but is not a test file
  assert.equal(startExitWatchdog({ NODE_TEST_CONTEXT: 'child-v8' }, '/r/scripts/x.mjs', hook), false);
  assert.equal(startExitWatchdog({ NODE_TEST_CONTEXT: 'child-v8' }, '', hook), false);
  assert.equal(hooks.length, 0);
  assert.equal(startExitWatchdog({ NODE_TEST_CONTEXT: 'child-v8' }, '/r/tests/a.test.ts', hook), true);
  assert.equal(hooks.length, 1);
});

test('a file that passes but leaks a keepalive fails fast, naming the timer', (t) => {
  const r = runTestFile(t, "import { test } from 'node:test';\ntest('passes', () => { setInterval(() => {}, 20_000); });\n");
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /\[exit-watchdog\] .*case\.test\.ts finished its tests .*Still open: .*Timeout/);
  assert.ok(r.ms < 30_000, `took ${r.ms} ms`);
});

test('a file that cleans up exits as usual, with no watchdog output', (t) => {
  const r = runTestFile(t, "import { test } from 'node:test';\ntest('passes', () => { clearInterval(setInterval(() => {}, 20_000)); });\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /exit-watchdog/);
});
