// Keep rule-test Biome launches behind the owner that isolates the complete project scan from concurrent fixture cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { hasBiomeExecutable } from '../scripts/biome-executable.mjs';

export const GUARDS = ['tests/'];

test('rule tests use the shared isolated Biome project instead of directly launching a fixture scanner', () => {
  const direct = treeFiles('tests', /\.[cm]?[jt]sx?$/).filter((file) => hasBiomeExecutable(readFileSync(file, 'utf8'), file));
  assert.deepEqual(direct, [], 'Use lintFixtures from scripts/biome-fixtures.mjs; one target file still scans the whole project');
});
