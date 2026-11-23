// An E2E spec that asserts an animation by name names one the app's stylesheets still define: a renamed or moved
// keyframes (#2539 moved the sidebar title's sweep from shimmer-text-shine on the title to shimmer-band on its band)
// otherwise breaks the spec only on main-e2e, after the merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GUARDS = ['src/', 'tests/e2e/'];

const files = (dir: string, ext: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : [],
  );
const root = (p: string) => new URL(`../${p}`, import.meta.url).pathname;

test('every animation name an E2E spec expects is a keyframes the app defines', () => {
  const defined = new Set(
    files(root('src'), '.css').flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])),
  );
  assert.ok(defined.has('shimmer-band') && defined.has('row-dot-pulse'), 'the scan reads the stylesheets');
  const expected = files(root('tests/e2e'), '.ts').flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/'animation-name',\s*'([\w-]+)'/g)].map((m) => `${f.slice(root('').length)}: ${m[1]}`),
  );
  assert.ok(expected.length > 0, 'the scan finds the specs that expect animations');
  assert.deepEqual(
    expected.filter((e) => e.split(': ')[1] !== 'none' && !defined.has(e.split(': ')[1])),
    [],
  );
});
