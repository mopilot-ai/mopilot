// MoMo's set-aside copies (electron/gateway/sealedFile.cjs pruneAside): a damaged file's copies older than 30 days are
// deleted; newer copies, other files' copies and the folder's other files stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pruneAside, ASIDE_KEEP_MS } = require('../electron/gateway/sealedFile.cjs');

test('pruneAside deletes only this file’s copies older than 30 days', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-prune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = 10 * ASIDE_KEEP_MS;
  const names = [
    `state.json.unreadable-${now - ASIDE_KEEP_MS}-aaaa`,
    `state.json.unreadable-${now - 1}-bbbb`,
    `other.json.unreadable-${now - ASIDE_KEEP_MS}-cccc`,
    'state.json',
  ];
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
  await pruneAside(path.join(dir, 'state.json'), now);
  assert.deepEqual(fs.readdirSync(dir).sort(), names.slice(1).sort());
});
