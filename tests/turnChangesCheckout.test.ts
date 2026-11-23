// A checkout during a turn is not the turn's edit (#2482): what the new HEAD brought in is left out of the turn's diff,
// while the agent's own writes in the same turn, and anything it changed on top of the checkout, are kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const { TurnChanges, compareTrees, headOf } = createRequire(import.meta.url)('../electron/session/turnChanges.cjs');

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'turn-changes-checkout-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'UT');
  git('config', 'user.email', 'ut@example.invalid');
  await writeFile(join(dir, 'a.txt'), 'a one\n');
  await writeFile(join(dir, 'b.txt'), 'b one\n');
  git('add', '.');
  git('commit', '-qm', 'main');
  git('switch', '-qc', 'other');
  await writeFile(join(dir, 'a.txt'), 'a two\n');
  await writeFile(join(dir, 'c.txt'), 'c from other\n');
  git('add', '.');
  git('commit', '-qm', 'other');
  git('switch', '-q', 'main');
  return { dir, git };
}
const names = (diff: string) => [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);

test('a branch switch alone is no edit of the turn', async () => {
  const { dir, git } = await repo();
  try {
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    git('switch', '-q', 'other');
    assert.equal(await changes.finish('t'), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the agent’s own writes in the turn that switched branch are kept, and so is a checkout-touched file it changed again', async () => {
  const { dir, git } = await repo();
  try {
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    git('switch', '-q', 'other');
    await writeFile(join(dir, 'new.txt'), 'written by the agent\n');
    await writeFile(join(dir, 'a.txt'), 'a three\n');
    // b.txt was not touched by the checkout; c.txt arrived with it and is left as it came
    await writeFile(join(dir, 'b.txt'), 'b two\n');
    const diff = await changes.finish('t');
    assert.deepEqual(names(diff).sort(), ['a.txt', 'b.txt', 'new.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('with no checkout the turn’s diff is every changed file, and a live view follows the same rule', async () => {
  const { dir, git } = await repo();
  try {
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    await writeFile(join(dir, 'b.txt'), 'b two\n');
    assert.deepEqual(names(await changes.peek('t')), ['b.txt']);
    git('switch', '-q', 'other');
    assert.deepEqual(names(await changes.peek('t')), ['b.txt'], 'the checkout is not in the live view either');
    assert.deepEqual(names(await changes.finish('t')), ['b.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file the user had edited before the turn stays in the diff when the checkout carries it along', async () => {
  const { dir, git } = await repo();
  try {
    await writeFile(join(dir, 'b.txt'), 'b local edit\n');
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    git('switch', '-q', 'other');
    await writeFile(join(dir, 'b.txt'), 'b agent edit\n');
    assert.deepEqual(names(await changes.finish('t')), ['b.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a turn that wrote more files than one command line carries, after a checkout, lists them all in order', async () => {
  const { dir, git } = await repo();
  try {
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    git('switch', '-q', 'other');
    const written = Array.from({ length: 450 }, (_, i) => `gen/f${String(i).padStart(3, '0')}.txt`);
    await mkdir(join(dir, 'gen'));
    await Promise.all(written.map((file) => writeFile(join(dir, file), 'x\n')));
    assert.deepEqual(names(await changes.finish('t')), written);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a folder with no commit yet, or none of Git’s, has no head to compare: its turn diff is the snapshots’ difference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turn-changes-unborn-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    await writeFile(join(dir, 'x.txt'), 'x\n');
    assert.deepEqual(names(await changes.finish('t')), ['x.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the agent’s commit after a switch keeps its files, while what the switch brought stays out', async () => {
  const { dir, git } = await repo();
  try {
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    git('switch', '-q', 'other');
    await writeFile(join(dir, 'a.txt'), 'a agent\n');
    await writeFile(join(dir, 'made.txt'), 'made\n');
    git('add', '.');
    git('commit', '-qm', 'agent');
    assert.deepEqual(names(await changes.finish('t')).sort(), ['a.txt', 'made.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a reset the turn ran leaves nothing of the files it moved back, its own commit before it included', async () => {
  const { dir, git } = await repo();
  try {
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    await writeFile(join(dir, 'kept.txt'), 'kept\n');
    git('add', '.');
    git('commit', '-qm', 'agent');
    git('reset', '-q', '--hard', 'other');
    // the reset brought other's a.txt and c.txt and removed kept.txt again: nothing of the turn is left on disk
    assert.equal(await changes.finish('t'), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a head the reflog does not know, or no repository to ask, leaves the diff as the snapshots give it', async () => {
  const { dir } = await repo();
  try {
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).trim();
    const other = execFileSync('git', ['rev-parse', 'other^{tree}'], { cwd: dir, encoding: 'utf8' }).trim();
    const unknown = '0123456789012345678901234567890123456789';
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.deepEqual(names(await compareTrees(dir, tree, other, { before: { id: unknown, log: 1 }, after: { id: head } })), [
      'a.txt',
      'c.txt',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const bare = await mkdtemp(join(tmpdir(), 'turn-changes-no-repo-'));
  try {
    await assert.rejects(compareTrees(bare, 'a', 'b', { before: { id: 'x', log: 0 }, after: { id: 'y' } }));
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('a switch between branches whose files are the same brings nothing in: the turn’s own edit is listed as it is', async () => {
  const { dir, git } = await repo();
  try {
    git('switch', '-qc', 'same');
    git('commit', '-q', '--allow-empty', '-m', 'same files');
    git('switch', '-q', 'main');
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    git('switch', '-q', 'same');
    await writeFile(join(dir, 'b.txt'), 'b two\n');
    assert.deepEqual(names(await changes.finish('t')), ['b.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the head of a folder is its commit, and null where there is none to name', async () => {
  const { dir, git } = await repo();
  try {
    assert.deepEqual(await headOf(dir), { id: git('rev-parse', 'HEAD').trim(), log: 4 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const fresh = await mkdtemp(join(tmpdir(), 'turn-changes-head-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh });
    assert.equal(await headOf(fresh), null);
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test('the agent’s commit stays in when HEAD comes back to the commit the turn began at', async () => {
  const { dir, git } = await repo();
  try {
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    git('switch', '-qc', 'feat');
    await writeFile(join(dir, 'b.txt'), 'b agent\n');
    git('commit', '-qam', 'agent');
    git('switch', '-q', 'main');
    git('merge', '-q', 'feat');
    assert.deepEqual(names(await changes.finish('t')), ['b.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a conflict the agent resolved and committed is its edit', async () => {
  const { dir, git } = await repo();
  try {
    const changes = new TurnChanges();
    await changes.begin('t', dir);
    await writeFile(join(dir, 'a.txt'), 'a main side\n');
    git('commit', '-qam', 'main side');
    assert.throws(() => git('merge', '-q', 'other'));
    await writeFile(join(dir, 'a.txt'), 'a resolved\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'merge');
    assert.ok(names(await changes.finish('t')).includes('a.txt'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a folder inside a repository lists only its own files after a switch', async () => {
  const { dir, git } = await repo();
  try {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 's.txt'), 's one\n');
    git('add', '.');
    git('commit', '-qm', 'sub');
    git('switch', '-q', 'other');
    git('merge', '-q', 'main');
    git('switch', '-q', 'main');
    const changes = new TurnChanges();
    await changes.begin('t', join(dir, 'sub'));
    git('switch', '-q', 'other');
    await writeFile(join(dir, 'sub', 'mine.txt'), 'mine\n');
    await writeFile(join(dir, 'outside.txt'), 'outside the folder\n');
    const diff = await changes.finish('t');
    assert.deepEqual(names(diff), ['sub/mine.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
