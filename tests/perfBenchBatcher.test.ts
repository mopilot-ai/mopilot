// The stream batcher benchmark (scripts/perf-bench/batcher.mjs): its simulated clock, each family's figures from this tree's
// batcher and from an older tree's, and the command line writing them where it is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clock, deltas, loadBatcher, runBig, runFamily } from '../scripts/perf-bench/batcher.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/perf-bench/batcher.mjs', import.meta.url));

test('the clock fires what falls due, in order, and nothing cleared', () => {
  const c = clock();
  const fired: string[] = [];
  c.timers.setTimeout(() => fired.push('b'), 20);
  c.timers.setTimeout(() => fired.push('a'), 10);
  const gone = c.timers.setTimeout(() => fired.push('never'), 5);
  c.timers.clearTimeout(gone);
  c.timers.setTimeout(() => {
    fired.push('c');
    c.timers.setTimeout(() => fired.push('d'), 1);
  }, 20);
  c.advance(15, (fn) => fn());
  assert.deepEqual(fired, ['a']);
  c.advance(30, (fn) => fn());
  assert.deepEqual(fired, ['a', 'b', 'c', 'd']);
});

test("every family's figures come from this tree's batcher", () => {
  const loaded = loadBatcher(ROOT);
  assert.equal(loaded.engine, 'core');
  const big = runBig(loaded, 0.1);
  assert.ok(big.aloneMs > 0 && big.joinedMs > 0, 'a delta past the bound, alone and joined');
  for (const family of Object.keys(deltas) as (keyof typeof deltas)[]) {
    const run = runFamily(loaded, family, 0.05);
    assert.ok(run.pushUs.mean > 0 && (run.pushUs.p95 ?? Infinity) <= run.pushUs.max, family);
    assert.ok(run.mainMsPerSecond > 0 && run.burstUsPerDelta > 0 && run.namedFlushUs.mean > 0, family);
  }
});

test("an older tree's batcher is timed the same way", () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-batcher-'));
  fs.mkdirSync(path.join(old, 'electron', 'harness'), { recursive: true });
  // the shape of the batcher a tree before the core's had: a class with contracts registered per family
  fs.writeFileSync(
    path.join(old, 'electron', 'harness', 'streamBatcher.cjs'),
    `class StreamBatcher {
  constructor(o) { this.o = o; this.families = []; }
  register(family, contract) { this.families.push([family, typeof contract.keyOf]); }
  push(family, event) { return this.o.send(family, event); }
  flushNamed() {}
  flushAll() {}
  cancel() {}
}
module.exports = { StreamBatcher };`,
  );
  fs.writeFileSync(
    path.join(old, 'electron', 'harness', 'streamContracts.cjs'),
    'module.exports = { streamContracts: () => ({ codex: { keyOf() {} }, claude: { keyOf() {} }, acp: { keyOf() {} } }) };',
  );
  const loaded = loadBatcher(old);
  assert.equal(loaded.engine, 'js');
  assert.ok(runFamily(loaded, 'acp', 0.05).pushUs.mean >= 0);
  assert.ok(runBig(loaded, 0.1).joinedMs >= 0);
});

test('the command line prints its figures, and writes them to --out', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-batcher-')), 'bench.json');
  for (const extra of [[], ['--out', out]]) {
    const run = spawnSync(process.execPath, ['--no-warnings', SCRIPT, '--reps', '1', '--seconds', '0.05', ...extra], {
      encoding: 'utf8',
      timeout: 25_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).engine, 'core');
  }
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(out, 'utf8')).rows), ['codex', 'claude', 'acp', 'output1mb', 'output8mb']);
});
