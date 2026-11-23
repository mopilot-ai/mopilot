// Diff-panel UI unit cases for mutations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_SHA,
  store,
  calls,
  freshReads,
  gitRoots,
  ok,
  fail,
  DIFF,
  git,
  act,
  mount,
  label,
  menuItem,
  one,
  settle,
  typeInto,
} from './fixture.ts';
import { GIT_IDLE_POLL_MS } from '../../../src/lib/gitPoll.ts';

export function registerMutations() {
  test('the pane reads quietly on the shared timer, and not while the window is hidden', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const r = await mount({ scope: 'uncommitted' });
    freshReads.length = 0;
    // no turn runs: the idle interval (src/lib/gitPoll.ts)
    await act(async () => t.mock.timers.tick(GIT_IDLE_POLL_MS));
    await settle(act);
    assert.deepEqual(freshReads, [false]);
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      freshReads.length = 0;
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => window.dispatchEvent(new Event('focus')));
      await settle(act);
      assert.deepEqual(freshReads, [], 'a hidden window reads nothing');
    } finally {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else delete (document as any).visibilityState;
    }
    await r.unmount();
  });

  test('manual refresh, focus, and post-mutation reloads request fresh data', async () => {
    const r = await mount({ scope: 'uncommitted' });
    assert.deepEqual(freshReads, [false]);
    await act(async () => label(r.host, 'Refresh').click());
    await settle(act);
    assert.equal(freshReads.at(-1), true);
    freshReads.length = 0;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle(act);
    assert.deepEqual(freshReads, [true]);
    const section = r.host.querySelector('[data-path="src/a.ts"]')!;
    await act(async () => (section.querySelector('[aria-label="File actions"]') as HTMLElement).click());
    await act(async () => one(r.host, '[role="menuitem"][data-danger="true"]', 'Discard changes').click());
    await settle(act);
    assert.equal(freshReads.at(-1), true);
    await r.unmount();
  });

  test('files marked new restore when tracked, and discard failures are reported', async () => {
    for (const scenario of ['tracked-new', 'empty-error', 'rejected']) {
      const r = await mount({ scope: 'branch' });
      calls.length = 0;
      git.run = (args) => {
        if (args[1] === '--show-toplevel') return ok('/repo\n');
        if (scenario === 'rejected') throw new Error('discard unavailable');
        return scenario === 'empty-error' ? fail('') : ok();
      };
      const section = r.host.querySelector('[data-path="new.py"]')!;
      await act(async () => (section.querySelector('[aria-label="File actions"]') as HTMLElement).click());
      await act(async () => one(r.host, '[role="menuitem"][data-danger="true"]', 'Discard changes').click());
      await settle(act);
      if (scenario === 'tracked-new') {
        assert.ok(calls.some((call) => call[0] === 'git' && call[1] === 'restore'));
        assert.ok(!calls.some((call) => call[0] === 'git' && call[1] === 'clean'));
      } else {
        assert.deepEqual(store.calls.at(-1), [
          'toast',
          scenario === 'empty-error' ? 'Could not discard file changes' : 'discard unavailable',
          'error',
        ]);
      }
      await r.unmount();
      git.run = (args) => (args[0] === 'merge-base' ? ok(BASE_SHA) : args[0] === 'diff' ? ok(args.includes('--cached') ? '' : DIFF) : ok());
    }
  });

  test('discarding a patterned filename from a subfolder targets only its repository-relative path', async () => {
    git.diff = async () => '--- a/file[1]*.txt\n+++ b/file[1]*.txt\n@@ -1 +1 @@\n-old\n+new\n';
    git.run = (args) => ok(args[1] === '--show-toplevel' ? '/repo\n' : '');
    const r = await mount({ scope: 'uncommitted' }, null, {}, {}, '/repo/sub');
    const section = one(r.host, '.cp-file');
    await act(async () => (section.querySelector('[aria-label="File actions"]') as HTMLElement).click());
    await act(async () => one(r.host, '[role="menuitem"][data-danger="true"]', 'Discard changes').click());
    await settle(act);
    assert.deepEqual(gitRoots, ['/repo/sub', '/repo', '/repo', '/repo', '/repo']);
    assert.deepEqual(calls.filter((call) => call[0] === 'git').at(-1), [
      'git',
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      ':(literal)file[1]*.txt',
    ]);
    await r.unmount();
  });

  test('bulk discard stops before deleting untracked files if restoration fails', async () => {
    for (const message of ['restore failed\nmore details', '']) {
      const r = await mount({ scope: 'uncommitted' });
      calls.length = 0;
      git.run = (args) =>
        args[0] === 'rev-parse'
          ? ok(args[1] === '--show-toplevel' ? '/repo\n' : 'commit')
          : args[0] === 'ls-files'
            ? ok('tracked.txt\0')
            : fail(message);
      await act(async () => label(r.host, 'Changes options').click());
      await act(async () => menuItem(r.host, 'Discard all changes').click());
      await settle(act);
      assert.equal(
        calls.some((call) => call[0] === 'git' && call[1] === 'clean'),
        false,
      );
      assert.deepEqual(store.calls.at(-1), ['toast', message ? 'restore failed' : 'Could not discard tracked changes', 'error']);
      await r.unmount();
      git.run = () => ok();
    }
  });

  test('bulk discard reports cleanup failures and rejected commands, then refreshes', async () => {
    for (const scenario of ['clean-message', 'clean-empty', 'clean-leading-newline', 'rejected']) {
      const r = await mount({ scope: 'uncommitted' });
      calls.length = 0;
      git.run = (args) => {
        if (scenario === 'rejected') throw new Error('IPC unavailable');
        if (args[1] === '--show-toplevel') return ok('/repo\n');
        return args[0] === 'clean'
          ? fail(scenario === 'clean-message' ? 'cleanup failed\ndetails' : scenario === 'clean-leading-newline' ? '\ndetails' : '')
          : ok();
      };
      await act(async () => label(r.host, 'Changes options').click());
      await act(async () => menuItem(r.host, 'Discard all changes').click());
      await settle(act);
      assert.deepEqual(store.calls.at(-1), [
        'toast',
        scenario === 'rejected'
          ? 'IPC unavailable'
          : scenario === 'clean-message'
            ? 'cleanup failed'
            : scenario === 'clean-leading-newline'
              ? 'Could not discard changes'
              : 'Could not remove untracked files',
        'error',
      ]);
      assert.equal(calls.filter((call) => call[0] === 'diff').length, 1);
      await r.unmount();
      git.run = () => ok();
    }
  });

  test('repeated Enter presses cannot start concurrent commits', async () => {
    const r = await mount({ scope: 'uncommitted' });
    let release!: (value: any) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    git.run = (args) => (args[0] === 'add' ? pending : ok());
    const input = one(r.host, '.cp-commit input') as HTMLInputElement;
    await act(async () => typeInto(input, 'Commit once'));
    try {
      await act(async () => {
        for (let i = 0; i < 2; i++) input.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      assert.equal(calls.filter((call) => call[0] === 'git' && call[1] === 'add').length, 1);
      assert.equal((one(r.host, '.cp-commit button') as HTMLButtonElement).disabled, true);
      // read-only, not disabled: the field keeps the keyboard while the commit runs (#1658)
      assert.equal(input.readOnly, true);
    } finally {
      await act(async () => release(ok()));
      await settle(act);
      await r.unmount();
    }
    assert.equal(calls.filter((call) => call[0] === 'git' && call[1] === 'commit').length, 1);
  });

  test('rejected staging and commit commands keep the message and allow retry', async () => {
    for (const command of ['add', 'commit']) {
      const r = await mount({ scope: 'uncommitted' });
      const input = one(r.host, '.cp-commit input') as HTMLInputElement;
      const button = one(r.host, '.cp-commit button') as HTMLButtonElement;
      await act(async () => typeInto(input, 'Keep this message'));
      git.run = async (args) => {
        // as the renderer gets an error main threw: the toast says what failed, not which IPC channel carried it
        if (args[0] === command) throw new Error(`Error invoking remote method 'git:run': Error: ${command} unavailable`);
        return ok();
      };
      await act(async () => button.click());
      assert.deepEqual(store.calls.at(-1), ['toast', `${command} unavailable`, 'error']);
      assert.equal(input.value, 'Keep this message');
      assert.equal(input.readOnly, false);
      assert.equal(button.disabled, false);
      git.run = () => ok();
      await act(async () => button.click());
      await settle(act);
      assert.deepEqual(store.calls.at(-1), ['toast', 'Committed changes', 'success']);
      assert.equal(input.value, '');
      await r.unmount();
    }
  });
}
