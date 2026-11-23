// The harness stdio benchmark (scripts/perf-bench/stdio.mjs): each scenario gives its figures through either engine, at a
// scale that takes no time, and the command line writes them where it is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bench } from '../scripts/perf-bench/stdio.mjs';

const require = createRequire(import.meta.url);
const { corePath, loadCore } = require('../electron/platform/core.cjs');

const skip = !loadCore(corePath())?.routes().includes('proc.spawn')
  ? 'no Rust core with proc.spawn'
  : process.platform === 'win32' && 'POSIX: it times /usr/bin/true';
const SCRIPT = fileURLToPath(new URL('../scripts/perf-bench/stdio.mjs', import.meta.url));

for (const engine of ['core', 'node'] as const) {
  test(`every figure comes from ${engine}, with every line delivered`, { skip }, async () => {
    const result = await bench({ engine, reps: 1, scale: 0.02 });
    assert.equal(result.engine, engine);
    assert.equal(result.steady.events, 58);
    assert.equal(result.burst.events, 400);
    assert.equal(result.record.events, 1);
    assert.equal(result.spawn.spawns, 1);
    for (const run of [result.steady, result.burst, result.record])
      assert.ok(run.p50 <= run.p95 && run.p95 <= run.max && run.mainUsPerEvent > 0, JSON.stringify(run));
    assert.ok(result.spawn.heldP50 > 0 && result.spawn.closedP50 >= result.spawn.heldP50);
  });
}

test('the command line prints its figures, and writes them to --out', { skip }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-stdio-')), 'bench.json');
  for (const extra of [[], ['--out', out]]) {
    const run = spawnSync(process.execPath, ['--no-warnings', SCRIPT, '--engine', 'node', '--reps', '1', '--scale', '0.01', ...extra], {
      encoding: 'utf8',
      timeout: 25_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).engine, 'node');
  }
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).record.events, 1);
});
