// The real sidebar row and popup keep letters and arrow/Enter navigation in the menu, away from row activation.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { $, click, key, mount, fakeStore, mockTsx } from './support/composer-kit.ts';
import { stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
import type { Thread } from '../src/store/types.ts';

const chat = { id: 'opaque/chat', name: 'A chat', cwd: '/work', updatedAt: 1 } as Thread;
const store = fakeStore<any>({ pinned: {}, prefs: {}, runtime: {}, unread: {}, threadOrder: [chat.id] });
const navigated: unknown[] = [];
stubStore({
  useStore: store.useStore,
  setState: store.setState,
  nativeOf: (id: string) => id,
  threadTitle: (thread: Thread) => thread.name,
  renameThread: async () => {},
  archiveThread: async () => {},
  deleteThread: async () => {},
  forkThread: async () => {},
  openInSplit: () => {},
  navigate: (route: unknown) => navigated.push(route),
  openPaneTab: () => {},
  toast: () => {},
  toastFailure: () => () => {},
});
installNativeStub({ app: { installed: async () => ({ finder: true }), icon: async () => null } });
mock.module('../src/session/pullRequestReader.ts', {
  namedExports: { readPullRequest: Object.assign(async () => null, { known: () => undefined }) },
});
const sideView = { queue: [], children: {} };
mock.module('../src/lib/sideSessions.ts', {
  namedExports: {
    useOrchestration: () => sideView,
    useOrchestrationSelect: (select: any) => select(sideView),
    orchestrationNow: () => sideView,
    subscribeOrchestration: () => () => {},
  },
});
mock.module('../src/components/sidebar/ThreadMachineLine.tsx', {
  namedExports: { useRowMachineLine: () => null, ThreadMachineLine: () => null },
});
mock.module('../src/session/useChatRowState.ts', { namedExports: { useChatRowState: () => undefined } });
for (const [path, names] of [
  ['components/harnessPicker/HarnessPicker.tsx', ['ThreadHarnessBadge']],
  ['components/sidebar/ThreadPullRequestBadge.tsx', ['ThreadPullRequestBadge']],
  ['components/thread/GoalBar.tsx', ['GoalMark']],
  ['components/sidebar/ThreadIndicators.tsx', ['ThreadActivityIndicator', 'ThreadForkIndicator', 'ThreadVoiceIndicator']],
  ['session/sidebarShortcuts.tsx', ['SidebarChatShortcut']],
] as const)
  mockTsx(new URL(`../src/${path}`, import.meta.url), Object.fromEntries(names.map((name) => [name, () => null])));
const { ThreadRow } = await import('../src/components/sidebar/ThreadRow.tsx');

test('letters work through the row popup portal and Enter never also opens the row', async (t) => {
  const view = await mount(h(ThreadRow, { thread: chat, active: false }));
  t.after(() => view.unmount());
  await click($('[aria-label="More options"]'));
  let menu = $('[role="menu"]');
  menu.focus();
  await key(menu, 'p');
  assert.equal(store.get().pinned[chat.id], true);
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.deepEqual(navigated, []);
  await click($('[aria-label="More options"]'));
  menu = $('[role="menu"]');
  menu.focus();
  await key(menu, 'ArrowDown');
  assert.ok(menu.getAttribute('aria-activedescendant'), 'arrows select the first menu row');
  await key(menu, 'Enter');
  assert.equal(document.querySelectorAll('[role="menu"]').length, 2, 'Enter opens the Open in submenu');
  assert.deepEqual(navigated, [], 'the menu Enter never activates its chat row');
  await act(async () => menu.focus());
  await key(menu, 'Escape');
  assert.equal(document.querySelector('[role="menu"]'), null);
});
