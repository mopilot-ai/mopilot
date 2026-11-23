// Shortcut async completion tests cover independent reads and retirement of delayed native actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { SHORTCUT_ACTIONS } from '../../shared/shortcuts.mjs';
export function registerShortcutAsyncCases(fx: any) {
  const {
    reset,
    mount,
    cmd,
    set,
    calls,
    unmount,
    getState,
    onCommand,
    envReads,
    envRoots,
    setWinOpenResult,
    setFolderResult,
    setProjectResult,
  } = fx;
  test('environment reads use canonical project roots and retire both success and rejection after navigation or unmount', async () => {
    reset({
      route: { name: 'thread', id: 'a' },
      threads: { a: { cwd: '/repo/subdir', projectId: 'p' } },
      savedProjects: [{ id: 'p', roots: [{ path: '/repo' }] }],
    });
    await mount();
    let first: any;
    await act(async () => {
      first = onCommand('shortcut', 'environment-action');
    });
    const read = envReads.requests.at(-1)!;
    assert.equal(envRoots.at(-1), '/repo');
    await set({ route: { name: 'thread', id: 'b' } });
    await act(async () => {
      read.reject(new Error('old'));
      await first;
    });
    assert.equal(
      calls.some((c) => c[0] === 'error'),
      false,
    );
    await set({ route: { name: 'thread', id: 'a' } });
    let second: any;
    await act(async () => {
      second = onCommand('shortcut', 'environment-action');
    });
    await act(async () => {
      envReads.requests.at(-1)!.resolve({ actions: [{ name: 'Run', command: 'echo ok' }] });
      await second;
    });
    assert.deepEqual(calls.filter((c) => c[0] === 'openPaneTab').at(-1), [
      'openPaneTab',
      'terminal',
      { cwd: '/repo/subdir', title: 'Run', command: ['/bin/zsh', '-lc', 'echo ok'] },
    ]);
    let third: any;
    await act(async () => {
      third = onCommand('shortcut', 'environment-action');
    });
    await unmount();
    envReads.requests.at(-1)!.resolve({ actions: [{ name: 'Old', command: 'exit' }] });
    await third;
    assert.equal(calls.filter((c) => c[0] === 'openPaneTab').length, 1);
  });

  test('environment reads reject current failures, ignore changed project ownership and preserve independent actions in both completion orders', async () => {
    reset({
      route: { name: 'thread', id: 'a' },
      threads: { a: { cwd: '/repo', projectId: 'p' } },
      savedProjects: [{ id: 'p', roots: [{ path: '/repo' }] }],
    });
    await mount();
    const start = async () => {
      let promise: any;
      await act(async () => {
        promise = onCommand('shortcut', 'environment-action');
      });
      return { promise, read: envReads.requests.at(-1)! };
    };
    const first = await start(),
      second = await start();
    await act(async () => {
      second.read.resolve({ actions: [{ name: 'Second', command: 'two' }] });
      await second.promise;
      first.read.resolve({ actions: [{ name: 'First', command: 'one' }] });
      await first.promise;
    });
    assert.equal(calls.filter((c: any[]) => c[0] === 'openPaneTab').length, 2);
    // main's resolver always answers with a list of actions (none, or none with a command, runs nothing)
    for (const env of [{ actions: [] }, { actions: [{ name: 'Empty', command: '' }] }]) {
      const run = await start();
      await act(async () => {
        run.read.resolve(env);
        await run.promise;
      });
    }
    const failed = await start();
    await act(async () => {
      failed.read.reject(new Error('current'));
      await failed.promise;
    });
    assert.equal(calls.filter((c: any[]) => c[0] === 'error').length, 1);
    const changed = await start();
    await set({ savedProjects: [{ id: 'p', roots: [{ path: '/other' }] }] });
    await act(async () => {
      changed.read.resolve({ actions: [{ name: 'Old', command: 'old' }] });
      await changed.promise;
    });
    const fallback = await start();
    await set({ threads: { a: { cwd: '/repo' } } });
    await act(async () => {
      fallback.read.resolve({ actions: [{ name: 'Old', command: 'old' }] });
      await fallback.promise;
    });
    await set({ savedProjects: [], route: { name: 'thread', id: 'a' } });
    const retry = await start();
    await act(async () => {
      retry.read.resolve({ actions: [{ name: 'Retry', command: 'ok' }] });
      await retry.promise;
    });
    assert.equal(calls.filter((c: any[]) => c[0] === 'openPaneTab').length, 3);
    await set({ route: { name: 'home' } });
    await cmd('shortcut', 'environment-action');
    await unmount();
  });

  test('catalog guard detects an unimplemented action and native failures have the current owner destination', async () => {
    reset({ route: { name: 'thread', id: 'a' } });
    await mount();
    const unknown = { ...SHORTCUT_ACTIONS[0], id: 'unimplemented' };
    SHORTCUT_ACTIONS.push(unknown);
    try {
      await cmd('shortcut', 'unimplemented');
      assert.match(String(calls.find((c: any[]) => c[0] === 'error')?.[2]), /Unknown shortcut action/);
    } finally {
      SHORTCUT_ACTIONS.pop();
    }
    let reject!: (error: Error) => void;
    const pending = new Promise((_, fail) => {
      reject = fail;
    });
    setWinOpenResult(pending);
    let command: any;
    await act(async () => {
      command = onCommand('shortcut', 'new-window');
    });
    await set({ route: { name: 'thread', id: 'b' } });
    await act(async () => {
      reject(new Error('retired'));
      await command;
    });
    assert.equal(calls.filter((c: any[]) => c[0] === 'error').length, 1);
    setWinOpenResult(undefined);
    await unmount();
  });
  test('delayed folder and focus commands retire on navigation and disposal without stealing focus', async () => {
    reset();
    await mount();
    let picked!: (path: string) => void;
    setFolderResult(
      new Promise((resolve) => {
        picked = resolve;
      }),
    );
    let command: any;
    await act(async () => {
      command = onCommand('open-folder');
    });
    await set({ route: { name: 'thread', id: 'b' } });
    await act(async () => {
      picked('/old');
      await command;
    });
    assert.equal(
      calls.some((c: any[]) => c[0] === 'createProject'),
      false,
    );
    setFolderResult(Promise.resolve('/new'));
    let created!: (id: string) => void;
    setProjectResult(
      new Promise((resolve) => {
        created = resolve;
      }),
    );
    await act(async () => {
      command = onCommand('open-folder');
    });
    await unmount();
    created('p');
    await command;
    assert.equal(getState().newChatProjectId, undefined);
    setFolderResult(undefined);
    setProjectResult(undefined);
  });
  test('closing or retargeting a side composer retires its pending action and failure without changing the main route', async () => {
    for (const retire of ['close', 'retarget', 'keep'])
      for (const fails of [false, true]) {
        reset({ route: { name: 'thread', id: 'a' }, threads: { a: {}, side: { cwd: '/side' } } });
        await mount();
        const composer = document.createElement('div');
        composer.dataset.composerChat = 'side';
        composer.innerHTML = '<input />';
        document.body.append(composer);
        composer.querySelector('input')!.focus();
        let promise: any;
        await act(async () => {
          promise = onCommand('shortcut', 'environment-action');
        });
        if (retire === 'close') composer.remove();
        else if (retire === 'retarget') composer.dataset.composerChat = 'replacement';
        await act(async () => {
          const read = envReads.requests.at(-1)!;
          if (fails) read.reject(new Error('retired side'));
          else read.resolve({ actions: [{ name: 'Old', command: 'old' }] });
          await promise;
        });
        assert.equal(
          calls.some((c: any[]) => c[0] === (fails ? 'error' : 'openPaneTab')),
          retire === 'keep',
        );
        composer.remove();
        await unmount();
      }
    reset({ route: { name: 'thread', id: 'a' } });
    await mount();
    const composer = document.createElement('div');
    composer.dataset.composerChat = '';
    composer.innerHTML = '<input />';
    document.body.append(composer);
    composer.querySelector('input')!.focus();
    const unknown = { ...SHORTCUT_ACTIONS[0], id: 'empty-owner-unimplemented' };
    SHORTCUT_ACTIONS.push(unknown);
    try {
      await cmd('shortcut', unknown.id);
      assert.equal(
        calls.some((c: any[]) => c[0] === 'error'),
        true,
      );
    } finally {
      SHORTCUT_ACTIONS.pop();
    }
    await cmd('shortcut', 'new-chat');
    composer.remove();
    await unmount();
  });
}
