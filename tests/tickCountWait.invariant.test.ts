// A test never waits by counting loop turns (`for (let i = 0; i < 200 && !done; i++) await tick()`): that is a time
// budget a loaded runner exhausts before real I/O lands (#3278, #3281). Wait with tests/support/waitFor.ts instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;

const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? e.name === 'node_modules'
          ? []
          : files(path.join(dir, e.name))
        : SOURCE.test(e.name)
          ? [path.join(dir, e.name)]
          : [],
    );

/** A counted loop whose condition also waits on something: `i < N && cond` or `cond && i < N`. */
const COUNTED_WAIT = /for\s*\(\s*let\s+(\w+)\s*=\s*0\s*;([^;]*\b\1\s*<[^;]*&&[^;]*|[^;]*&&[^;]*\b\1\s*<[^;]*);/g;

function countedWaits(source: string) {
  return [...source.matchAll(COUNTED_WAIT)].map((m) => source.slice(0, m.index).split('\n').length);
}

test('the pattern finds both orders and leaves plain counted loops alone', () => {
  const sample = [
    'for (let i = 0; i < 200 && !done; i++) await tick();',
    'for (let n = 0; !ready() && n < LIMIT; n++) await flush();',
    'for (let i = 0; i < 10; i++) await tick();',
    'for (let i = 0; i < rows.length; i++) if (a && b) x();',
  ].join('\n');
  assert.deepEqual(countedWaits(sample), [1, 2]);
});

test('I: no test waits by counting loop turns; it waits with tests/support/waitFor.ts', () => {
  const self = path.join(ROOT, 'tests', 'tickCountWait.invariant.test.ts');
  const found = files(path.join(ROOT, 'tests'))
    .filter((f) => f !== self)
    .flatMap((f) => countedWaits(fs.readFileSync(f, 'utf8')).map((line) => `${path.relative(ROOT, f)}:${line}`));
  assert.deepEqual(found, [], 'replace each with `await waitFor(() => <condition>, <what>)`');
});
