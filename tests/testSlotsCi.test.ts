// scripts/test-slots.mjs in CI: each test file gets a default deadline, and UNIT_TEST_SHARD splits the full suite
// across the matrix jobs of main's unit run and the release's unit job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CI_TEST_TIMEOUT_MS, EXIT_WITH_PARENT, WASM_CODE_GC_GUARD, main, shardArgs } from '../scripts/test-slots.mjs';

test('CI unit tests have a default test deadline, preserve explicit deadlines and leave non-test commands alone', () => {
  const calls: string[][] = [];
  const spawn = (_: string, args: string[]) => {
    calls.push(args);
    return { status: 0 };
  };
  const start = () => ({ workers: null, env: {}, release: () => {} });
  for (const args of [
    ['--test', 'file.test.ts'],
    ['--test', '--test-timeout=42'],
    ['-e', 'process.exit(0)'],
  ])
    main(args, spawn as never, { CI: 'true' }, start);
  assert.equal(CI_TEST_TIMEOUT_MS, 120_000);
  assert.deepEqual(calls, [
    [...WASM_CODE_GC_GUARD, ...EXIT_WITH_PARENT, '--test-timeout=120000', '--test', 'file.test.ts'],
    [...WASM_CODE_GC_GUARD, ...EXIT_WITH_PARENT, '--test', '--test-timeout=42'],
    ['-e', 'process.exit(0)'],
  ]);
});

test('UNIT_TEST_SHARD shards a CI test run before its file patterns, and nothing else', () => {
  const calls: string[][] = [];
  const spawn = (_: string, args: string[]) => {
    calls.push(args);
    return { status: 0 };
  };
  const start = () => ({ workers: '4', env: {}, release: () => {} });
  const env = { CI: 'true', UNIT_TEST_SHARD: '2/3' };
  main(['--test', 'tests/**/*.test.ts'], spawn as never, env, start);
  main(['--test', '--test-shard=1/2', 'a.test.ts'], spawn as never, env, start);
  main(['-e', 'process.exit(0)'], spawn as never, env, start);
  main(['--test', 'a.test.ts'], spawn as never, { CI: 'true' }, start);
  assert.deepEqual(calls, [
    [
      ...WASM_CODE_GC_GUARD,
      ...EXIT_WITH_PARENT,
      '--test-timeout=120000',
      '--test-shard=2/3',
      '--test-concurrency=4',
      '--test',
      'tests/**/*.test.ts',
    ],
    [
      ...WASM_CODE_GC_GUARD,
      ...EXIT_WITH_PARENT,
      '--test-timeout=120000',
      '--test-concurrency=4',
      '--test',
      '--test-shard=1/2',
      'a.test.ts',
    ],
    ['--test-concurrency=4', '-e', 'process.exit(0)'],
    [...WASM_CODE_GC_GUARD, ...EXIT_WITH_PARENT, '--test-timeout=120000', '--test-concurrency=4', '--test', 'a.test.ts'],
  ]);
  // a value node would reject, or one that would run no file or every file, stops before anything starts
  for (const bad of ['3', '0/3', '4/3', 'a/b', '1/3/2']) {
    assert.throws(() => main(['--test', 'a.test.ts'], spawn as never, { CI: 'true', UNIT_TEST_SHARD: bad }, start), /must look like 2\/3/);
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(shardArgs(['--test'], {}), []);
});
