// Diff-panel UI unit cases for repositories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  store,
  calls,
  ok,
  DIFF,
  git,
  native,
  h,
  act,
  DiffPanel,
  mount,
  sections,
  label,
  menuItem,
  turn,
  one,
  byText,
  settle,
  render,
  typeInto,
} from './fixture.ts';

export function registerRepositories() {
  test('repository diffs opened from a subfolder use the root for file actions and inline patches', async () => {
    native.git.info = async () => ({ root: '/repo' });
    const commandCwds: string[] = [];
    const originalRun = native.git.run;
    native.git.run = async (cwd, args) => {
      commandCwds.push(cwd);
      return originalRun(cwd, args);
    };
    store.set({ diffPanel: { scope: 'uncommitted' }, runtime: {} });
    const r = await render(h(DiffPanel, { cwd: '/repo/sub', threadId: 't1' }));
    await settle(act);
    try {
      assert.ok(calls.some((call) => call[0] === 'diff' && call[1] === '/repo'));
      const section = r.host.querySelector('[data-path="src/a.ts"]')!;
      await act(async () => (section.querySelector('[aria-label="Open in default app"]') as HTMLElement).click());
      assert.deepEqual(calls.at(-1), ['openPath', '/repo/src/a.ts']);
      assert.equal(section.querySelector('[data-inline]')!.getAttribute('data-cwd'), '/repo');
      await act(async () => (section.querySelector('[aria-label="File actions"]') as HTMLElement).click());
      await act(async () => one(r.host, '[role="menuitem"][data-danger="true"]', 'Discard changes').click());
      assert.deepEqual(commandCwds, Array(5).fill('/repo'));
      await act(async () => typeInto(one(r.host, '.cp-commit input') as HTMLInputElement, 'Fix nested project'));
      await act(async () => one(r.host, '.cp-commit button').click());
      await settle(act);
      // the commit of every change checks for conflicts first (git ls-files -u): one more git run
      assert.deepEqual(commandCwds, Array(8).fill('/repo'));
      await act(async () => label(r.host, 'Changes options').click());
      await act(async () => menuItem(r.host, 'Discard all changes').click());
      assert.deepEqual(commandCwds, Array(13).fill('/repo'));
    } finally {
      await r.unmount();
      native.git.run = originalRun;
    }
  });

  test('last-turn file paths stay relative to the chat folder without querying a repository', async () => {
    native.git.info = async () => assert.fail('turn diffs do not need a repository root');
    // another app chosen in Settings names itself on the button
    store.set({ diffPanel: { turnId: 'turn1' }, runtime: { t1: { turns: [turn(DIFF)] } }, prefs: { openDestination: 'cursor' } });
    const r = await render(h(DiffPanel, { cwd: '/repo/sub', threadId: 't1' }));
    await settle(act);
    try {
      const section = r.host.querySelector('[data-path="src/a.ts"]')!;
      await act(async () => (section.querySelector('[aria-label="Open in Cursor"]') as HTMLElement).click());
      assert.deepEqual(calls.at(-1), ['openPath', '/repo/sub/src/a.ts']);
      assert.equal(section.querySelector('[data-inline]')!.getAttribute('data-cwd'), '/repo/sub');
    } finally {
      await r.unmount();
    }
  });

  test('a folder outside any repository says so calmly and does not read diffs', async () => {
    for (const info of [null, { root: '' }]) {
      calls.length = 0;
      native.git.info = async () => info;
      const r = await mount({ scope: 'uncommitted' });
      assert.equal(one(r.host, '.empty-state').textContent, 'This folder is not a git repository');
      assert.equal(r.host.querySelector('[role="alert"]'), null);
      assert.deepEqual(calls, []);
      await act(async () => label(r.host, 'Changes options').click());
      assert.equal(byText(r.host, '[role="menuitem"]', 'Discard all changes').length, 0);
      await r.unmount();
    }
  });

  test('a discard finishing after a repository or scope switch cannot replace the new diff', async () => {
    for (const change of ['repository', 'scope', 'returned']) {
      native.git.info = async (cwd) => ({ root: cwd });
      git.diff = async (cwd) => (cwd === '/other' ? DIFF.replaceAll('src/a.ts', 'other.ts') : DIFF);
      const r = await mount({ scope: 'uncommitted' });
      let release!: (value: any) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const originalRun = git.run;
      git.run = (args) =>
        args[0] === 'restore'
          ? pending
          : args[0] === 'diff' && !args.includes('--cached')
            ? ok(DIFF.replaceAll('src/a.ts', 'branch.ts'))
            : originalRun(args);
      try {
        const section = r.host.querySelector('[data-path="src/a.ts"]')!;
        await act(async () => (section.querySelector('[aria-label="File actions"]') as HTMLElement).click());
        await act(async () => menuItem(r.host, 'Discard changes').click());
        assert.ok(calls.some((call) => call[0] === 'git' && call[1] === 'restore'));
        if (change === 'repository') await r.rerender(h(DiffPanel, { cwd: '/other', threadId: 't2' }));
        else if (change === 'returned') {
          await r.rerender(h(DiffPanel, { cwd: '/other', threadId: 't2' }));
          await settle(act);
          git.diff = async () => DIFF.replaceAll('src/a.ts', 'returned.ts');
          await r.rerender(h(DiffPanel, { cwd: '/repo', threadId: 't1' }));
        } else {
          await act(async () => one(r.host, '.cp-scope').click());
          await act(async () => menuItem(r.host, 'Branch changes').click());
        }
        await settle(act);
        const expected = change === 'repository' ? 'other.ts' : change === 'returned' ? 'returned.ts' : 'branch.ts';
        assert.equal(sections(r.host)[0], expected);
        calls.length = 0;
        await act(async () => release(ok()));
        await settle(act);
        assert.equal(sections(r.host)[0], expected);
        assert.ok(!calls.some((call) => call[0] === 'diff'), 'a completed action must not refresh its old context');
      } finally {
        release(ok());
        await r.unmount();
        git.run = originalRun;
      }
    }
  });

  for (const change of ['refresh', 'repository', 'unmount']) {
    test(`a pending root lookup is ignored after ${change}`, async (t) => {
      let release!: (value: any) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      let roots = 0;
      native.git.info = async (cwd) => (++roots === 1 ? pending : { root: cwd });
      const r = await mount({ scope: 'uncommitted' });
      t.after(() => r.unmount());
      assert.equal(calls.length, 0, 'no diff is read before its root resolves');
      assert.ok(!r.host.querySelector('.cp-file'));
      if (change === 'refresh') await act(async () => label(r.host, 'Refresh').click());
      else if (change === 'repository') await r.rerender(h(DiffPanel, { cwd: '/other', threadId: 't2' }));
      else await r.unmount();
      await settle(act);
      calls.length = 0;
      await act(async () => release({ root: '/obsolete-root' }));
      await settle(act);
      assert.equal(calls.length, 0, 'the obsolete root cannot start another diff read');
    });
  }

  test('a late root failure after unmount does not start reads or show feedback', async () => {
    let reject!: (error: Error) => void;
    native.git.info = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    const r = await mount({ scope: 'uncommitted' });
    await r.unmount();
    await act(async () => reject(new Error('root lookup unavailable')));
    await settle(act);
    assert.deepEqual(calls, []);
    assert.deepEqual(store.calls, []);
  });

  test('a discard finishing after the pane unmounts does not start another root lookup', async () => {
    let roots = 0;
    native.git.info = async (cwd) => {
      roots++;
      return { root: cwd };
    };
    let release!: (value: any) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const r = await mount({ scope: 'uncommitted' });
    const originalRun = git.run;
    git.run = (args) => (args[0] === 'restore' ? pending : originalRun(args));
    const section = one(r.host, '.cp-file');
    await act(async () => (section.querySelector('[aria-label="File actions"]') as HTMLElement).click());
    await act(async () => menuItem(r.host, 'Discard changes').click());
    await r.unmount();
    const before = roots;
    await act(async () => release(ok()));
    await settle(act);
    assert.equal(roots, before);
  });
}
