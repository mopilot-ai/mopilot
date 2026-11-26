// The summary panel's header and project menu: the folder, branch and file count, Finder, the app chosen in Settings → General
// (none besides Finder), a terminal, hiding, and a Remote Control row that starts fresh for each chat.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, popoverStub, render, one, settle } from './support/shell-panels-kit.ts';
import { createElement as h, act, useState } from 'react';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ threads: { chat: { cwd: '/repo' } }, runtime: { chat: { turns: [] } }, prefs: { openDestination: 'finder' } });
const calls: unknown[][] = [];
stubStore(store.exports);
installNativeStub({
  codex: { onItem: () => () => {}, onStatus: () => () => {}, api: async () => ({ data: [] }) },
  claude: { onEvent: () => () => {}, control: async () => null },
  // main's context snapshots (src/session/useContextSnapshot.ts): none known
  context: { get: async () => null, refresh: async () => null, onSnapshot: () => () => {} },
  git: {
    info: async (cwd: string) => (cwd ? { root: cwd, branch: 'feature/rail', remote: 'origin' } : null),
    gh: async () => ({ ok: false }),
  },
  app: { icon: async (id: string) => `data:${id}` },
  shell: {
    openPath: async (p: string) => void calls.push(['openPath', p]),
    openIn: async (app: string, p: string) => void calls.push(['openIn', app, p]),
  },
});
let diffFiles: { added: number; removed: number }[] = [];
mock.module('../src/lib/repositoryChanges.ts', { namedExports: { repositoryDiffFiles: async () => diffFiles } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStub });
// the summary's Pull requests card reads its chat's PRs and has its own tests (tests/prInboxAllUI.test.ts)
mock.module('../src/components/panels/SummaryPullRequests.tsx', { namedExports: { SummaryPullRequests: () => null } });
mock.module('../src/components/panels/PullRequestRow.tsx', { namedExports: { PullRequestRow: () => null } });
// the Remote Control row's own state (a pending confirm) belongs to the chat it first drew for: the probe shows that chat
mock.module('../src/components/panels/SummaryEnvironment.tsx', {
  namedExports: {
    SummaryMachine: () => null,
    SummaryRemoteControl: ({ threadId }: { threadId: string }) => h('span', { className: 'rc-probe' }, useState(threadId)[0]),
  },
});
const { SummaryPanel } = await import('../src/components/panels/SummaryPanel.tsx');

test('with Finder chosen the menu offers no other app; it opens the folder, a terminal and hides the summary', async () => {
  const { host, unmount } = await render(h(SummaryPanel, { threadId: 'chat' }));
  await act(() => one(host, '.icon-btn').click());
  assert.deepEqual(
    [...host.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent),
    ['Open in Finder', 'Open terminal', 'View plan', 'Outputs', 'Usage', 'Track pull request…', 'Refresh', 'Hide summary'],
  );
  await act(() => one(host, '[role="menuitem"]', 'Open in Finder').click());
  for (const label of ['Open terminal', 'Hide summary']) {
    await act(() => one(host, '.icon-btn').click());
    await act(() => one(host, '[role="menuitem"]', label).click());
  }
  assert.deepEqual(calls, [['openPath', '/repo']]);
  assert.deepEqual(
    store.calls.filter((c) => c[0] === 'setState'),
    [
      ['setState', { bottomPanelOpen: true }],
      ['setState', 'fn'],
    ],
  );
  assert.equal(store.exports.getState().summaryOpen, false, 'Hide summary sets the saved choice');
  await unmount();
});

test('another app chosen in Settings shows by its name and icon, and opens the folder there', async () => {
  calls.length = 0;
  store.set({ prefs: { openDestination: 'cursor' } });
  const { host, unmount } = await render(h(SummaryPanel, { threadId: 'chat' }));
  await act(() => one(host, '.icon-btn').click());
  await settle(act);
  const item = one(host, '[role="menuitem"]', 'Open in Cursor');
  assert.equal(item.querySelector('img')?.getAttribute('src'), 'data:cursor');
  await act(() => item.click());
  assert.deepEqual(calls, [['openIn', 'cursor', '/repo']]);
  await unmount();
});

test('the header names the folder and its branch, whole on hover, and a chat without a folder says so', async () => {
  diffFiles = [{ added: 1, removed: 0 }];
  store.set({ threads: { chat: { cwd: '/repo' } } });
  const r = await render(h(SummaryPanel, { threadId: 'chat' }));
  await settle(act);
  assert.equal(one(r.host, '.summary-project').textContent, 'repo');
  assert.equal(one(r.host, '.summary-branch').textContent, 'feature/rail');
  assert.equal(one(r.host, '.summary-branch').getAttribute('title'), 'feature/rail');
  assert.equal(one(r.host, '.summary-row', 'Branch changes').querySelector('.summary-hint')!.textContent, '1 file');
  diffFiles = [
    { added: 1, removed: 0 },
    { added: 0, removed: 2 },
  ];
  await act(async () => window.dispatchEvent(new Event('focus')));
  await settle(act);
  assert.equal(one(r.host, '.summary-row', 'Branch changes').querySelector('.summary-hint')!.textContent, '2 files');
  await act(async () => store.set({ threads: { chat: { cwd: '' } } }));
  await settle(act);
  assert.equal(one(r.host, '.summary-project').textContent, 'No folder');
  assert.equal(one(r.host, '.summary-project').className, 'summary-project none');
  assert.equal(r.host.querySelector('.summary-branch'), null, 'no repository, no branch');
  await r.unmount();
  diffFiles = [];
});

test("another chat's Remote Control row starts fresh, so a confirm left open never turns that chat's switch on", async () => {
  store.set({ threads: { a: { cwd: '/repo' }, b: { cwd: '/repo' } } });
  const r = await render(h(SummaryPanel, { threadId: 'a' }));
  assert.equal(one(r.host, '.rc-probe').textContent, 'a');
  await r.rerender(h(SummaryPanel, { threadId: 'b' }));
  assert.equal(one(r.host, '.rc-probe').textContent, 'b');
  const old = one(r.host, '.rc-probe');
  await act(() => store.set({ segments: { b: [{ nativeId: 'claude:new', harness: 'claude' }] } }));
  assert.notEqual(one(r.host, '.rc-probe'), old);
  await r.unmount();
});

test('a managed worktree uses the original project’s name and opens its own checkout', async () => {
  const cwd = '/worktrees/generated-branch-directory';
  calls.length = 0;
  store.set({
    threads: { chat: { cwd } },
    worktreeOf: { chat: '/work/the-project' },
    prefs: { openDestination: 'finder' },
  });
  const r = await render(h(SummaryPanel, { threadId: 'chat' }));
  assert.equal(one(r.host, '.summary-project').textContent, 'the-project');
  assert.equal(one(r.host, '.summary-project').title, cwd);
  assert.equal(one(r.host, '.summary-path').textContent, '· /work');
  await settle(act);
  assert.equal(one(r.host, '.summary-branch .summary-hint').textContent, 'Worktree');
  assert.deepEqual(
    [...one(r.host, '.summary-panel').children].slice(0, 4).map((section) => section.querySelector('h2, summary > span')?.textContent),
    ['Environment', 'Context', 'Connectors', 'Changes'],
  );
  await act(() => one(r.host, '[aria-label="Session actions"]').click());
  await act(() => one(r.host, '[role="menuitem"]', 'Open in Finder').click());
  assert.deepEqual(calls, [['openPath', cwd]]);
  await r.unmount();
});
