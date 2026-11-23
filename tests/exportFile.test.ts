// electron/platform/exportFile.cjs: an exported transcript lands in a new file and never replaces an earlier one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeNewExport } = require('../electron/platform/exportFile.cjs');

test('the first export takes the plain name, and a taken name moves on to -1, -2 without replacing anything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-file-'));
  try {
    const first = await writeNewExport(dir, 'chat', 'one');
    const second = await writeNewExport(dir, 'chat', 'two!');
    const third = await writeNewExport(dir, 'chat', 'three');
    assert.deepEqual(
      [first.file, second.file, third.file],
      [1, 2, 3].map((n) => path.join(dir, n === 1 ? 'chat.md' : `chat-${n - 1}.md`)),
    );
    assert.deepEqual([first.bytes, second.bytes, third.bytes], [3, 4, 5]);
    assert.equal(fs.readFileSync(first.file, 'utf8'), 'one');
    assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an error other than a taken name is raised, not retried forever', async () => {
  const missing = path.join(os.tmpdir(), `export-file-missing-${process.pid}`, 'nope');
  await assert.rejects(writeNewExport(missing, 'chat', 'x'), { code: 'ENOENT' });
});
