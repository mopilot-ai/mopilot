// Whole-repository invariant for MoMo's home (M1, electron/momo/seams.cjs): no module under electron/momo loads Electron, so every store takes its key source and its folder from the place that runs it and the same code runs in the Mac app and on a Host (a Host has no Electron).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['electron/momo/'];

const ROOT = path.join(import.meta.dirname, '..');
const MOMO = path.join(ROOT, 'electron', 'momo');

const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(full) : /\.(?:cjs|mjs|js)$/.test(e.name) ? [full] : [];
  });

test('no module under electron/momo requires or imports Electron', () => {
  const files = filesUnder(MOMO);
  assert.ok(files.some((f) => f.endsWith('seams.cjs')) && files.some((f) => f.endsWith('access.cjs')), 'the scan found MoMo’s modules');
  const found = files.filter((f) => /(?:require\(\s*['"]electron['"]\s*\)|from\s+['"]electron['"])/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(
    found.map((f) => path.relative(ROOT, f)),
    [],
    'a MoMo module takes Electron’s safeStorage, dialog or windows as a parameter (electron/momo/seams.cjs), so a Host can run it',
  );
});
