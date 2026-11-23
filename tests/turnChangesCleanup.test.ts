// Snapshot cleanup preserves capture outcomes using exclusively in-memory filesystem and Git boundaries.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { deferred } from './support/async-scenarios.ts';

// the snapshot steps live in shared/turnTree.mjs, run by turnChanges.cjs with the fake git and file system below
const turnTree = await import('../shared/turnTree.mjs');

const sourcePath = process.env.SNAPSHOT_SOURCE || fileURLToPath(new URL('../electron/session/turnChanges.cjs', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');

function fixture({
  cleanupFails = (_capture: number) => false,
  gitFailure = null,
  indexFailure = false,
  cleanupHook = async (_target: string) => {},
}: {
  cleanupFails?: (capture: number) => boolean;
  gitFailure?: string | null;
  indexFailure?: boolean;
  cleanupHook?: (target: string) => Promise<void>;
} = {}) {
  const cleanupError = new Error('temporary directory is busy');
  const failure = new Error('snapshot capture failed');
  const removed: { target: string; options: any }[] = [];
  const diagnostics: any[][] = [];
  let captures = 0;
  let trees = 0;
  const fs = {
    mkdtemp: async () => `/virtual/tmp/capture-${++captures}`,
    open: async () => {
      if (indexFailure) throw failure;
      return {
        stat: async () => ({ atime: 0, mtimeMs: 100 }),
        readFile: async () => 'index',
        close: async () => {},
      };
    },
    writeFile: async () => {},
    utimes: async () => {},
    rm: async (target: string, options: any) => {
      removed.push({ target, options });
      if (options?.recursive) await cleanupHook(target);
      if (options?.recursive && cleanupFails(captures)) throw cleanupError;
      if (!options?.recursive && indexFailure) throw failure;
    },
  };
  const execute = async (command: string, args: string[], options: any) => {
    assert.equal(command, 'git');
    assert.equal(options.cwd, '/virtual/repo');
    if (args[0] === gitFailure) throw failure;
    if (args[0] === 'rev-parse') return { stdout: '/virtual/repo/.git/index\n' };
    if (args[0] === 'write-tree') return { stdout: `tree-${++trees}\n` };
    if (args[0] === 'diff') return { stdout: 'retained precise diff' };
    return { stdout: '' };
  };
  const modules: Record<string, any> = {
    '../platform/ports/proc.cjs': {
      proc: {
        execFile: () => {
          throw new Error('must use fake promisify');
        },
      },
    },
    'node:util': { promisify: () => execute },
    '../platform/ports/fs.cjs': { fs: { promises: fs, realpathSync: (cwd: string) => cwd } },
    'node:os': { tmpdir: () => '/virtual/tmp' },
    'node:path': path,
    '../../shared/gitDiffFlags.mjs': { GIT_DIFF_FLAGS: [] },
    '../../shared/turnTree.mjs': turnTree,
    './workspaceOverlap.cjs': {
      overlappingDirectories: (a: string, b: string) => a === b,
    },
    '../platform/turnDiffCache.cjs': { normalizeDiffCache: () => Object.create(null) },
    '../ignored.cjs': {
      noteIgnored: (...args: any[]) => diagnostics.push(args),
    },
    // the login shell's environment (#1580): none in this sandbox
    '../platform/env.cjs': { childEnv: () => ({}), gitEnv: () => ({}) },
  };
  const module: { exports: any } = { exports: {} };
  runInNewContext(
    source,
    {
      module,
      process: { env: {} },
      require: (name: string) => {
        assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
        return modules[name];
      },
    },
    { filename: sourcePath },
  );
  const changes = new module.exports.TurnChanges();
  return { changes, removed, diagnostics, cleanupError, failure };
}

for (const failingCapture of [1, 2]) {
  test(`cleanup failure at capture ${failingCapture} retains the precise diff and its cache`, async () => {
    const f = fixture({
      cleanupFails: (capture) => capture === failingCapture,
    });
    await f.changes.begin('thread', '/virtual/repo');
    assert.equal(f.changes.baselines.get('thread').tree, 'tree-1');
    assert.equal(await f.changes.finish('thread', 'turn'), 'retained precise diff');
    assert.equal(f.changes.restore('thread', [{ id: 'turn', diff: 'native diff' }])[0].diff, 'retained precise diff');
    assert.equal(f.diagnostics.length, 1);
    assert.equal(f.diagnostics[0][1], f.cleanupError);
    assert.equal(f.removed.length, 2);
    assert.equal(f.changes.finishing.size, 0);
  });
}

test('successful cleanup remains quiet and removes only its owned directory', async () => {
  const f = fixture();
  assert.equal(await f.changes.capture('/virtual/repo'), 'tree-1');
  assert.deepEqual(
    f.removed.map(({ target, options }) => [target, options.recursive, options.force]),
    [['/virtual/tmp/capture-1', true, true]],
  );
  assert.equal(f.diagnostics.length, 0);
});

for (const gitFailure of ['add', 'write-tree']) {
  test(`${gitFailure} failure remains the original failure even when cleanup fails`, async () => {
    const f = fixture({ cleanupFails: () => true, gitFailure });
    await assert.rejects(f.changes.capture('/virtual/repo'), (error) => error === f.failure);
    assert.equal(f.diagnostics.length, 1);
  });
}

test('correctness-critical index reset failure is not swallowed', async () => {
  const f = fixture({ indexFailure: true, cleanupFails: () => true });
  await assert.rejects(f.changes.capture('/virtual/repo'), (error) => error === f.failure);
  assert.equal(f.removed.length, 2);
});

test('genuine capture failure still retains the overlap reservation and native diff', async () => {
  const f = fixture({ gitFailure: 'write-tree', cleanupFails: () => true });
  await f.changes.begin('thread', '/virtual/repo');
  assert.equal(f.changes.baselines.get('thread').tree, null);
  assert.equal(f.changes.baselines.get('thread').shared, true);
  assert.equal(await f.changes.finish('thread', 'turn'), undefined);
  assert.equal(f.changes.restore('thread', [{ id: 'turn', diff: 'native diff' }])[0].diff, 'native diff');
});

test('overlapping turns still suppress attribution after cleanup failure', async () => {
  const f = fixture({ cleanupFails: () => true });
  await f.changes.begin('first', '/virtual/repo');
  await f.changes.begin('second', '/virtual/repo');
  assert.equal(f.changes.baselines.get('first').tree, 'tree-1');
  assert.equal(f.changes.baselines.get('second').tree, 'tree-2');
  assert.equal(await f.changes.finish('first', 'turn1'), undefined);
  assert.equal(await f.changes.finish('second', 'turn2'), undefined);
});

test('independent: retired begin cleanup cannot populate replacement baseline', async () => {
  const started = deferred(),
    release = deferred();
  const f = fixture({
    cleanupFails: () => true,
    cleanupHook: async (target) => {
      if (target.endsWith('capture-1')) {
        started.resolve();
        await release.promise;
      }
    },
  });
  const old = f.changes.begin('thread', '/virtual/repo');
  await started.promise;
  await f.changes.begin('thread', '/virtual/repo');
  const replacement = f.changes.baselines.get('thread');
  assert.equal(replacement.tree, 'tree-2');
  release.resolve();
  await old;
  assert.equal(f.changes.baselines.get('thread'), replacement);
  assert.equal(replacement.tree, 'tree-2');
  assert.equal(await f.changes.finish('thread', 'turn'), 'retained precise diff');
  assert.deepEqual(f.removed.map((x: { target: string }) => x.target).sort(), [
    '/virtual/tmp/capture-1',
    '/virtual/tmp/capture-2',
    '/virtual/tmp/capture-3',
  ]);
});
for (const retirement of ['abort', 'clear', 'overlap'])
  test(`independent: ${retirement} during final cleanup prevents stale publication`, async () => {
    const started = deferred(),
      release = deferred();
    const f = fixture({
      cleanupFails: () => true,
      cleanupHook: async (target) => {
        if (target.endsWith('capture-2')) {
          started.resolve();
          await release.promise;
        }
      },
    });
    await f.changes.begin('thread', '/virtual/repo');
    const finishing = f.changes.finish('thread', 'turn');
    await started.promise;
    assert.equal(f.changes.finishing.size, 1);
    if (retirement === 'overlap') await f.changes.begin('new', '/virtual/repo');
    else if (retirement === 'abort') f.changes.abort('thread');
    else f.changes.clear();
    release.resolve();
    assert.equal(await finishing, undefined);
    assert.equal(f.changes.finishing.size, 0);
    assert.equal(f.changes.restore('thread', [{ id: 'turn', diff: 'native' }])[0].diff, 'native');
    assert.deepEqual(
      f.removed.map((x: { target: string }) => x.target),
      retirement === 'overlap'
        ? ['/virtual/tmp/capture-1', '/virtual/tmp/capture-2', '/virtual/tmp/capture-3']
        : ['/virtual/tmp/capture-1', '/virtual/tmp/capture-2'],
    );
  });
