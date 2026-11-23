// Git diff IPC reports command failures and preserves selected literal filenames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/files.cjs');
const { parseLsFilesZ } = require('../electron/platform/gitParse.cjs');
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });

function reader(run: any) {
  const handlers = new Map<string, (...args: any[]) => any>();
  register({ handle: (name: string, callback: any) => handlers.set(name, callback) }, { run, parseLsFilesZ, live: {} });
  return (cwd: string, file?: string, fresh?: boolean) => handlers.get('git:diff')!({}, cwd, file, fresh);
}

test('git diff IPC rejects tracked, untracked-list, and untracked-file read failures', async () => {
  for (const stage of ['tracked', 'listing', 'file']) {
    const read = reader(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return ok('/repo');
      if (
        (stage === 'tracked' && args[1] === 'HEAD') ||
        (stage === 'listing' && args[0] === 'ls-files') ||
        (stage === 'file' && args[1] === '--no-index')
      ) {
        return { ok: false, code: 128, stdout: '', stderr: 'permission denied' };
      }
      return ok(args[0] === 'ls-files' ? 'new.txt\0' : 'tracked patch');
    });
    await assert.rejects(read('/repo'), /permission denied/);
  }
});

test('git diff IPC uses literal selected paths and accepts no-index difference exit codes', async () => {
  const read = reader(async (_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return ok('/repo');
    if (args[0] === 'ls-files') return ok('file*.txt\0other.txt\0');
    if (args[1] === '--no-index') return { ok: false, code: 1, stdout: 'new patch', stderr: '' };
    assert.equal(args.at(-1), ':(literal)file*.txt');
    return ok('tracked patch\n');
  });
  assert.equal(await read('/repo', 'file*.txt'), 'tracked patch\nnew patch');
});

test('explicit fresh diff IPC bypasses an older pending snapshot', async () => {
  const releases: ((value: any) => void)[] = [];
  const read = reader(async (_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return ok('/repo');
    if (args[0] === 'ls-files') return ok();
    return new Promise((resolve) => releases.push(resolve));
  });
  const old = read('/repo');
  await new Promise((resolve) => setImmediate(resolve));
  const fresh = read('/repo', undefined, true);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 2);
    releases[0](ok('old snapshot'));
    releases[1](ok('new snapshot'));
    assert.deepEqual(await Promise.all([old, fresh]), ['old snapshot', 'new snapshot']);
  } finally {
    for (const release of releases) release(ok());
    await Promise.allSettled([old, fresh]);
  }
});

test('status IPC forwards explicit and omitted freshness to the shared query', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const requests: any[] = [];
  register(
    { handle: (name: string, callback: any) => handlers.set(name, callback) },
    {
      live: {},
      gitStatus: (cwd: string, fresh?: boolean) => {
        requests.push([cwd, fresh]);
        return { files: [] };
      },
    },
  );
  for (const fresh of [undefined, false, true]) await handlers.get('git:status')!({}, '/repo', fresh);
  assert.deepEqual(requests, [
    ['/repo', undefined],
    ['/repo', false],
    ['/repo', true],
  ]);
});
