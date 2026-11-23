// scripts/host-phone-check.mjs: runs the scenario's test through the shared worker budget and passes on its exit code; here with a fake spawn and, for the command line, a trivial test file in place of the scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostPhoneCheck } from '../scripts/host-phone-check.mjs';

export const GUARDS = ['scripts/host-phone-check.mjs', 'scripts/test-slots.mjs'];

test('it runs the scenario test through test-slots by default, or the file it is given, and returns the exit code (1 when there is none)', () => {
  const calls: string[][] = [];
  const envs: Record<string, string | undefined>[] = [];
  const fake = (status: number | null) =>
    ((_node: string, args: string[], o: any) => (calls.push(args), envs.push(o.env), { status })) as any;
  assert.equal(hostPhoneCheck({ spawnSync: fake(0) }), 0);
  assert.equal(hostPhoneCheck({ argv: ['other.test.ts'], spawnSync: fake(3) }), 3);
  assert.equal(hostPhoneCheck({ spawnSync: fake(null) }), 1);
  assert.match(calls[0][0], /test-slots\.mjs$/);
  assert.equal(calls[0][1], '--test');
  assert.match(calls[0][2], /tests[\\/]hostPhoneEndToEnd\.test\.ts$/);
  assert.equal(calls[1][2], 'other.test.ts');
  // the outer run's shard must not reach the one file (it would be on no shard and the command would exit 0); the rest of the environment does
  const before = process.env.UNIT_TEST_SHARD;
  process.env.UNIT_TEST_SHARD = '2/3';
  try {
    hostPhoneCheck({ spawnSync: fake(0) });
  } finally {
    if (before === undefined) delete process.env.UNIT_TEST_SHARD;
    else process.env.UNIT_TEST_SHARD = before;
  }
  assert.equal('UNIT_TEST_SHARD' in envs.at(-1)!, false);
  assert.equal(envs.at(-1)!.PATH, process.env.PATH);
});

test('as a command it exits with the result of the test it runs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pass = path.join(dir, 'pass.test.mjs');
  const fail = path.join(dir, 'fail.test.mjs');
  fs.writeFileSync(pass, "import { test } from 'node:test';\ntest('ok', () => {});\n");
  fs.writeFileSync(fail, "import { test } from 'node:test';\ntest('no', () => { throw new Error('no'); });\n");
  // a runner started inside a test of this runner would report to it, not exit with its own result
  // and CI's shard 2 of 3, which main-unit-tests sets for the outer run: the nested one-file run must still run and fail (#4534)
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), UNIT_TEST_SHARD: '2/3' };
  const run = (file: string) =>
    spawnSync(process.execPath, ['scripts/host-phone-check.mjs', file], {
      cwd: path.join(import.meta.dirname, '..'),
      encoding: 'utf8',
      env,
    });
  assert.equal(run(pass).status, 0);
  assert.equal(run(fail).status, 1);
});
