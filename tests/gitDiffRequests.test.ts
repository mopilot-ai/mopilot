// Pending Git diff reads coalesce without caching completed or rejected results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createGitDiff } = createRequire(import.meta.url)('../electron/platform/gitDiff.cjs');
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });

test('simultaneous diff requests share a read and completion permits a fresh read', async () => {
  let reads = 0;
  let text = 'first patch';
  const read = createGitDiff(async (_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return ok('/repo');
    if (args[0] === 'ls-files') return ok();
    reads++;
    return ok(text);
  });
  assert.deepEqual(await Promise.all([read('/repo'), read('/repo')]), ['first patch', 'first patch']);
  assert.equal(reads, 1);
  text = 'second patch';
  assert.equal(await read('/repo'), 'second patch');
  assert.equal(reads, 2);
});

test('whole-folder and selected-file reads do not share results or collide across path keys', async () => {
  const folders: string[] = [];
  const read = createGitDiff(async (_cmd: string, args: string[], options: { cwd: string }) => {
    if (args[0] === 'rev-parse') {
      folders.push(options.cwd);
      return ok(options.cwd);
    }
    if (args[0] === 'ls-files') return ok();
    return ok(args.includes('--') ? args.at(-1)! : 'whole repo');
  });
  const results = await Promise.all([
    read('/repo'),
    read('/repo', 'file.txt'),
    read('/repo', 'other.txt'),
    read('/repo::file', 'name'),
    read('/repo', 'file::name'),
  ]);
  assert.deepEqual(results, ['whole repo', ':(literal)file.txt', ':(literal)other.txt', ':(literal)name', ':(literal)file::name']);
  assert.equal(folders.length, 5);
});

test('a rejected diff read is shared and cleared for retry', async () => {
  let reject = true;
  let roots = 0;
  const read = createGitDiff(async (_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') {
      roots++;
      if (reject) throw Error('Git unavailable');
      return ok('/repo');
    }
    return ok();
  });
  const outcomes = await Promise.allSettled([read('/repo'), read('/repo')]);
  assert.ok(outcomes.every((result) => result.status === 'rejected'));
  assert.equal(roots, 1);
  reject = false;
  assert.equal(await read('/repo'), '');
  assert.equal(roots, 2);
});

test('a fresh read bypasses an older snapshot without letting its completion evict the fresh request', async () => {
  const releases: ((value: any) => void)[] = [];
  let reads = 0;
  const read = createGitDiff(async (_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return ok('/repo');
    if (args[0] === 'ls-files') return ok();
    reads++;
    return new Promise((resolve) => releases.push(resolve));
  });
  const old = read('/repo');
  await new Promise((resolve) => setImmediate(resolve));
  const fresh = read('/repo', undefined, true);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    releases[0](ok('old snapshot'));
    assert.equal(await old, 'old snapshot');
    const shared = read('/repo');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    releases[1](ok('fresh snapshot'));
    assert.deepEqual(await Promise.all([fresh, shared]), ['fresh snapshot', 'fresh snapshot']);
  } finally {
    for (const release of releases) release(ok('cleanup'));
    await Promise.allSettled([old, fresh]);
  }
});
