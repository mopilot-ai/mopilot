// Every git child a repository script captures the output of sets maxBuffer: a blob, a diff or an archive can pass the
// 1 MB Node holds by default, and the call then fails (spawnSync git ENOBUFS) instead of reading it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Each `('git', …)` call in `source` that passes an options object without maxBuffer, by line. */
export function unboundedGitCalls(source: string): number[] {
  const found: number[] = [];
  for (const match of source.matchAll(/\(\s*['"]git['"]\s*,/g)) {
    let depth = 0;
    let end = match.index;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    // a template literal's braces (`${sha}^{commit}`) are not an options object
    const call = source.slice(match.index, end + 1).replace(/`[^`]*`/g, '``');
    // a call without an options object goes through a wrapper, which this test checks where it spawns
    if (call.includes('{') && !call.includes('maxBuffer')) found.push(source.slice(0, match.index).split('\n').length);
  }
  return found;
}

test('the matcher flags a captured git call without maxBuffer, and nothing else', () => {
  assert.deepEqual(unboundedGitCalls("execFileSync('git', args, { encoding: 'utf8' })"), [1]);
  assert.deepEqual(unboundedGitCalls("x\nrun('git', ['show', `${a}:${b}`], { cwd, encoding: 'utf8' })"), [2]);
  assert.deepEqual(unboundedGitCalls("execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 })"), []);
  assert.deepEqual(unboundedGitCalls("sh('git', ['fetch', '-q', 'origin', sha])"), [], 'a wrapper call without options');
  assert.deepEqual(unboundedGitCalls("sh('git', ['rev-parse', `${sha}^{commit}`])"), [], 'braces in a template literal');
});

test('every repository script that captures a git child sets maxBuffer', () => {
  const files = execFileSync('git', ['ls-files', 'scripts', '.githooks'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter((f) => /\.(mjs|cjs|js)$/.test(f) && !f.includes('.test.'));
  assert.ok(files.length > 50, `${files.length} scripts`);
  const unbounded = files.flatMap((f) => unboundedGitCalls(readFileSync(f, 'utf8')).map((line) => `${f}:${line}`));
  assert.deepEqual(unbounded, []);
});
