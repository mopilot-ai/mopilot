// File mentions subscribe to their effective home-project owner, including changes without a parent render.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { fakeStore, render, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
const store = fakeStore({ threads: {}, threadOrder: [], claudeArchived: {}, cwd: '/first' });
const requests: { cwd: string; resolve: (value: any) => void; reject: (error: unknown) => void }[] = [];
stubStore({
  useStore: store.useStore,
  currentCwdForNewChat: () => store.getState().cwd,
  threadTitle: () => '',
  searchThreads: async () => ({}),
  navigate: () => {},
  toastFailure: () => () => {},
});
installNativeStub({
  search: {
    files: (cwd: string) => new Promise((resolve, reject) => requests.push({ cwd, resolve, reject })),
  },
});
mock.module('../src/components/ui/Popover.tsx', { exports: { Popover: ({ children }: any) => children } });
mock.module('../src/components/composer/BrowserTabMentions.tsx', {
  exports: { useBrowserTabMentions: () => [], BrowserTabRows: () => null },
});
const { MentionPopup } = await import('../src/components/composer/ComposerPopups.tsx');
const wait = () => act(async () => new Promise((resolve) => setTimeout(resolve, 90)));

for (const rejected of [false, true]) {
  test(`home project change replaces mention search without parent render (old rejected=${rejected})`, async () => {
    requests.length = 0;
    store.reset({ threads: {}, threadOrder: [], claudeArchived: {}, cwd: '/first' });
    const picked: string[] = [];
    const anchor = document.createElement('div');
    const { host, unmount } = await render(
      createElement(MentionPopup, {
        anchor,
        threadId: null,
        query: 'file',
        index: 0,
        setIndex: () => {},
        onPick: (path: string) => picked.push(path),
        onPickChat: () => {},
        onPickTab: () => {},
        onClose: () => {},
      }),
    );
    try {
      await wait();
      assert.equal(requests[0].cwd, '/first');
      await act(async () => store.setState({ cwd: '/second' }));
      await wait();
      assert.equal(requests.length, 2);
      assert.equal(requests[1].cwd, '/second');
      requests[1].resolve({ files: [{ path: '/second/file', file_name: 'file', indices: null }] });
      await flush();
      if (rejected) requests[0].reject(new Error('old project failed'));
      else requests[0].resolve({ files: [{ path: '/first/old', file_name: 'old', indices: null }] });
      await flush();
      assert.match(host.textContent!, /\/second\/file/);
      assert.doesNotMatch(host.textContent!, /\/first\/old/);
      await act(async () => host.querySelector('.menu-item')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
      assert.deepEqual(picked, ['/second/file']);
    } finally {
      await unmount();
    }
  });
}
