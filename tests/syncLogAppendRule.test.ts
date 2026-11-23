// The sync-log-append lint guard (lint/rules/sync-log-append.grit): a record appended with appendFileSync in the main
// process warns; an append of text that is not serialized per call, or an asynchronous append, does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('appending a serialized record synchronously warns, other appends stay valid', () => {
  for (const [input, expected] of [
    ["fs.appendFileSync(file, JSON.stringify(e) + '\\n');", 1],
    ["fs.appendFileSync(file, JSON.stringify(e) + '\\n', { mode: 0o600 });", 1],
    ["appendFileSync(file, records.map((r) => JSON.stringify(r) + '\\n').join(''));", 1],
    ["fs.appendFileSync(file, batch.join(''));", 0],
    ["fs.promises.appendFile(file, JSON.stringify(e) + '\\n');", 0],
    ['writer.append(file, [JSON.stringify(e)]);', 0],
  ] as const) {
    const report = lintFixtures({ 'electron/log.cjs': `const fs = require('node:fs');\n${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[sync-log-append]'));
    assert.equal(hits.length, expected, input);
  }
});
