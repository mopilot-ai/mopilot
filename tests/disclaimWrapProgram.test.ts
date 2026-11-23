// wrapProgram in electron/platform/disclaim.cjs: without a script dir, or when the wrapper cannot be
// written, the program runs as given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const disclaim = require('../electron/platform/disclaim.cjs');
const on = (extra: any = {}) =>
  disclaim.configure({ launcher: '/x/disclaim', platform: 'darwin', env: { MOPILOT_DISCLAIM: '1' }, exists: () => true, ...extra });
test.afterEach(() => disclaim.configure({}));

test('a launcher configured without a script dir leaves programs unwrapped', () => {
  on();
  assert.equal(disclaim.active(), '/x/disclaim');
  assert.equal(disclaim.wrapProgram('/opt/claude'), '/opt/claude');
});

test('an unwritable script dir falls back to the program itself', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaim-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const blocker = path.join(tmp, 'file');
  fs.writeFileSync(blocker, '');
  on({ dir: () => path.join(blocker, 'scripts') });
  assert.equal(disclaim.wrapProgram('/opt/claude'), '/opt/claude');
});
