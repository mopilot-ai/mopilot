// Pending Git status requests share reads and release results for retry and refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createGitQueries } = createRequire(import.meta.url)('../electron/platform/gitQueries.cjs');
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });

test('overlapping status calls share one read and a later call reads fresh data', async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  let blocked = true;
  let name = 'first.txt';
  let reads = 0;
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => {
      if (args[0] === 'status') {
        reads++;
        return blocked ? pending : ok(` M ${name}\0`);
      }
      return ok(`1\t0\t${name}\0`);
    },
    fs: { existsSync: () => true },
  });
  const first = queries.gitStatus('/repo');
  const second = queries.gitStatus('/repo');
  try {
    await Promise.resolve();
    assert.equal(reads, 1);
    blocked = false;
    resolve(ok(' M first.txt\0'));
    const results = await Promise.all([first, second]);
    assert.deepEqual(results[0], results[1]);
    name = 'second.txt';
    assert.equal((await queries.gitStatus('/repo')).files[0].path, 'second.txt');
    assert.equal(reads, 2);
  } finally {
    blocked = false;
    resolve(ok(' M first.txt\0'));
    await Promise.allSettled([first, second]);
  }
});

test('different folders have independent status reads', async () => {
  const folders: string[] = [];
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[], options: { cwd: string }) => {
      if (args[0] === 'status') folders.push(options.cwd);
      return ok();
    },
    fs: { existsSync: () => true },
  });
  await Promise.all([queries.gitStatus('/one'), queries.gitStatus('/one'), queries.gitStatus('/two')]);
  assert.deepEqual(folders.sort(), ['/one', '/two']);
});

test('a rejected read is shared and removed so the next call can retry', async () => {
  let reject = true;
  let reads = 0;
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => {
      if (args[0] === 'status') {
        reads++;
        if (reject) throw new Error('Git unavailable');
      }
      return ok();
    },
    fs: { existsSync: () => true },
  });
  const outcomes = await Promise.allSettled([queries.gitStatus('/repo'), queries.gitStatus('/repo')]);
  assert.ok(outcomes.every((result) => result.status === 'rejected'));
  assert.equal(reads, 1);
  reject = false;
  assert.deepEqual(await queries.gitStatus('/repo'), { files: [] });
  assert.equal(reads, 2);
});

test('fresh status bypasses an older pending read and retains ownership after the old one finishes', async () => {
  const releases: ((value: any) => void)[] = [];
  let reads = 0;
  const queries = createGitQueries({
    run: async (_cmd: string, args: string[]) => {
      if (args[0] === 'status') {
        reads++;
        return new Promise((resolve) => releases.push(resolve));
      }
      return ok('1\t0\told.txt\0' + '1\t0\tnew.txt\0');
    },
    fs: { existsSync: () => true },
  });
  const old = queries.gitStatus('/repo');
  await new Promise((resolve) => setImmediate(resolve));
  const fresh = queries.gitStatus('/repo', true);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    releases[0](ok(' M old.txt\0'));
    await old;
    const shared = queries.gitStatus('/repo');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    releases[1](ok(' M new.txt\0'));
    const results = await Promise.all([fresh, shared]);
    assert.ok(results.every((result) => result.files[0].path === 'new.txt'));
  } finally {
    for (const release of releases) release(ok());
    await Promise.allSettled([old, fresh]);
  }
});
