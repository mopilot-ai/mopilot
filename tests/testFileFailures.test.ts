// scripts/test-file-failures.mjs: a test file that failed outside its tests is named with its exit and the work that outlived a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fileFailures, { fileFailure } from '../scripts/test-file-failures.mjs';

const REPORTER = fileURLToPath(new URL('../scripts/test-file-failures.mjs', import.meta.url));
const failure = (error: any) => ({ details: { error } });
const fileLevel = (o: object) => failure({ code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', exitCode: null, signal: null, ...o });

async function report(events: { type: string; data: any }[]) {
  let out = '';
  for await (const chunk of fileFailures(
    (async function* () {
      yield* events;
    })(),
  ))
    out += chunk;
  return out;
}

test('fileFailure: a signal is a crash, a nonzero exit is work outside a test, anything else is not a file-level failure', () => {
  assert.match(fileFailure(fileLevel({ signal: 'SIGSEGV' }))!, /killed by SIGSEGV .*crash in Node or V8, not a failed assertion/);
  assert.match(fileFailure(fileLevel({ signal: 'SIGBUS' }))!, /killed by SIGBUS .*crash in Node or V8/);
  // V8 aborts when the heap runs out; the system kills a process that takes too much memory
  assert.match(fileFailure(fileLevel({ signal: 'SIGABRT' }))!, /killed by SIGABRT .*out of memory .*or stopped from outside/);
  assert.match(
    fileFailure(fileLevel({ signal: 'SIGKILL' }))!,
    /killed by SIGKILL .*by the test watchdog \(its \[rss-watchdog\] or \[file-timeout\] line above says why\), out of memory/,
  );
  assert.match(fileFailure(fileLevel({ exitCode: 1 }))!, /exited with code 1 outside any test: an unhandled rejection/);
  assert.equal(fileFailure(fileLevel({ exitCode: 0 })), null);
  assert.equal(fileFailure(fileLevel({})), null, 'no exit code and no signal');
  assert.equal(fileFailure(fileLevel({ failureType: 'subtestsFailed', exitCode: 1 })), null, 'a failing test says why itself');
  assert.equal(fileFailure(failure(new Error('plain'))), null);
  assert.equal(fileFailure({}), null);
});

test('fileFailures: lists each file-level failure once the run ends, with the diagnostics about work that outlived its tests', async () => {
  const late = 'Error: Test "a" generated asynchronous activity after the test ended. ... triggered an unhandledRejection event.';
  const out = await report([
    { type: 'test:diagnostic', data: { file: '/t/late.test.ts', message: late } },
    { type: 'test:diagnostic', data: { file: '/t/late.test.ts', message: 'tests 2' } },
    { type: 'test:diagnostic', data: { message: 'uncaughtException somewhere, no file' } },
    { type: 'test:diagnostic', data: { file: '/t/late.test.ts', message: 'Error: uncaughtException in a timer' } },
    { type: 'test:fail', data: { name: 'a', file: '/t/plain.test.ts', ...failure(new Error('assertion')) } },
    { type: 'test:fail', data: { name: '/t/late.test.ts', file: '/t/late.test.ts', ...fileLevel({ exitCode: 1 }) } },
    { type: 'test:fail', data: { name: '/t/segv.test.ts', ...fileLevel({ signal: 'SIGSEGV' }) } },
    { type: 'test:pass', data: { name: 'b' } },
  ]);
  assert.equal(
    out,
    [
      '',
      'Whole-file failures (no failing test):',
      '✖ /t/late.test.ts: its process exited with code 1 outside any test: an unhandled rejection or exception, or work that outlived a test',
      `  ${late}`,
      '  Error: uncaughtException in a timer',
      '✖ /t/segv.test.ts: its process was killed by SIGSEGV before it finished: a crash in Node or V8, not a failed assertion (rerun it; docs/unit-coverage.md#whole-file-failures)',
      '',
    ].join('\n'),
  );
  assert.equal(await report([{ type: 'test:fail', data: { name: 'a', ...failure(new Error('x')) } }]), '', 'nothing to say');
});

test('fileFailures under node --test: a crashed file and one with a late rejection are named; a failing assertion is not', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'file-failures-'));
  try {
    const write = (name: string, body: string) => writeFileSync(path.join(dir, name), `import { test } from 'node:test';\n${body}\n`);
    write('crash.test.mjs', "test('a', () => { process.kill(process.pid, 'SIGSEGV'); });");
    write('late.test.mjs', "test('a', () => { setImmediate(() => Promise.reject(new Error('late boom'))); });");
    write('plain.test.mjs', "test('a', () => { throw new Error('plain'); });");
    const run = spawnSync(
      process.execPath,
      ['--test', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', 'crash.test.mjs', 'late.test.mjs', 'plain.test.mjs'],
      // without the outer run's NODE_TEST_CONTEXT, which would make this run report to it as a child
      { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
    );
    assert.equal(run.status, 1);
    assert.match(run.stdout, /crash\.test\.mjs: its process was killed by SIGSEGV/);
    assert.match(run.stdout, /late\.test\.mjs: its process exited with code 1 outside any test/);
    assert.match(run.stdout, /\n {2}.*asynchronous activity after the test ended.*late boom/);
    assert.doesNotMatch(run.stdout, /plain\.test\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
