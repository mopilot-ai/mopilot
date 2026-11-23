import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

test('ensure-electron resolves the Electron binary once and names it', () => {
  const r = spawnSync(process.execPath, ['scripts/ensure-electron.cjs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = /^electron: (.+)$/m.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.ok(existsSync(m[1].trim()), m[1]);
});
