// A test names each main-process module it loads literally: scripts/related-tests.mjs selects a test by the paths it can
// read, so one built at run time from a variable hides the test from every change to that module (#2664: the
// diagnostics IPC test loaded ipc/app.cjs that way, and a change it broke merged without running it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['tests/'];

const ROOT = path.resolve(import.meta.dirname, '..');
const COMPUTED = /`(?:\.\.\/)+electron\/\$\{/;

test('no test builds a path into electron/ at run time', () => {
  const computed = treeFiles(path.join(ROOT, 'tests'), /\.(ts|tsx|mjs|cjs)$/)
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .flatMap((f) =>
      readFileSync(path.join(ROOT, f), 'utf8')
        .split('\n')
        .flatMap((line, i) => (COMPUTED.test(line) ? [`${f}:${i + 1}`] : [])),
    );
  assert.deepEqual(computed, [], "name the module literally: new URL('../electron/app/ipc/app.cjs', import.meta.url)");
});
