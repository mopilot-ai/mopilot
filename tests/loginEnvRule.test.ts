// The login-env lint guard (lint/rules/login-env.grit): a user-installed CLI spawned from main by bare name without an
// env warns, since a Dock launch's PATH is launchd's (#1580); one with an env, an absolute path or a system tool does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a user-installed CLI spawned by name without an env warns; with an env, by path or a system tool stays valid', () => {
  for (const [input, expected] of [
    ["cp.execFile('gh', ['pr', 'view'], done);", 1],
    ["execFile('git', ['status'], { cwd }, done);", 1],
    ["cp.spawn('rg', ['--files'], { cwd, stdio: 'pipe' });", 1],
    ['cp.exec("node", [], done);', 1],
    ["cp.execFile('gh', ['pr'], { env: process.env }, done);", 1],
    ["cp.execFile('gh', ['pr'], { cwd, env: undefined }, done);", 1],
    ["cp.execFile('gh', ['pr'], { env: shellEnv.childEnv() }, done);", 0],
    ["cp.execFile('git', args, { cwd, env, timeout }, done);", 0],
    ["cp.execFile('/usr/bin/git', ['status'], done);", 0],
    ["cp.spawn('ps', ['-A']);", 0],
    ["cp.execFile('ghost', [], done);", 0],
    ["const text = `execFile('gh')`;", 0],
  ] as const) {
    const report = lintFixtures({ 'electron/run.cjs': `const cp = require('node:child_process');\n${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[login-env]'));
    assert.equal(hits.length, expected, input);
  }
});
