// The argv-secret lint guard (lint/rules/argv-secret.grit): a secret, token, password or API key built into a child
// process's arguments warns; plain arguments, and a secret passed in the environment, do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a secret built into a child’s arguments warns; plain arguments and the environment stay valid', () => {
  for (const [input, expected] of [
    ["cp.spawn(bin, ['app-server', '-c', `openai_base_url=\"http://127.0.0.1/${this.secret}\"`]);", 1],
    ["execFile('tool', ['--token=' + token], done);", 1],
    ['cp.execFileSync(bin, [`--api-key=${apiKey}`]);', 1],
    ["spawnGroup(spawn, bin, ['run', `--password=${pw.password}`], opts);", 1],
    ["cp.spawn(bin, ['app-server'], { env: { ...env, TOKEN: token } });", 0],
    ['cp.spawn(bin, [`--port=${port}`]);', 0],
    ["execFile('git', ['log', '--format=%H ' + range], done);", 0],
  ] as const) {
    const report = lintFixtures({ 'electron/run.cjs': `const cp = require('node:child_process');\n${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[argv-secret]'));
    assert.equal(hits.length, expected, input);
  }
});
