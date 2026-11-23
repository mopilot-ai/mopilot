// scripts/source-references.mjs: a module a test or helper only stubs is not reached, whatever builds the specifier,
// while the test's imports, named paths and the stub's own exports keep their edges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { referencesOf, relatedTests, reverseGraph, withoutStubs } from '../scripts/related-tests.mjs';

function repo(t: { after: (fn: () => void) => void }, files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'related-stubs-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const SOURCES = {
  'src/fx/store.ts': 'export const s = 1;',
  'src/fx/native.ts': 'export const native = 1;',
  'src/fx/real.ts': 'export const real = 1;',
  'electron/fx/flags.cjs': 'module.exports = {};',
};

test('withoutStubs empties every string in a stub call’s first argument, whatever builds it', () => {
  assert.equal(withoutStubs("mock.module('../src/fx/store.ts', { exports })"), "mock.module('', { exports })");
  assert.equal(
    withoutStubs("mock.module(new URL('../src/fx/native.ts', import.meta.url).href, { exports: { a: f('src/fx/real.ts') } })"),
    "mock.module(new URL('', import.meta.url).href, { exports: { a: f('src/fx/real.ts') } })",
  );
  assert.equal(withoutStubs('mock.module(require.resolve("../electron/fx/flags.cjs"))'), 'mock.module(require.resolve(""))');
  assert.equal(withoutStubs('autoMock(`src/fx/store.ts`, "store", {})'), 'autoMock(``, "store", {})');
  // a bracket or comma inside a string does not end the argument early, and nested calls are skipped whole
  assert.equal(withoutStubs("mock.module(f('a,b)', ['x']), 'src/fx/real.ts')"), "mock.module(f('', ['']), 'src/fx/real.ts')");
  // text around the calls is untouched, and an unclosed quote ends the scan without throwing
  assert.equal(withoutStubs("import '../src/fx/real.ts';\nmock.module('x"), "import '../src/fx/real.ts';\nmock.module('x");
  assert.equal(withoutStubs('const unrelated = "src/fx/real.ts";'), 'const unrelated = "src/fx/real.ts";');
  // a call named in a comment or a string is text: the import after it keeps its specifier
  for (const text of [
    "// stubbed with mock.module(\nimport '../src/fx/real.ts';",
    "const doc = 'autoMock(';\nimport '../src/fx/real.ts';",
    ' * mock.module(\n',
  ])
    assert.equal(withoutStubs(text), text);
  // a stub call inside another's first argument is part of that argument
  assert.equal(withoutStubs("mock.module(f(autoMock('a')), 'b')"), "mock.module(f(autoMock('')), 'b')");
});

test('a stubbed path is not a reference; the same path imported, or named outside the stub, still is', (t) => {
  const dir = repo(t, SOURCES);
  const refs = (text: string) => [...referencesOf('tests/x.test.ts', text, dir)].sort();
  assert.deepEqual(refs("mock.module('../src/fx/store.ts', { exports: {} });"), []);
  assert.deepEqual(refs("mock.module(new URL('../src/fx/native.ts', import.meta.url).href, { exports: {} });"), []);
  assert.deepEqual(refs("autoMock('src/fx/store.ts', 'store');"), []);
  assert.deepEqual(refs("mock.module('../src/fx/store.ts', { exports: {} });\nconst { s } = await import('../src/fx/store.ts');"), [
    'src/fx/store.ts',
  ]);
  assert.deepEqual(refs("mock.module('../src/fx/store.ts', { exports: { real: read('src/fx/real.ts') } });"), ['src/fx/real.ts']);
  // the folders an invariant test declares it guards are not folders it reads
  assert.deepEqual(refs("export const GUARDS = ['src/fx/', 'src/fx/store.ts'];\nimport '../src/fx/real.ts';"), ['src/fx/real.ts']);
});

test('a test that only stubs a module is not selected for it; one that loads it through a helper is', (t) => {
  const dir = repo(t, {
    ...SOURCES,
    'tests/stubsStore.test.ts': "mock.module('../src/fx/store.ts', { exports: {} });\nimport '../src/fx/real.ts';",
    'tests/support/kit.ts': "autoMock('src/fx/native.ts', 'native');\nexport const flags = require('../../electron/fx/flags.cjs');",
    'tests/viaKit.test.ts': "import { flags } from './support/kit.ts';",
  });
  const users = reverseGraph(dir);
  assert.deepEqual(relatedTests(['src/fx/store.ts'], users), []);
  assert.deepEqual(relatedTests(['src/fx/real.ts'], users), ['tests/stubsStore.test.ts']);
  assert.deepEqual(relatedTests(['src/fx/native.ts'], users), []);
  assert.deepEqual(relatedTests(['electron/fx/flags.cjs'], users), ['tests/viaKit.test.ts']);
});

test('the selector’s own sources name no app file, so the tests of the selector are not run for every app change', () => {
  // an example in a comment (`path.join(ROOT, …, 'main.cjs')`) is an edge like any other quoted path
  for (const file of ['scripts/related-tests.mjs', 'scripts/source-references.mjs', 'scripts/related-replay.mjs']) {
    const outside = [...referencesOf(file, readFileSync(file, 'utf8'))].filter(
      (ref) => !ref.startsWith('scripts/') && ref !== 'biome.json',
    );
    assert.deepEqual(outside, [], file);
  }
});
