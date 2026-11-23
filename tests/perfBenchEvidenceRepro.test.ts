// Acceptance-evidence regressions: a probe with no usable measurement cannot count as a successful repeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateRun } from '../scripts/perf-bench/aggregate.mjs';

for (const unavailable of ['missing', 'empty', 'outside-cell'] as const) {
  test(`a probe with ${unavailable} data does not count as a successful measured repeat`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream1208-repro-'));
    try {
      const sample = { t: 1500, kind: 'frame', ms: 16, visible: true, focused: true };
      fs.writeFileSync(path.join(dir, 'valid.jsonl'), JSON.stringify(sample) + '\n');
      if (unavailable === 'empty') fs.writeFileSync(path.join(dir, 'unavailable.jsonl'), '');
      if (unavailable === 'outside-cell') fs.writeFileSync(path.join(dir, 'unavailable.jsonl'), JSON.stringify({ ...sample, t: 0 }) + '\n');
      const base = { scenario: 'S1', variant: 'codex', rate: 120, chunk: 4, chats: 1, from: 1000, to: 2000 };
      fs.writeFileSync(
        path.join(dir, 'cells.json'),
        JSON.stringify([
          { ...base, rep: 0, probe: 'valid.jsonl' },
          { ...base, rep: 1, probe: 'valid.jsonl' },
          { ...base, rep: 2, probe: 'unavailable.jsonl' },
        ]),
      );
      aggregateRun(dir);
      const result = JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8'));
      const row = result.rows[0];
      assert.deepEqual(
        { attempted: row.attempted, measured: row.measured, runs: row.runs, incomplete: row.incomplete, failed: row.failed },
        { attempted: 3, measured: 2, runs: 2, incomplete: 1, failed: 0 },
      );
      assert.equal(result.runs[2].metrics, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
