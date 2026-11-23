// Mobile Remote runs with no window open (electron/app/alwaysOn.cjs): nothing under electron/remote may reach for a window, so a turn, an approval card or a pairing never depends on one being there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..', 'electron', 'remote');
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.cjs') ? [path.join(dir, e.name)] : []));

test('no remote module reaches for a window', () => {
  const found = files(root).filter((f) =>
    /\b(BrowserWindow|webContents|mainWindow|showMainWindow|execWindows|broadcastAll)\b|require\('electron'\)/.test(
      fs.readFileSync(f, 'utf8'),
    ),
  );
  assert.deepEqual(
    found.map((f) => path.relative(root, f)),
    [],
  );
});
