// What the folder reader keeps of a Host's git.diff and git.status replies (electron/host/folders.cjs, #5237): the files in conflict as bounded paths, and a status row's counted flag. The whole-reply check against the real Host is tests/hostReplyPassThrough.invariant.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHostFolders } = require('../electron/host/folders.cjs');

/** A service over a fake connection that answers `reply` to the one request. */
const folders = (reply: unknown) =>
  createHostFolders({
    open: async () => ({ call: async () => reply, close: () => undefined }),
    store: {},
  });

test('diff keeps the files in conflict as paths only, bounded; a reply that is no list names none', async () => {
  const many = Array.from({ length: 5100 }, (_, i) => `f${i}`);
  const diff = async (conflicted: unknown) =>
    folders({ isRepo: true, patch: '', conflicted }).diff('box', { path: '/x', scope: 'uncommitted' });
  assert.deepEqual((await diff(['a.ts', 7, '', null, 'b/c.ts', 'x'.repeat(4097)])).conflicted, ['a.ts', 'b/c.ts']);
  assert.equal((await diff(many)).conflicted.length, 5000);
  assert.equal('conflicted' in (await diff('a.ts')), false);
  assert.equal('conflicted' in (await diff(undefined)), false, 'an older Host: none named');
});

test('status keeps the counted flag of a row, and only when it is true', async () => {
  const row = { path: 'n.ts', added: 2, removed: 0, untracked: true };
  const status = await folders({
    isRepo: true,
    files: [
      { ...row, counted: true },
      { ...row, path: 'o.ts', counted: 'yes' },
    ],
    truncated: false,
  }).status('box', { path: '/x' });
  assert.deepEqual(
    status.files.map((f: any) => [f.path, f.counted]),
    [
      ['n.ts', true],
      ['o.ts', undefined],
    ],
  );
});

test('status keeps where the branch is pushed as two bounded strings, and none from an older Host or a malformed one', async () => {
  const upstream = async (value: unknown) =>
    (await folders({ isRepo: true, files: [], upstream: value }).status('box', { path: '/x' })).upstream;
  assert.deepEqual(await upstream({ remote: 'https://github.com/o/internal.git', branch: 'feat', extra: 1 }), {
    remote: 'https://github.com/o/internal.git',
    branch: 'feat',
  });
  for (const bad of [
    undefined,
    null,
    'https://github.com/o/r',
    { remote: 'https://github.com/o/r' },
    { remote: '', branch: 'feat' },
    { remote: 7, branch: 'feat' },
    { remote: 'x'.repeat(1001), branch: 'feat' },
  ])
    assert.equal(await upstream(bad), null, JSON.stringify(bad));
});
