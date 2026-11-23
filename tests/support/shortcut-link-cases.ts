// New chat commands for macOS Quick Actions, extension drafts and temporary chats, registered against the real App fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';

export function registerNewChatLinkCases(fx: any) {
  const { reset, mount, cmd, calls, unmount, getState, setProjectResult } = fx;
  const drafted = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));

  test('temporary chats and the Chrome extension draft command start without restoring Run on', async () => {
    reset({ newChatHost: { remembered: true } });
    await mount();
    try {
      await cmd('new-temp-chat');
      await cmd('new-chat-draft');
      assert.deepEqual(
        calls.filter(([name]: unknown[]) => name === 'clearProject'),
        [['clearProject'], ['clearProject', false]],
      );
    } finally {
      await unmount();
    }
  });

  test('a link opens a new chat outside any project with its text drafted, never sent', async () => {
    reset({ route: { name: 'thread', id: 'a' }, newChatTemporary: true });
    await mount();
    try {
      await cmd('new-chat-link', { folder: null, text: 'from a link' });
      await drafted();
      assert.deepEqual([getState().newChatTemporary, getState().route], [false, { name: 'home' }]);
      assert.equal(calls.filter((c: unknown[]) => c[0] === 'clearProject').length, 1);
      assert.deepEqual(calls.at(-1), ['giveBack', null, 'from a link']);
    } finally {
      await unmount();
    }
  });

  test('a link with a folder starts the new chat in its project; anything else is ignored', async () => {
    reset({ route: { name: 'thread', id: 'a' } });
    await mount();
    try {
      await cmd('new-chat-link', { folder: '/linked', text: '' });
      assert.deepEqual([getState().newChatProjectId, getState().route], ['p1', { name: 'home', cwd: '/linked' }]);
      assert.deepEqual(
        calls.filter((c: unknown[]) => c[0] === 'giveBack'),
        [],
      );
      // the user went elsewhere while the project was made: the chat does not open under them
      setProjectResult(
        new Promise<string>((r) =>
          setTimeout(() => {
            getState().route = { name: 'settings' };
            r('p2');
          }, 5),
        ),
      );
      await cmd('new-chat-link', { folder: '/slow', text: 'x' });
      setProjectResult(undefined);
      // a project that can't be made is told, not an unhandled failure
      setProjectResult(Promise.reject(new Error('no folder')));
      await cmd('new-chat-link', { folder: '/broken', text: '' });
      assert.deepEqual(calls.at(-1), ['error', 'Could not open the link', new Error('no folder')]);
      setProjectResult(undefined);
      await cmd('new-chat-link', 'garbage');
      assert.equal(
        calls.some((c: unknown[]) => c[0] === 'giveBack'),
        false,
      );
    } finally {
      await unmount();
    }
  });
}
