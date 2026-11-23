// electron/platform/fsutil.cjs readJsonAsync: the non-blocking twin of readJson (updateDownload's download metadata).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { readJsonAsync } = createRequire(import.meta.url)('../electron/platform/fsutil.cjs');

test('the parsed file, else the fallback for a missing or malformed one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-json-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.json'), '{"version":"1.2.3"}');
    fs.writeFileSync(path.join(dir, 'bad.json'), '{"version":');
    assert.deepEqual(await readJsonAsync(path.join(dir, 'ok.json')), { version: '1.2.3' });
    assert.equal(await readJsonAsync(path.join(dir, 'bad.json')), null);
    assert.deepEqual(await readJsonAsync(path.join(dir, 'gone.json'), {}), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
