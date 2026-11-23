// The renderer reaches the preload bridge only through its port (docs/architecture/modularization.md §2): only
// src/lib/nativeInstall.ts reads window.native, and a test installs its bridge in the port (tests/support/ports/native.ts)
// rather than mocking src/lib/native.ts, so no module or test reads a bridge the port didn't hand it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['src/', 'tests/'];

const ROOT = path.resolve(import.meta.dirname, '..');
const files = (dir: string) =>
  treeFiles(path.join(ROOT, dir), /\.(ts|tsx|mjs)$/).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
/** A file's code lines, comments left out (the bridge is named in many comments). */
const code = (file: string) =>
  readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
const READ = /\bwindow\??\.native\b|\(window as [^)]*\)\??\.native\b/;
const MOCK =
  /(?:mock\.module|mockSource|autoMock)\(\s*(?:new URL\()?['"`][./]*(?:src\/)?lib\/native(?:\.ts)?['"`]|['"]lib\/native\.ts['"]\s*:|\[at\(['"][./]*(?:src\/)?lib\/native\.ts['"]\)\]/;

/** The port itself (which types the global) and the module that installs it. */
const PORT = new Set(['src/lib/native.ts', 'src/lib/nativeInstall.ts']);

test('only src/lib/nativeInstall.ts reads window.native', () => {
  const readers = files('src').filter((f) => !PORT.has(f) && code(f).some((line) => READ.test(line)));
  assert.deepEqual(readers, [], 'read the port: import { native } (or installedNative) from src/lib/native.ts');
});

test('no test mocks src/lib/native.ts', () => {
  const mocks = files('tests').filter((f) => f !== 'tests/nativePort.invariant.test.ts' && code(f).some((line) => MOCK.test(line)));
  assert.deepEqual(mocks, [], 'install the bridge instead: installNativeStub or useFakeNative (tests/support/ports/native.ts)');
});
