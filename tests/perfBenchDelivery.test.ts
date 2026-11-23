// The stream delivery benchmark (scripts/perf-bench/delivery.mjs): each flush is timed both ways and arrives whole, each
// object both ways, and the command line writes its figures where it is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FLUSHES, OBJECTS, bench, timeFlush } from '../scripts/perf-bench/delivery.mjs';

const require = createRequire(import.meta.url);
const { streamBatch } = require('../electron/app/streamBatch.cjs');
const { streamItems } = require('../electron/bridge/spec.cjs');
const SCRIPT = fileURLToPath(new URL('../scripts/perf-bench/delivery.mjs', import.meta.url));

test('each flush the benchmark times reaches the window as the same events either way', () => {
  for (const [name, make] of Object.entries(FLUSHES)) {
    const items = make();
    const [bytes, cloned] = v8.deserialize(v8.serialize(streamBatch(items)));
    const expected = items.map(([channel, event, extra]: any) => [channel, extra ? { ...event, ...extra } : event]);
    assert.deepEqual(streamItems(bytes, cloned), expected, name);
    const timed = timeFlush(items, 2);
    assert.ok(timed.mainAfterUs >= 0 && timed.bytesAfter > 0, name);
  }
});

test('every figure is there, and the command line writes them to --out', () => {
  const result = bench({ reps: 1, rounds: 2 });
  assert.deepEqual(Object.keys(result.rows), [...Object.keys(FLUSHES), ...Object.keys(OBJECTS)]);
  assert.ok(result.rows.claudeAssistant.stringifyUs >= 0 && result.rows.claudeAssistant.cloneUs >= 0);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-delivery-')), 'bench.json');
  for (const extra of [[], ['--out', out]]) {
    const run = spawnSync(process.execPath, ['--no-warnings', SCRIPT, '--reps', '1', '--rounds', '2', ...extra], {
      encoding: 'utf8',
      timeout: 25_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).reps, 1);
  }
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).rounds, 2);
});
