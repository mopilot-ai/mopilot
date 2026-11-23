// sync_with_base_branch (electron/capabilities/tools/worktreeTools.cjs) when git fails without saying why: the failures
// are still named, with or without a recorded branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerWorktreeTools } = require('../electron/capabilities/tools/worktreeTools.cjs');

/** Git that fails `fail` with no stderr (only `rev-parse` says no, so no merge looks in progress), else succeeds. */
function sync(fail: string | null, args: object) {
  const r = new Registry();
  r.setApprover(async () => true);
  registerWorktreeTools(r, {
    owner: () => 'c',
    storage: {} as any,
    sessionFolders: { resolve: async () => ({ path: '/w', isDirectory: true }) },
    ask: async () => null,
    git: async (a: string[]) => ({
      ok: a[0] !== 'rev-parse' && a[0] !== fail,
      stdout: a[0] === fail ? 'merge said this' : a[0] === 'symbolic-ref' ? 'feature\n' : '',
      stderr: '',
    }),
    worktreeInfo: () => ({ path: '/w', repo: '/w', branch: null, sourceBranch: 'main' }),
    now: () => 0,
  });
  return r
    .invoke('c', 'seg', 'sync_with_base_branch', args)
    .then((res: any) => (res.ok ? res.content[0].text : `ERROR ${res.error.code}: ${res.error.message}`));
}

test('a fetch or merge that fails silently is still named, and so is an abort with nothing to abort', async () => {
  assert.match(await sync('fetch', {}), /^ERROR fetch_failed: Could not fetch origin\/main \(git failed\)/);
  assert.match(await sync('merge', {}), /^ERROR merge_failed: The merge of origin\/main failed: merge said this/);
  assert.match(await sync('merge', { abort: true }), /^ERROR nothing_to_abort: There was no merge to abort here \(git refused\)/);
  assert.equal(await sync(null, { abort: true }), 'Aborted the merge; the branch is as it was before.');
});
