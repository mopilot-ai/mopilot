// electron/platform/git.cjs refreshBranch with a fake `git` (execFile): worktrees made side by side (Start all on
// several suggested sessions) share one fetch of their base branch, and a failed fetch is not remembered.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');

let fetchOk = false;
const fetches: string[][] = [];
mock.method(childProcess, 'execFile', (_cmd: string, args: string[], _opts: any, cb: any) => {
  let r: { ok?: boolean; stdout?: string } = { ok: true };
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') r = { stdout: '/src/app\n' };
  else if (args[0] === 'rev-parse' && args[1] === '--show-prefix') r = { stdout: '\n' };
  else if (args[0] === 'symbolic-ref') r = { stdout: 'origin/main\n' };
  else if (args[0] === 'fetch') fetches.push(args), (r = { ok: fetchOk });
  else if (args[0] === 'rev-parse' && args[1] === '--verify') r = { ok: !args[3].startsWith('refs/heads/') };
  else if (args[0] === 'merge-base') r = { stdout: 'b4se\n' };
  setImmediate(() => cb(r.ok === false ? new Error('git failed') : null, r.stdout, ''));
});

test('worktrees made side by side share one fetch of their branch; a failed one is tried again next time', async (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitshared-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const add = (roots: string[]) => Promise.all(roots.map((root) => git.worktreeAdd('/src/app', { root: path.join(d, root) })));
  const made = await add(['a', 'b', 'c']);
  assert.deepEqual(
    made.map((r: any) => r.ok),
    [true, true, true],
  );
  assert.equal(new Set(made.map((r: any) => r.branch)).size, 3, 'each its own branch');
  assert.deepEqual(fetches, [['fetch', '--quiet', '--no-write-fetch-head', 'origin', '+refs/heads/main:refs/remotes/origin/main']]);
  fetchOk = true;
  await add(['d', 'e']);
  assert.equal(fetches.length, 2, 'the failed fetch is not remembered: the next pair fetches once more');
  await add(['f']);
  assert.equal(fetches.length, 2, 'a fresh fetch is reused');
});
