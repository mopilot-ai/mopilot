// A staged Host update restarts the Host only when nothing runs: the idle check the updater and the app's `idle` request use must cover turns, sign-ins and agent installs alike (host/src/cli.mjs), or an automatic update could cut an install short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const cli = fs.readFileSync(path.join(import.meta.dirname, '..', 'host/src/cli.mjs'), 'utf8');

test('the Host’s idle check asks the runtime (turns), the sessions, the sign-in and the agent installer', () => {
  const line = cli.split('\n').find((l) => /^\s*idle:\s*\(\)\s*=>/.test(l));
  assert.ok(line, 'the Host passes one idle check to its updater');
  for (const part of ['runtime.idle()', 'sessions.idle()', 'login.idle()', 'installer.idle()'])
    assert.ok(line.includes(part), `idle must include ${part}`);
});
