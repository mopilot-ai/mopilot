// Every field the real Host puts in a folder reply reaches the app (electron/host/folders.cjs): each reader there rebuilds the reply from the fields it names, so a field the Host adds, or one a reader forgot, is dropped before the Changes pane or the Files tree sees it (`conflicted` of git.diff was, #5237; `counted` of git.status files too). The replies come from the real Host services over a real git repository, and the fields are read off the replies themselves, so a new field cannot be dropped silently.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { realHostFolders } from './support/realHostFolders.ts';

const world = realHostFolders();
after(() => world.dispose());

/** Every field path of a reply, objects and the elements of arrays alike: `files[].counted`. */
function fieldPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap((v) => fieldPaths(v, `${prefix}[]`)))];
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => [
      `${prefix}.${k}`.replace(/^\./, ''),
      ...fieldPaths(v, `${prefix}.${k}`.replace(/^\./, '')),
    ]);
  return [];
}
/** The fields of the Host's reply that the app's reader left out. */
const dropped = (method: string, app: unknown) => fieldPaths(world.raw[method]).filter((f) => !fieldPaths(app).includes(f));

/** One repository holding every kind of row a reply can carry: a conflicted file, an untracked text file (counted), a binary one, a subfolder. */
const dir = world.repo({ conflict: true });
fs.mkdirSync(path.join(dir, 'sub'));
fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), 'c\n');

test('git.diff: every field of the Host reply reaches the app, the conflicted files included (#5237)', async () => {
  const app = await world.folders.diff('box', { path: dir, scope: 'uncommitted' });
  assert.deepEqual(app.conflicted, ['a.txt']);
  assert.deepEqual(dropped('git.diff', app), []);
});

test('git.status: every field of the Host reply reaches the app, the counted flag of an untracked file included', async () => {
  // a branch pushed to a second remote, so the reply carries `upstream` and its fields
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  const branch = git('symbolic-ref', '--short', 'HEAD').stdout.trim();
  git('remote', 'add', 'internal', 'https://example.com/o/internal.git');
  git('config', `branch.${branch}.remote`, 'internal');
  git('config', `branch.${branch}.merge`, 'refs/heads/feat');
  const app = await world.folders.status('box', { path: dir });
  assert.deepEqual(app.upstream, { remote: 'https://example.com/o/internal.git', branch: 'feat' });
  assert.deepEqual(
    app.files.filter((f: any) => f.untracked && f.counted).map((f: any) => f.path),
    ['new.txt', 'sub/c.txt'],
    'the untracked text files carry their count',
  );
  assert.equal(
    app.files.some((f: any) => f.binary),
    true,
    'the fixture holds a binary file',
  );
  assert.deepEqual(dropped('git.status', app), []);
});

test('host.gitBranches, fs.tree, fs.read and fs.list: every field of the Host reply reaches the app', async () => {
  const branches = await world.folders.branches('box', { path: dir });
  assert.deepEqual(dropped('host.gitBranches', branches), []);
  const tree = await world.folders.tree('box', { path: dir });
  assert.deepEqual(dropped('fs.tree', tree), []);
  const text = await world.folders.read('box', { path: path.join(dir, 'a.txt') });
  assert.deepEqual(dropped('fs.read', text), []);
  const binary = await world.folders.read('box', { path: path.join(dir, 'pic.bin') });
  assert.equal(binary.kind, 'binary');
  assert.deepEqual(dropped('fs.read', binary), []);
  const listing = await world.folders.list('box', { path: dir });
  assert.deepEqual(dropped('fs.list', listing), []);
});

test('host.gitCommit and host.gitDiscard: every field of the Host reply reaches the app, a refusal included', async () => {
  // a commit of everything while a file is in conflict is refused with a sentence for the person
  const refused = await world.folders.commit('box', { path: dir, message: 'm', files: null });
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true);
  assert.deepEqual(dropped('host.gitCommit', refused), []);
  const discarded = await world.folders.discard('box', { path: dir, file: 'sub/c.txt' });
  assert.deepEqual(dropped('host.gitDiscard', discarded), []);
});

test('the check sees a dropped field: a reader that names fewer fields than the Host sends is reported', () => {
  assert.deepEqual(fieldPaths({ a: 1, files: [{ p: 1 }, { p: 2, counted: true }] }), ['a', 'files', 'files[].p', 'files[].counted']);
  assert.deepEqual(dropped('git.diff', { isRepo: true }).includes('conflicted'), true);
});
