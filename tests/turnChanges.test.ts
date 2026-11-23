// Per-turn snapshot attribution, persistence and overlapping runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseUnifiedDiff } from '../src/lib/diff.ts';
const { TurnChanges } = createRequire(import.meta.url)('../electron/session/turnChanges.cjs');

// Existing in-memory snapshots use an in-memory directory identity too.
class VirtualTurnChanges extends TurnChanges {
  constructor(capture?: any, compare?: any, store?: any) {
    super(capture, compare, store, (cwd: string) => cwd);
  }
}

test('private snapshots include script writes after a commit and exclude pre-existing work without touching the index', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'turn-changes-ut-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'UT');
    git('config', 'user.email', 'ut@example.invalid');
    await writeFile(join(cwd, 'source.ts'), 'old\n');
    await writeFile(join(cwd, 'user.txt'), 'original\n');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    await writeFile(join(cwd, 'user.txt'), 'user staged work\n');
    git('add', 'user.txt');
    await writeFile(join(cwd, 'user.txt'), 'user unstaged work\n');
    const index = await readFile(join(cwd, '.git/index'));
    const changes = new TurnChanges();
    await changes.begin('thread', cwd);
    assert.deepEqual(await readFile(join(cwd, '.git/index')), index);
    await writeFile(join(cwd, 'source.ts'), 'fixed\n');
    await writeFile(join(cwd, 'test.ts'), 'new test\n');
    git('add', 'source.ts', 'test.ts');
    git('commit', '-qm', 'agent changes');
    const committedIndex = await readFile(join(cwd, '.git/index'));
    const diff = await changes.finish('thread');
    assert.match(diff, /diff --git a\/source.ts b\/source.ts/);
    assert.match(diff, /diff --git a\/test.ts b\/test.ts/);
    assert.doesNotMatch(diff, /diff --git a\/user.txt/);
    assert.deepEqual(await readFile(join(cwd, '.git/index')), committedIndex);
    assert.equal(await changes.finish('thread'), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an unborn repository includes newly created files and reports an empty net diff after reverting', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'turn-changes-unborn-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const changes = new TurnChanges();
    await changes.begin('first', cwd);
    await writeFile(join(cwd, 'new.txt'), 'new\n');
    assert.match(await changes.finish('first'), /new file mode/);
    await changes.begin('reverted', cwd);
    await writeFile(join(cwd, 'new.txt'), 'temporary\n');
    await writeFile(join(cwd, 'new.txt'), 'new\n');
    assert.equal(await changes.finish('reverted'), '');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('missing cwd, capture errors and compare errors fall back without stale baselines', async () => {
  const changes = new VirtualTurnChanges(
    async (cwd: string) => {
      if (cwd === 'bad') throw new Error('capture');
      return cwd;
    },
    async () => {
      throw new Error('compare');
    },
  );
  await changes.begin('missing', undefined);
  assert.equal(await changes.finish('missing'), undefined);
  await changes.begin('bad', 'bad');
  assert.equal(await changes.finish('bad'), undefined);
  await changes.begin('compare', 'good');
  assert.equal(await changes.finish('compare'), undefined);
  let capture = 0;
  const ending = new VirtualTurnChanges(async () => {
    if (++capture > 1) throw new Error('end');
    return 'tree';
  });
  await ending.begin('end', 'good');
  assert.equal(await ending.finish('end'), undefined);
});

test('threads retain independent baselines; abort and exit clear outstanding turns', async () => {
  let sequence = 0;
  const changes = new VirtualTurnChanges(
    async () => ++sequence,
    async (cwd: string, before: number, after: number) => `${cwd}:${before}:${after}`,
  );
  await changes.begin('a', '/a');
  await changes.begin('b', '/b');
  assert.equal(await changes.finish('a'), '/a:1:3');
  assert.equal(await changes.finish('b'), '/b:2:4');
  await changes.begin('abort', '/a');
  changes.abort('abort');
  assert.equal(await changes.finish('abort'), undefined);
  await changes.begin('clear', '/a');
  changes.clear();
  assert.equal(await changes.finish('clear'), undefined);
});

test('completed diffs survive reload and preserve explicit empty diffs without replacing unrelated turns', async () => {
  const saved: Record<string, any> = {};
  const store = {
    read: (id: string) => saved[id] ?? null,
    write: (id: string, value: any) => {
      saved[id] = JSON.parse(JSON.stringify(value));
    },
  };
  const changes = new VirtualTurnChanges(
    async () => 'tree',
    async () => '',
    store,
  );
  await changes.begin('thread', '/work');
  await changes.finish('thread', 'turn');
  await changes.begin('thread', '/work');
  await changes.finish('thread', 'next');
  const restored = new VirtualTurnChanges(undefined, undefined, store);
  assert.deepEqual(restored.restore('thread', [{ id: 'turn', diff: 'stale' }, { id: 'next' }, { id: 'other', diff: 'native' }]), [
    { id: 'turn', diff: '' },
    { id: 'next', diff: '' },
    { id: 'other', diff: 'native' },
  ]);
  assert.deepEqual(restored.restore('other-thread', [{ id: 'turn' }]), [{ id: 'turn' }]);
  const memoryOnly = new VirtualTurnChanges(
    async () => 'tree',
    async () => 'patch',
  );
  await memoryOnly.begin('thread', '/work');
  await memoryOnly.finish('thread', 'turn');
  assert.equal(memoryOnly.restore('thread', [{ id: 'turn' }])[0].diff, 'patch');
});

test('non-Git folders fall back to native changes without leaving a baseline', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'turn-changes-nongit-'));
  try {
    const changes = new TurnChanges();
    await changes.begin('thread', cwd);
    assert.equal(await changes.finish('thread'), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("overlapping turns in the same folder retain native attribution instead of claiming each other's edits", async () => {
  const changes = new VirtualTurnChanges(
    async () => 'tree',
    async () => 'mixed patch',
  );
  await changes.begin('first', '/work');
  await changes.begin('second', '/work');
  assert.equal(await changes.finish('first'), undefined);
  assert.equal(await changes.finish('second'), undefined);
});

test('exit or abort during capture cannot reinstall a stale baseline', async () => {
  for (const rejects of [false, true]) {
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const changes = new VirtualTurnChanges(
      () =>
        new Promise((r, j) => {
          resolve = r;
          reject = j;
        }),
    );
    const beginning = changes.begin('thread', '/work');
    changes.clear();
    if (rejects) reject(new Error('capture'));
    else resolve('tree');
    await beginning;
    assert.equal(await changes.finish('thread'), undefined);
  }
  // a finish during capture waits for it: tests/turnChangesParallelStart.test.ts
});

test('per-turn patches remain parseable from a subfolder with custom Git color and path settings', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'turn-changes-format-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'UT');
    git('config', 'user.email', 'ut@example.invalid');
    git('config', 'color.ui', 'always');
    git('config', 'diff.noprefix', 'true');
    git('config', 'diff.mnemonicPrefix', 'true');
    git('config', 'diff.relative', 'true');
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src/file.txt'), 'old\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    const changes = new TurnChanges();
    await changes.begin('thread', join(cwd, 'src'));
    await writeFile(join(cwd, 'src/file.txt'), 'new\n');
    const diff = await changes.finish('thread');
    assert.equal(typeof diff, 'string');
    assert.equal(diff.includes('\u001b['), false);
    const files = parseUnifiedDiff(diff);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'src/file.txt');
    assert.equal(files[0].added, 1);
    assert.equal(files[0].removed, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('overlap tracking includes a turn whose final snapshot is still pending', async () => {
  let end!: (tree: string) => void;
  let captures = 0;
  const saved: unknown[] = [];
  const changes = new VirtualTurnChanges(
    () =>
      ++captures === 2
        ? new Promise((resolve) => {
            end = resolve;
          })
        : Promise.resolve('tree'),
    async () => 'mixed edits',
    { read: () => null, write: (_id: string, value: unknown) => saved.push(value) },
  );
  await changes.begin('first', '/work');
  const finishing = changes.finish('first', 'turn-1');
  await changes.begin('second', '/work');
  end('after');
  assert.equal(await finishing, undefined);
  assert.equal(await changes.finish('second', 'turn-2'), undefined);
  assert.deepEqual(saved, []);
});

test('an unrelated folder and duplicate completion preserve a pending final snapshot', async () => {
  let end!: (tree: string) => void;
  let captures = 0;
  const changes = new VirtualTurnChanges(
    () =>
      ++captures === 2
        ? new Promise((resolve) => {
            end = resolve;
          })
        : Promise.resolve('tree'),
    async () => 'own edits',
  );
  await changes.begin('first', '/first');
  const finishing = changes.finish('first');
  assert.equal(await changes.finish('first'), undefined);
  await changes.begin('second', '/second');
  changes.abort('second');
  end('after');
  assert.equal(await finishing, 'own edits');
  await changes.begin('third', '/first');
  assert.equal(await changes.finish('third'), 'own edits');
});

test('abort and clear invalidate pending final snapshots without losing overlap tracking', async () => {
  for (const action of ['abort', 'clear']) {
    let end!: (tree: string) => void;
    let captures = 0;
    const changes = new VirtualTurnChanges(
      () =>
        ++captures === 2
          ? new Promise((resolve) => {
              end = resolve;
            })
          : Promise.resolve('tree'),
      async () => 'mixed edits',
    );
    await changes.begin('first', '/work');
    const finishing = changes.finish('first');
    if (action === 'abort') changes.abort('first');
    else changes.clear();
    await changes.begin('second', '/work');
    end('after');
    assert.equal(await finishing, undefined);
    assert.equal(await changes.finish('second'), undefined);
    await changes.begin('third', '/work');
    assert.equal(await changes.finish('third'), 'mixed edits');
  }
});

test('a turn starting during comparison cannot publish a stale mixed diff', async () => {
  let end!: (diff: string) => void;
  let entered!: () => void;
  const comparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const saved: unknown[] = [];
  const changes = new VirtualTurnChanges(
    async () => 'tree',
    () =>
      new Promise((resolve) => {
        end = resolve;
        entered();
      }),
    { read: () => null, write: (_id: string, value: unknown) => saved.push(value) },
  );
  await changes.begin('first', '/work');
  const finishing = changes.finish('first', 'turn');
  await comparing;
  await changes.begin('second', '/work');
  end('mixed edits');
  assert.equal(await finishing, undefined);
  assert.equal(await changes.finish('second'), undefined);
  assert.deepEqual(saved, []);
});

test('a failed final snapshot releases overlap tracking for later turns', async () => {
  let captures = 0;
  const changes = new VirtualTurnChanges(
    async () => {
      if (++captures === 2) throw new Error('capture');
      return 'tree';
    },
    async () => 'own edits',
  );
  await changes.begin('first', '/work');
  assert.equal(await changes.finish('first'), undefined);
  await changes.begin('second', '/work');
  assert.equal(await changes.finish('second'), 'own edits');
});

test('turns in parent and child folders retain native attribution in either start order', async () => {
  for (const folders of [
    ['/work', '/work/src'],
    ['/work/src', '/work'],
  ]) {
    const changes = new VirtualTurnChanges(
      async () => 'tree',
      async () => 'mixed edits',
    );
    await changes.begin('first', folders[0]);
    await changes.begin('second', folders[1]);
    assert.equal(await changes.finish('first'), undefined);
    assert.equal(await changes.finish('second'), undefined);
  }
});

test('malformed saved diff caches preserve native changes and accept later snapshots', async () => {
  for (const data of [null, undefined, 42, true, 'patch', []]) {
    let saved: any;
    const changes = new VirtualTurnChanges(
      async () => 'tree',
      async () => 'fresh patch',
      {
        read: () => data,
        write: (_id: string, value: unknown) => {
          saved = value;
        },
      },
    );
    const native = { id: 'turn', diff: 'native patch' };
    assert.equal(changes.restore('thread', [native])[0], native);
    await changes.begin('thread', '/work');
    assert.equal(await changes.finish('thread', 'next'), 'fresh patch');
    assert.equal(saved.next, 'fresh patch');
  }
});

test('saved diff validation retains valid and empty patches while dropping malformed values', () => {
  const data: Record<string, any> = {
    thread: { patch: 'saved patch', empty: '', number: 42, null: null, array: [], object: {}, boolean: false },
    other: { turn: 'other patch' },
  };
  const changes = new VirtualTurnChanges(undefined, undefined, { read: (id: string) => data[id], write() {} });
  assert.deepEqual(changes.restore('thread', [{ id: 'patch' }, { id: 'empty', diff: 'stale' }]), [
    { id: 'patch', diff: 'saved patch' },
    { id: 'empty', diff: '' },
  ]);
  for (const id of ['number', 'null', 'array', 'object', 'boolean', 'missing']) {
    const native = { id, diff: 'native patch' };
    assert.equal(changes.restore('thread', [native])[0], native);
  }
  assert.deepEqual(changes.restore('other', [{ id: 'turn' }]), [{ id: 'turn', diff: 'other patch' }]);
  assert.equal(data.thread.number, 42);
});

test('saved diff dictionaries treat reserved names as ordinary own keys', async () => {
  const data = JSON.parse('{"__proto__":{"turn":"saved patch"},"thread":{"__proto__":"reserved patch"}}');
  const changes = new VirtualTurnChanges(
    async () => 'tree',
    async () => 'fresh patch',
    { read: (id: string) => data[id], write() {} },
  );
  assert.deepEqual(changes.restore('__proto__', [{ id: 'turn' }]), [{ id: 'turn', diff: 'saved patch' }]);
  assert.deepEqual(changes.restore('thread', [{ id: '__proto__' }]), [{ id: '__proto__', diff: 'reserved patch' }]);
  const native = { id: 'name', diff: 'native patch' };
  assert.equal(changes.restore('toString', [native])[0], native);
  await changes.begin('toString', '/work');
  await changes.finish('toString', '__proto__');
  assert.deepEqual(changes.restore('toString', [{ id: '__proto__' }]), [{ id: '__proto__', diff: 'fresh patch' }]);
});
