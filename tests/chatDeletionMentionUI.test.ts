// Cached chat mentions observe terminal deletion receipts and late aliases without store updates.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { fakeStore, render, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
let mentionId = 'mention-main';
const store = fakeStore({ threads: {}, threadOrder: [], claudeArchived: {}, cwd: '/first' });
const requests: { cwd: string; resolve: (value: any) => void; reject: (error: unknown) => void }[] = [];
stubStore({
  useStore: store.useStore,
  currentCwdForNewChat: () => store.getState().cwd,
  threadTitle: (t: any) => t.title,
  searchThreads: async () => ({
    codex: [
      { id: mentionId, title: 'Remote Match', updatedAt: 1 },
      { id: 'mention-other', title: 'Other Match', updatedAt: 1 },
    ],
  }),
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

const { deletionVisibility } = await import('../src/store/deletionVisibility.ts');
test('cached remote-only mention row disappears immediately after receipt', async () => {
  const anchor = document.createElement('div');
  const picked: string[] = [];
  const { host, unmount } = await render(
    createElement(MentionPopup, {
      anchor,
      threadId: null,
      query: 'Match',
      index: 0,
      setIndex: () => {},
      onPick: () => {},
      onPickChat: (t: any) => picked.push(t.id),
      onPickTab: () => {},
      onClose: () => {},
    }),
  );
  try {
    await act(async () => new Promise((r) => setTimeout(r, 160)));
    await flush();
    assert.match(host.textContent!, /Remote Match/);
    const stale = host.querySelector('.menu-item')!;
    await act(async () => {
      deletionVisibility.accept({ chatId: 'mention-main', nativeKeys: ['mention-main'], nativeDeleted: true, metadata: 'retained' });
      stale.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    });
    assert.deepEqual(picked, []);
    assert.doesNotMatch(host.textContent!, /Remote Match/);
    assert.match(host.textContent!, /Other Match/);
  } finally {
    await unmount();
  }
});

test('stale mention alias metadata preserves a live chat until an authoritative additive receipt retires it', async () => {
  mentionId = 'mention-second-main';
  const anchor = document.createElement('div');
  const picked: string[] = [];
  const { host, unmount } = await render(
    createElement(MentionPopup, {
      anchor,
      threadId: null,
      query: 'Match',
      index: 0,
      setIndex: () => {},
      onPick: () => {},
      onPickChat: (t: any) => picked.push(t.id),
      onPickTab: () => {},
      onClose: () => {},
    }),
  );
  try {
    await act(async () => new Promise((r) => setTimeout(r, 160)));
    await flush();
    await act(async () => {
      deletionVisibility.accept({ chatId: 'terminal-owner', nativeKeys: ['terminal-owner'], nativeDeleted: true, metadata: 'retained' });
      deletionVisibility.filter({ segments: { 'terminal-owner': [{ nativeId: mentionId, harness: 'codex' }] } } as any);
    });
    assert.match(host.textContent!, /Remote Match/);
    const stale = host.querySelector('.menu-item')!;
    await act(async () => stale.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
    assert.deepEqual(picked, [mentionId]);
    await act(async () => {
      deletionVisibility.accept({
        chatId: 'terminal-owner',
        nativeKeys: ['terminal-owner'],
        retainedAliasKeys: [mentionId],
        nativeDeleted: true,
        metadata: 'retained',
      });
      stale.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    });
    assert.deepEqual(picked, [mentionId]);
    assert.doesNotMatch(host.textContent!, /Remote Match/);
    assert.match(host.textContent!, /Other Match/);
    await act(async () => {
      // An older original receipt and a duplicate expanded certificate only union terminal identities.
      deletionVisibility.accept({ chatId: 'terminal-owner', nativeKeys: ['terminal-owner'], nativeDeleted: true, metadata: 'retained' });
      deletionVisibility.accept({
        chatId: 'terminal-owner',
        nativeKeys: ['terminal-owner'],
        retainedAliasKeys: [mentionId],
        nativeDeleted: true,
        metadata: 'retained',
      });
    });
    assert.doesNotMatch(host.textContent!, /Remote Match/);
    assert.match(host.textContent!, /Other Match/);
  } finally {
    await unmount();
  }
});

test('mention keyboard rejects a deleted current row and keeps unrelated keyboard and mouse selection working', async () => {
  mentionId = 'mention-keyboard-terminal';
  const anchor = document.createElement('div');
  const picked: string[] = [];
  const { host, unmount } = await render(
    createElement(MentionPopup, {
      anchor,
      threadId: null,
      query: 'Match',
      index: 0,
      setIndex: () => {},
      onPick: () => {},
      onPickChat: (t: any) => picked.push(t.id),
      onPickTab: () => {},
      onClose: () => {},
    }),
  );
  const enter = () =>
    window.dispatchEvent(new window.CustomEvent('composer-popup-key', { cancelable: true, detail: { key: 'Enter', owner: anchor } }));
  try {
    await act(async () => new Promise((r) => setTimeout(r, 160)));
    await flush();
    await act(async () => {
      deletionVisibility.accept({ chatId: mentionId, nativeKeys: [mentionId], nativeDeleted: true, metadata: 'retained' });
      enter();
    });
    assert.deepEqual(picked, []);
    assert.doesNotMatch(host.textContent!, /Remote Match/);
    await act(async () => {
      enter();
    });
    assert.deepEqual(picked, ['mention-other']);
    await act(async () => {
      host.querySelector('.menu-item')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    });
    assert.deepEqual(picked, ['mention-other', 'mention-other']);
  } finally {
    await unmount();
  }
});

test('mention remaps cached alias matches and blocks stale picks when current owner changes or disappears', async () => {
  for (const method of ['mouse', 'keyboard']) {
    mentionId = `claude:mention-alias-${method}`;
    const root = `mention-canonical-${method}`;
    store.setState({ threads: {}, threadOrder: [], segments: {} } as any);
    const anchor = document.createElement('div');
    const picked: string[] = [];
    const { host, unmount } = await render(
      createElement(MentionPopup, {
        anchor,
        threadId: null,
        query: 'Match',
        index: 0,
        setIndex: () => {},
        onPick: () => {},
        onPickChat: (t: any) => picked.push(t.id),
        onPickTab: () => {},
        onClose: () => {},
      }),
    );
    const enter = () =>
      window.dispatchEvent(new window.CustomEvent('composer-popup-key', { cancelable: true, detail: { key: 'Enter', owner: anchor } }));
    try {
      await act(async () => new Promise((r) => setTimeout(r, 160)));
      await flush();
      const stale = host.querySelector('.menu-item')!;
      await act(async () => {
        store.setState({
          segments: { [root]: [{ nativeId: root }, { nativeId: mentionId }] },
          threads: { [root]: { id: root, title: 'Canonical Match discussion', updatedAt: 1 } },
        } as any);
        if (method === 'mouse') stale.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
        else enter();
      });
      assert.deepEqual(picked, []);
      assert.match(host.textContent!, /Canonical Match discussion/);
      assert.doesNotMatch(host.textContent!, /Remote Match/);
      await act(async () => enter());
      assert.deepEqual(picked, [root], 'fresh keyboard selection uses the remapped canonical row');
      picked.length = 0;
      const canonical = host.querySelector('.menu-item')!;
      await act(async () => {
        store.setState({ threads: {} });
        if (method === 'mouse') canonical.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
        else enter();
      });
      assert.deepEqual(picked, []);
      assert.doesNotMatch(host.textContent!, /Canonical Match discussion/);
      await act(async () => store.setState({ threads: { [root]: { id: root, title: 'Canonical Match discussion', updatedAt: 1 } } }));
      await act(async () => host.querySelector('.menu-item')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
      assert.deepEqual(picked, [root]);
    } finally {
      await unmount();
    }
  }
});

test('active canonical chat remains excluded when its remote alias matches', async () => {
  mentionId = 'claude:active-mention-alias';
  const root = 'active-mention-canonical';
  store.setState({
    threads: { [root]: { id: root, title: 'Active discussion', updatedAt: 1 } },
    threadOrder: [root],
    segments: { [root]: [{ nativeId: root }, { nativeId: mentionId }] },
  } as any);
  const { host, unmount } = await render(
    createElement(MentionPopup, {
      anchor: document.createElement('div'),
      threadId: root,
      query: 'Match',
      index: 0,
      setIndex: () => {},
      onPick: () => {},
      onPickChat: () => {},
      onPickTab: () => {},
      onClose: () => {},
    }),
  );
  try {
    await act(async () => new Promise((r) => setTimeout(r, 160)));
    await flush();
    assert.doesNotMatch(host.textContent!, /Remote Match|Active discussion/);
    assert.match(host.textContent!, /Other Match/);
  } finally {
    await unmount();
  }
});

test('ordinary local mention remains selectable with no remote query', async () => {
  const id = 'ordinary-local-mention';
  store.setState({ threads: { [id]: { id, title: 'Local discussion', updatedAt: 1 } }, threadOrder: [id], segments: {} } as any);
  const picked: string[] = [];
  const { host, unmount } = await render(
    createElement(MentionPopup, {
      anchor: document.createElement('div'),
      threadId: null,
      query: '',
      index: 0,
      setIndex: () => {},
      onPick: () => {},
      onPickChat: (t: any) => picked.push(t.id),
      onPickTab: () => {},
      onClose: () => {},
    }),
  );
  try {
    await act(async () => host.querySelector('.menu-item')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
    assert.deepEqual(picked, [id]);
  } finally {
    await unmount();
  }
});
