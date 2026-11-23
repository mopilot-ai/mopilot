// The sync-child-process lint guard (lint/rules/sync-child-process.grit): a child process run synchronously in the main
// process warns; an asynchronous run, or the same name used for something else, does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a synchronous child process in main warns, an asynchronous one stays valid', () => {
  for (const [input, expected] of [
    ["execFileSync('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', out], { timeout: 20000 });", 1],
    ["cp.execFileSync('ps', ['-o', 'ppid=']);", 1],
    ["require('node:child_process').execSync('ls');", 1],
    ["spawnSync('/bin/sh', [script], { stdio: 'inherit' });", 1],
    ["execFile('/usr/bin/sips', ['-s', 'format', 'png', file], { timeout: 20000 }, done);", 0],
    ["spawn('ps', ['-o', 'ppid=']).on('exit', done);", 0],
    ["const source = `execFileSync('ps')`;", 0],
  ] as const) {
    const report = lintFixtures({ 'electron/run.cjs': `const cp = require('node:child_process');\n${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[sync-child-process]'));
    assert.equal(hits.length, expected, input);
  }
});
