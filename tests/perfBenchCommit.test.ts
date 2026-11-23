// The chat commit benchmark (scripts/perf-bench/commit.mjs): both engines write the same bytes, each size gives its figures
// from every round, and the command line writes them where it is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES, bench, record } from '../scripts/perf-bench/commit.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/perf-bench/commit.mjs', import.meta.url));

test('the engines write one record byte for byte alike', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-commit-engines-'));
  const text = JSON.stringify(record(64));
  for (const [name, write] of Object.entries(ENGINES)) write(path.join(dir, `${name}.v2`), text);
  assert.ok(fs.readFileSync(path.join(dir, 'core.v2')).equals(fs.readFileSync(path.join(dir, 'js.v2'))));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every size has each engine’s median, least and most, and the folder goes after', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-commit-bench-test-'));
  const result: any = bench({ rounds: 2, scale: 0.01, dir });
  assert.equal(result.rounds, 2);
  for (const size of ['small', 'large']) {
    for (const engine of ['core', 'js']) {
      const f = result[size][engine];
      assert.ok(f.min <= f.usPerCommit && f.usPerCommit <= f.max && f.min > 0, JSON.stringify(f));
    }
  }
  assert.ok(result.large.bytes > 1 << 20 && result.small.bytes < 1024);
  assert.ok(!fs.existsSync(dir));
});

test('the command line prints the figures and writes them to --out', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-commit-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'commit.json');
  const run = spawnSync(process.execPath, [SCRIPT, '--rounds', '1', '--scale', '0.01', '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), JSON.parse(fs.readFileSync(out, 'utf8')));
  assert.ok(JSON.parse(run.stdout).large.core.usPerCommit > 0);
});
