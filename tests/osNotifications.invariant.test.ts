// Every OS notification goes through electron/platform/notify.cjs (and a window's through src/store/core.ts's notify):
// the Notifications setting, quiet hours and per-chat merging live there, and a banner shown anywhere else skips them.
// A whole-repository scan, so any change under electron/ or src/ runs it: a new file that shows its own banner
// (Help > Capture Performance Profile's did) fails here, before it merges (#2574).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['electron/', 'src/'];

test('nothing reaches the OS notification API except through notify()', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = (dir: string) => treeFiles(path.join(root, dir), /\.(cjs|mjs|ts|tsx)$/).map((f) => path.relative(root, f));
  const offenders: string[] = [];
  for (const f of [...files('electron'), ...files('src')]) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    if (/new Notification\(/.test(text) && f !== path.join('electron', 'platform', 'notify.cjs')) offenders.push(f);
    if (/native\.app\.notify\(/.test(text) && f !== path.join('src', 'store', 'core.ts')) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});
