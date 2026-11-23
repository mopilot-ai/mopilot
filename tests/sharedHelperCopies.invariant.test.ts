// Small helpers live once: the renderer pluralizes with src/lib/format.ts pluralize, and main compares secrets in
// constant time with electron/platform/timingSafe.cjs sameText. A new hand-rolled copy fails here with its file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['electron/', 'src/'];

const ROOT = path.join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');

/** The files under `dir` matching `ext` whose text matches `pattern`, leaving out `except`. */
const holding = (dir: string, ext: RegExp, pattern: RegExp, except: string[] = []) =>
  treeFiles(dir, ext).filter((f: string) => !except.includes(f) && pattern.test(read(f)));

test("the renderer pluralizes with format.pluralize, not its own `=== 1 ? '' : 's'` or plural helper", () => {
  assert.deepEqual(holding('src', /\.tsx?$/, /=== 1 \? '' : 's'|\bconst plural = \(/, ['src/lib/format.ts']), []);
});

test('main compares in constant time only through timingSafe.cjs', () => {
  assert.deepEqual(holding('electron', /\.[cm]?js$/, /timingSafeEqual\(/, ['electron/platform/timingSafe.cjs']), []);
});
