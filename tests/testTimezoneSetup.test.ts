// Whole-repository invariant for test clocks: a test file never sets process.env.TZ in its module body, where it runs after
// every import (an ES module's imports are evaluated first), so a helper's dates are made on the runner's zone and move
// when the TZ lands. Tests that need Los Angeles time import tests/support/tz-la.ts as their first import instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['tests/'];

const TESTS = path.join(import.meta.dirname);
const SETUP = "import './support/tz-la.ts';";
const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(m|c)?tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
const rel = (f: string) => path.relative(path.join(TESTS, '..'), f).split(path.sep).join('/');

/** Whether `text` sets TZ outside any function: at column 0, where a module body runs. */
const setsTzAtTop = (text: string) => /^process\.env\.TZ\s*=/m.test(text);
/** Whether the clock setup is the file's first import. */
const setupFirst = (text: string) => text.split('\n').find((l) => l.startsWith('import ')) === SETUP;

test('no test file sets TZ in its module body; one that needs a clock imports tests/support/tz-la.ts first', () => {
  const files = walk(TESTS).filter((f) => rel(f) !== 'tests/support/tz-la.ts');
  assert.deepEqual(
    files.filter((f) => setsTzAtTop(fs.readFileSync(f, 'utf8'))).map(rel),
    [],
    `set it with ${SETUP} as the first import, never in the body`,
  );
  // a file that imports it: the line itself, not a mention of it
  const users = files.filter((f) => fs.readFileSync(f, 'utf8').split('\n').includes(SETUP));
  assert.ok(users.length > 10, `only ${users.length} files use the clock setup`);
  assert.deepEqual(users.filter((f) => !setupFirst(fs.readFileSync(f, 'utf8'))).map(rel), [], 'the clock setup must be the first import');
});

test('the scan tells a module-body TZ from one set inside a test, and a first import from a later one', () => {
  assert.ok(setsTzAtTop("// x\nprocess.env.TZ = 'UTC';\nimport a from 'a';"));
  assert.ok(!setsTzAtTop("test('x', () => {\n  process.env.TZ = tz;\n});"));
  assert.ok(setupFirst(`// x\n${SETUP}\nimport a from 'a';`));
  assert.ok(!setupFirst(`import a from 'a';\n${SETUP}`));
});
