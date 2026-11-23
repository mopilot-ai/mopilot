// Keep the benchmark Chrome process boundaries in the normal changed-source selector and enforced coverage scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { changedFiles, relatedTests, reverseGraph } from '../scripts/related-tests.mjs';
import { measuredBy } from '../scripts/diff-coverage.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sources = ['bench/bench-chrome.mjs', 'bench/drivers/mgb.mjs', 'bench/mgb-run.mjs'];
const git = (args: string[]) =>
  args[0] === 'merge-base' ? 'base' : args[0] === 'diff' ? [...sources, 'bench/mgb-serve.mjs'].join('\n') : '';

test('Chrome helper, MGB driver and runner are changed sources; unrelated VM entrypoints stay outside the added scope', () => {
  assert.deepEqual(changedFiles('origin/main', git), sources);
  const measured = measuredBy(JSON.parse(fs.readFileSync(path.join(root, '.c8rc.json'), 'utf8')), root);
  for (const source of sources) assert.equal(measured(source), true, `${source} must enforce changed-code coverage`);
  assert.equal(measured('bench/mgb-serve.mjs'), false);
});

test('changes to the Chrome process boundaries select their mocked unit fixtures without selecting release runners', () => {
  const users = reverseGraph(root);
  for (const [source, tests] of [
    ['bench/bench-chrome.mjs', ['tests/benchChromeStart.test.ts']],
    ['bench/drivers/mgb.mjs', ['tests/benchMgbChrome.test.ts', 'tests/benchMgbDriver.test.ts']],
    ['bench/mgb-run.mjs', ['tests/benchMgbSetupFailure.test.ts']],
  ] as [string, string[]][]) {
    const selected = relatedTests([source], users);
    for (const file of tests) assert.ok(selected.includes(file), `${source} must select ${file}`);
    assert.ok(selected.every((file) => /^tests\/[^/]+\.test\.ts$/.test(file)));
  }
  assert.ok(relatedTests(['bench/lib/chromePipe.mjs'], users).includes('tests/benchChromeStart.test.ts'));
});
