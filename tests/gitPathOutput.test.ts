// Git command path records retain filename whitespace and remove only their final LF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { parseGitPathLine } = createRequire(import.meta.url)('../electron/platform/gitParse.cjs');

test('path output removes only the final LF, preserving path whitespace', () => {
  for (const path of ['/repo ', '/repo\t', '/repo\n', '/repo\r', 'C:\\Projects\\repo ', '/你好']) {
    assert.equal(parseGitPathLine(path + '\n'), path);
    if (!path.endsWith('\n')) assert.equal(parseGitPathLine(path), path);
  }
  for (const empty of ['', undefined, null]) assert.equal(parseGitPathLine(empty), '');
  assert.equal(parseGitPathLine('\n'), '');
});
