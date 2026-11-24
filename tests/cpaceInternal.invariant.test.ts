// Only the public CPace module and its own tests import the internal one (shared/host/cpaceInternal.mjs): it returns K, takes a replacement for the random source and checks a tag in either direction, none of which any other code may use. A whole-repository scan, so a later caller cannot reach round the public door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set([
  'shared/host/cpace.mjs',
  'shared/host/cpaceInternal.mjs',
  'tests/cpace.test.ts',
  'tests/cpaceInternal.invariant.test.ts',
]);
const SOURCE = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|json|html|sh)$/;

/** Every file git tracks (so no folder is skipped by name: a build output or a test result that is committed is read too). */
const tracked = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);

test('nothing but the public CPace module and its tests names the internal one', () => {
  const found: string[] = [];
  const all = tracked();
  assert.ok(all.length > 1000 && all.includes('shared/host/cpace.mjs'), 'git lists the repository');
  for (const rel of all) {
    if (ALLOWED.has(rel) || !SOURCE.test(rel)) continue;
    const file = path.join(ROOT, rel);
    // a link or a file git lists but the checkout does not hold is read as what it is, or not at all
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    if (/cpaceInternal/.test(fs.readFileSync(file, 'utf8'))) found.push(rel);
  }
  assert.deepEqual(found, [], 'import shared/host/cpace.mjs, not its internals');
  for (const rel of ALLOWED) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} exists`);
  // the public module names the internal one, so the guard is not vacuous
  assert.match(fs.readFileSync(path.join(ROOT, 'shared/host/cpace.mjs'), 'utf8'), /cpaceInternal/);
});
