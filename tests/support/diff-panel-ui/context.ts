// Diff-panel UI unit cases for context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  store,
  calls,
  gitRoots,
  ok,
  fail,
  git,
  native,
  h,
  act,
  DiffPanel,
  mount,
  label,
  menuItem,
  one,
  settle,
  typeInto,
} from './fixture.ts';

export function registerContext() {
  test('late commit results cannot clear the draft or show feedback in another pane context', async () => {
    for (const change of ['repository', 'scope', 'returned', 'unmount']) {
      for (const outcome of ['success', 'failure', 'rejected']) {
        const r = await mount({ scope: 'uncommitted' });
        let release!: (value: any) => void;
        let reject!: (error: Error) => void;
        const pending = new Promise((resolve, fail) => {
          release = resolve;
          reject = fail;
        });
        const originalRun = git.run;
        git.run = (args) => (args[0] === 'commit' ? pending : originalRun(args));
        try {
          await act(async () => typeInto(one(r.host, '.cp-commit input') as HTMLInputElement, 'Preserve draft'));
          await act(async () => one(r.host, '.cp-commit button').click());
          assert.ok(calls.some((c) => c[0] === 'git' && c[1] === 'commit'));
          if (change === 'unmount') await r.unmount();
          else if (change === 'scope') {
            await act(async () => one(r.host, '.cp-scope').click());
            await act(async () => menuItem(r.host, 'Branch changes').click());
          } else {
            await r.rerender(h(DiffPanel, { cwd: '/other', threadId: 't2' }));
            await settle(act);
            if (change === 'returned') await r.rerender(h(DiffPanel, { cwd: '/repo', threadId: 't1' }));
          }
          await settle(act);
          store.calls.length = 0;
          calls.length = 0;
          await act(async () =>
            outcome === 'rejected' ? reject(new Error('late failure')) : release(outcome === 'success' ? ok() : fail('late failure')),
          );
          await settle(act);
          assert.deepEqual(store.calls, [], 'obsolete completion must not show feedback');
          assert.ok(!calls.some((c) => c[0] === 'diff'));
          if (change !== 'unmount') {
            if (change === 'scope') {
              await act(async () => one(r.host, '.cp-scope').click());
              await act(async () => menuItem(r.host, 'Uncommitted changes').click());
              await settle(act);
            }
            const input = one(r.host, '.cp-commit input') as HTMLInputElement;
            assert.equal(input.value, change === 'repository' ? '' : 'Preserve draft');
            assert.equal(input.readOnly, false, 'the completed command releases the pending guard');
          }
        } finally {
          release(ok());
          if (change !== 'unmount') await r.unmount();
          git.run = originalRun;
        }
      }
    }
  });

  test('discard failures belong to their original pane context after navigation or closing', async () => {
    for (const action of ['file', 'all']) {
      for (const change of ['repository', 'scope', 'returned', 'unmount']) {
        for (const outcome of ['failure', 'rejected']) {
          const r = await mount({ scope: 'uncommitted' });
          let release!: (value: any) => void;
          let reject!: (error: Error) => void;
          const pending = new Promise((resolve, fail) => {
            release = resolve;
            reject = fail;
          });
          const originalRun = git.run;
          git.run = (args) =>
            args[0] === 'restore' ? pending : args[0] === 'ls-files' && args.includes('-z') ? ok('src/a.ts\0') : originalRun(args);
          try {
            if (action === 'file') {
              const section = r.host.querySelector('[data-path="src/a.ts"]')!;
              await act(async () => (section.querySelector('[aria-label="File actions"]') as HTMLElement).click());
              await act(async () => menuItem(r.host, 'Discard changes').click());
            } else {
              await act(async () => label(r.host, 'Changes options').click());
              await act(async () => menuItem(r.host, 'Discard all changes').click());
            }
            assert.ok(calls.some((c) => c[0] === 'git' && c[1] === 'restore'));
            if (change === 'unmount') await r.unmount();
            else if (change === 'scope') {
              await act(async () => one(r.host, '.cp-scope').click());
              await act(async () => menuItem(r.host, 'Branch changes').click());
            } else {
              await r.rerender(h(DiffPanel, { cwd: '/other', threadId: 't2' }));
              await settle(act);
              if (change === 'returned') await r.rerender(h(DiffPanel, { cwd: '/repo', threadId: 't1' }));
            }
            await settle(act);
            store.calls.length = 0;
            calls.length = 0;
            await act(async () =>
              outcome === 'rejected' ? reject(new Error('old discard refused')) : release(fail('old discard refused')),
            );
            await settle(act);
            assert.deepEqual(store.calls, [], 'obsolete discard failure must not show feedback');
            assert.ok(!calls.some((c) => c[0] === 'diff'));
            assert.ok(!calls.some((c) => c[0] === 'git' && c[1] === 'clean'), 'refused restoration must not proceed to cleanup');
          } finally {
            release(ok());
            if (change !== 'unmount') await r.unmount();
            git.run = originalRun;
          }
        }
      }
    }
  });

  test('commit drafts stay with their repository root across folders and chats', async () => {
    native.git.info = async (cwd) => ({ root: cwd.startsWith('/repo/') ? '/repo' : cwd });
    const r = await mount({ scope: 'uncommitted' }, 't1', {}, {}, '/repo/first');
    const input = () => one(r.host, '.cp-commit input') as HTMLInputElement;
    const move = async (cwd: string, threadId: string) => {
      await r.rerender(h(DiffPanel, { cwd, threadId }));
      await settle(act);
    };
    try {
      await act(async () => typeInto(input(), 'Repository A draft'));
      await move('/other', 't2');
      assert.equal(input().value, '', 'a new repository must not inherit another commit message');
      assert.equal((one(r.host, '.cp-commit button') as HTMLButtonElement).disabled, true);
      await act(async () => typeInto(input(), 'Repository B draft'));
      await move('/repo/second', 't3');
      assert.equal(input().value, 'Repository A draft', 'folders in the same repository share their draft');
      await act(async () => one(r.host, '.cp-commit button').click());
      await settle(act);
      assert.equal(input().value, '', 'a successful commit clears its repository draft');
      assert.ok(calls.some((c) => c[0] === 'git' && c[1] === 'commit' && c[3] === 'Repository A draft'));
      assert.equal(gitRoots.at(-1), '/repo');
      await move('/other', 't2');
      assert.equal(input().value, 'Repository B draft', 'committing another repository leaves this draft intact');
      await move('/repo/first', 't1');
      assert.equal(input().value, '');
    } finally {
      await r.unmount();
    }
  });
}
