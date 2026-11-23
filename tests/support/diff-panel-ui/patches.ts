// Diff-panel UI unit cases for patches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, DIFF, git, act, mount, sections, label, menuItem, one, settle } from './fixture.ts';

export function registerPatches() {
  test('failed git reads display an error and focus refresh recovers', async () => {
    git.diff = async () => {
      throw new Error('read failed');
    };
    const r = await mount({ scope: 'uncommitted' });
    assert.match(one(r.host, '[role="alert"]').textContent!, /read failed/);
    git.diff = async () => DIFF;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle(act);
    assert.equal(r.host.querySelector('[role="alert"]'), null);
    assert.deepEqual(sections(r.host), ['src/a.ts', 'new.py', 'gone.md']);
    await r.unmount();
  });

  test('copy diff preserves old paths and quotes special filenames', async () => {
    git.diff = async () => String.raw`diff --git "a/old name.txt" "b/new\tname.txt"
--- "a/old name.txt"
+++ "b/new\tname.txt"
@@ -1 +1 @@
-old
+new`;
    const r = await mount({ scope: 'uncommitted' });
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Copy diff').click());
    const patch = calls.find((call) => call[0] === 'copy')![1] as string;
    assert.ok(patch.includes(String.raw`--- "a/old name.txt"` + '\n' + String.raw`+++ "b/new\011name.txt"` + '\n'));
    assert.match(patch, /rename from "old name.txt"/);
    await r.unmount();
  });

  test('copy diff preserves paths for a bare patch without a Git-style header', async () => {
    git.diff = async () => '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n';
    const r = await mount({ scope: 'uncommitted' });
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Copy diff').click());
    assert.ok((calls.find((call) => call[0] === 'copy')![1] as string).startsWith('--- a/file.txt\n+++ b/file.txt\n'));
    await r.unmount();
  });

  test('copy diff preserves missing-newline markers on both sides of an edit', async () => {
    const diff = '--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
    git.diff = async () => diff;
    const r = await mount({ scope: 'uncommitted' });
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Copy diff').click());
    assert.equal(calls.find((call) => call[0] === 'copy')![1], diff);
    await r.unmount();
  });

  test('copying raw file additions and deletions emits hunk headers', async () => {
    const rawTurn = {
      id: 'raw',
      status: 'completed',
      items: [
        {
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: 'created.txt', kind: { type: 'add' }, diff: 'one\ntwo\n' },
            { path: 'deleted.txt', kind: { type: 'delete' }, diff: 'gone' },
          ],
        },
      ],
    };
    const r = await mount({ turnId: 'raw' }, 't1', { t1: { turns: [rawTurn] } });
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Copy diff').click());
    const patch = calls.find((call) => call[0] === 'copy')![1] as string;
    assert.match(patch, /@@ -0,0 \+1,2 @@\n\+one\n\+two/);
    assert.match(patch, /@@ -1,1 \+0,0 @@\n-gone\n\\ No newline at end of file/);
    await r.unmount();
  });

  test('copy diff keeps permission-only changes rather than an empty text patch', async () => {
    const diff = 'diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n';
    git.diff = async () => diff;
    const r = await mount({ scope: 'uncommitted' });
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Copy diff').click());
    assert.equal(calls.find((call) => call[0] === 'copy')![1], diff);
    await r.unmount();
  });
}
