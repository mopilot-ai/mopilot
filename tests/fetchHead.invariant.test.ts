// Whole-repository invariant: no script or workflow step reads FETCH_HEAD, which every fetch in a checkout and its worktrees overwrites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const GUARDS = ['.githooks/', '.github/', 'scripts/'];

// Two `ci-cuj.mjs --branch` runs started together from one checkout fetched their branches and each read FETCH_HEAD;
// both dispatched the first branch's commit, so the second run tested the wrong code. These files run in a checkout
// other fetches share (agents' worktrees, a workflow's job), so they take a commit id from the remote's own answer
// (scripts/remote-branch.mjs) or fetch into a ref of their own. A repository made for one call (`git init` in a
// fresh folder, as electron/plugins/marketplaces.cjs does) owns its FETCH_HEAD and is outside this scan.
const ROOTS = ['scripts', '.github', '.githooks'];
const SOURCE = /\.(?:mjs|cjs|js|ts|sh|ya?ml)$|^[^.]+$/;

/** The lines of `text` that use FETCH_HEAD in code, as `line: text`; comments that explain why not are left. */
function fetchHeadReads(text: string): string[] {
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('FETCH_HEAD') && !/^\s*(?:\/\/|#|\*|\/\*)/.test(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(file);
    return SOURCE.test(entry.name) ? [file] : [];
  });

test('the scan finds FETCH_HEAD in code and leaves comments', () => {
  assert.deepEqual(fetchHeadReads("x\n  return exec('git', ['rev-parse', 'FETCH_HEAD']).trim();"), [
    "2: return exec('git', ['rev-parse', 'FETCH_HEAD']).trim();",
  ]);
  assert.equal(fetchHeadReads('        run: git checkout FETCH_HEAD').length, 1);
  assert.equal(fetchHeadReads('git reset --hard FETCH_HEAD # sync').length, 1);
  for (const comment of ['// never FETCH_HEAD', '  # not FETCH_HEAD', ' * FETCH_HEAD is shared', '/* FETCH_HEAD */'])
    assert.deepEqual(fetchHeadReads(comment), [], comment);
});

test('invariant: no script or workflow step reads FETCH_HEAD', () => {
  const offenders = ROOTS.flatMap(files).flatMap((file) => fetchHeadReads(readFileSync(file, 'utf8')).map((read) => `${file}:${read}`));
  assert.deepEqual(offenders, [], "take the commit id from the remote's answer: fetchBranchCommit in scripts/remote-branch.mjs");
});
