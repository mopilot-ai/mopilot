// Patch application IPC isolates concurrent payloads and cleans up without changing the apply result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { register } = createRequire(import.meta.url)('../electron/app/ipc/files.cjs');
const ok = { ok: true, code: 0, stdout: '', stderr: '' };

function setup(t: any, run: any) {
  const files = new Map<string, string>();
  const removed: string[] = [];
  let count = 0;
  t.mock.method(fs, 'mkdtempSync', (prefix: string) => `${prefix}${++count}`);
  t.mock.method(fs, 'writeFileSync', (file: string, text: string) => {
    files.set(file, text);
  });
  t.mock.method(fs, 'rmSync', (file: string) => {
    removed.push(file);
    for (const name of files.keys()) if (name === file || name.startsWith(file + path.sep)) files.delete(name);
  });
  t.mock.method(console, 'warn', () => {});
  const handlers = new Map<string, (...args: any[]) => any>();
  register({ handle: (name: string, callback: any) => handlers.set(name, callback) }, { run, live: {} });
  return { files, removed, apply: (patch: string, reverse = false) => handlers.get('git:applyPatch')!({}, '/repo', patch, reverse) };
}

test('patches started in the same millisecond retain independent files and payloads', async (t) => {
  t.mock.method(Date, 'now', () => 123);
  const paths: string[] = [];
  const releases: ((result: any) => void)[] = [];
  const fx = setup(t, async (_cmd: string, args: string[], options: { cwd: string }) => {
    assert.equal(options.cwd, '/repo');
    paths.push(args.at(-1)!);
    return new Promise((resolve) => releases.push(resolve));
  });
  const first = fx.apply('first patch', true);
  const second = fx.apply('second patch\n');
  try {
    assert.equal(new Set(paths).size, 2);
    assert.deepEqual(
      paths.map((file) => fx.files.get(file)),
      ['first patch\n', 'second patch\n'],
    );
  } finally {
    for (const release of releases) release(ok);
    await Promise.allSettled([first, second]);
  }
  assert.deepEqual(
    fx.removed,
    paths.map((file) => path.dirname(file)),
  );
  assert.equal(fx.files.size, 0);
});

for (const stage of ['write', 'run']) {
  test(`a ${stage} rejection still attempts cleanup and retains the original error`, async (t) => {
    const primary = new Error(`${stage} failed`);
    const removed: string[] = [];
    const fx = setup(t, async () => {
      throw primary;
    });
    if (stage === 'write')
      t.mock.method(fs, 'writeFileSync', () => {
        throw primary;
      });
    t.mock.method(fs, 'rmSync', (dir: string) => {
      removed.push(dir);
      throw new Error('cleanup failed');
    });
    await assert.rejects(fx.apply('patch'), (error) => error === primary);
    assert.equal(removed.length, 1);
    assert.match(removed[0], /sage-codex-patch-/);
  });
}

test('cleanup failures preserve both successful and refused Git apply results', async (t) => {
  let result = ok;
  const fx = setup(t, async () => result);
  t.mock.method(fs, 'rmSync', () => {
    throw new Error('cleanup failed');
  });
  assert.equal(await fx.apply('patch'), result);
  result = { ok: false, code: 1, stdout: '', stderr: 'patch refused' };
  assert.equal(await fx.apply('patch'), result);
});
