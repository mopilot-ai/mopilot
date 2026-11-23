// The session rail follows current Git state across editing, merging and chat reloads on every harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, popoverStub, render, one } from './support/shell-panels-kit.ts';
import { createElement, act } from 'react';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import { dismissTasks } from '../src/lib/dismissedTasks.ts';
import type { BackgroundTask } from '../src/store/session/sessionState.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ threads: {}, runtime: {}, prefs: { openDestination: 'finder' } });
let files: { added: number; removed: number }[] = [];
const activityRequests: string[] = [];
const transcriptRequests: string[][] = [];
stubStore({
  ...store.exports,
  toggleTasksPane: (id: string) => activityRequests.push(id),
  openSubThread: (id: string, title: string) => transcriptRequests.push([id, title]),
});
installNative(
  fakeNative({
    context: { get: async () => null, refresh: async () => null, onSnapshot: () => () => {} },
    git: { info: async () => ({ root: '/repo', remote: 'origin' }), gh: async () => ({ ok: false }) },
  }),
);
mock.module('../src/lib/repositoryChanges.ts', { namedExports: { repositoryDiffFiles: async () => files } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStub });
// the summary's Pull requests card reads its chat's PRs and has its own tests (tests/prInboxAllUI.test.ts)
mock.module('../src/components/panels/SummaryPullRequests.tsx', { namedExports: { SummaryPullRequests: () => null } });
mock.module('../src/components/panels/PullRequestRow.tsx', { namedExports: { PullRequestRow: () => null } });
// the machine chip and Remote Control row have their own test (summaryEnvironmentUI.test.ts)
mock.module('../src/components/panels/SummaryEnvironment.tsx', {
  namedExports: { SummaryMachine: () => null, SummaryRemoteControl: () => null },
});
const planRequests: string[] = [];
const sessionRequests: unknown[][] = [];
mock.module('../src/store/plans/pane.ts', { namedExports: { openPlanPane: (id: string) => planRequests.push(id) } });
mock.module('../src/store/outputs/pane.ts', { namedExports: { openSessionPane: (...args: unknown[]) => sessionRequests.push(args) } });
const { SummaryPanel } = await import('../src/components/panels/SummaryPanel.tsx');
const { putAdapterTasks } = await import('../src/store/backgroundTasks.ts');
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const diff = 'diff --git a/historical.md b/historical.md\n--- a/historical.md\n+++ b/historical.md\n@@ -0,0 +1,2 @@\n+one\n+two\n';
const edited = { id: 'edited', items: [], status: 'completed', diff };
const mount = () => render(createElement(SummaryPanel, { threadId: 't1' }));

test('the rail offers Plan when the chat has a checklist and opens the owning chat’s pane', async () => {
  store.set({ threads: { t1: { cwd: '/repo' } }, runtime: { t1: { turns: [] } } });
  const r = await mount();
  assert.equal(r.host.querySelector('.summary-plan'), null);
  await act(() => store.set({ runtime: { t1: { turns: [{ ...edited, plan: { steps: [{ step: 'Test', status: 'pending' }] } }] } } }));
  await act(() => one(r.host, 'button.summary-plan', 'Plan').click());
  assert.equal(planRequests.at(-1), 't1');
  await r.unmount();
});

test('the summary exposes Outputs and Usage even before the chat has produced or reported anything', async () => {
  store.set({ threads: { t1: { cwd: '/repo' } }, runtime: { t1: { turns: [] } } });
  const r = await mount();
  for (const action of ['View plan', 'Outputs', 'Usage']) {
    await act(() => one(r.host, '[aria-label="Session actions"]').click());
    await act(() => one(r.host, '[role="menuitem"]', action).click());
  }
  assert.equal(planRequests.at(-1), 't1');
  assert.deepEqual(sessionRequests.slice(-2), [
    ['t1', 'outputs'],
    ['t1', 'usage'],
  ]);
  await r.unmount();
});

const task: BackgroundTask = {
  id: 'task-1',
  type: 'local_agent',
  description: 'Review',
  status: 'running',
  summary: null,
  toolUseId: null,
  subagentType: null,
  workflowName: null,
  parentTaskId: null,
  ambient: false,
};

test('background work opens the shared pane for its chat, including completed work', async () => {
  const ids = ['codex-chat', 'claude:chat', 'acp:opencode:chat', 'acp:kimi:chat'];
  store.set({
    threads: Object.fromEntries(ids.map((id) => [id, { cwd: '/repo' }])),
    runtime: Object.fromEntries(ids.map((id) => [id, { loaded: true, turns: [] }])),
  });
  const r = await render(createElement(SummaryPanel, { threadId: ids[0] }));
  for (const id of ids) {
    await r.rerender(createElement(SummaryPanel, { threadId: id }));
    assert.equal(r.host.querySelector('.summary-activity'), null, 'a chat cannot inherit its predecessor’s task');
    await act(() => {
      if (id.startsWith('claude:')) {
        useSessions.setState({ sessions: { [id]: { ...EMPTY_SESSION, rev: 1, tasks: [task] } } });
      } else {
        putAdapterTasks(id, [{ ...task, status: 'completed' }]);
      }
    });
    const row = one(r.host, '.summary-activity button', 'Background tasks');
    assert.equal(row.textContent, 'Background tasks1');
    await act(() => row.click());
    assert.equal(activityRequests.at(-1), id);
  }
  await r.unmount();
});

test('the rail recognizes a pending proposal before it has text and keeps its location on completion', async () => {
  const plan = { id: 'proposal', type: 'plan', text: '' };
  store.set({ threads: { t1: {} }, runtime: { t1: { turns: [{ ...edited, items: [plan], status: 'inProgress' }] } } });
  const r = await mount();
  const button = one(r.host, '.summary-plan');
  assert.equal(button.textContent, 'Plan');
  await act(() => store.set({ runtime: { t1: { turns: [{ ...edited, items: [{ ...plan, text: 'A proposed change' }] }] } } }));
  assert.equal(one(r.host, '.summary-plan'), button);
  await r.unmount();
});

test('historical pages reveal missing transcripts without reviving dismissed tasks or reopening known agents', async () => {
  store.set({
    threads: { t1: {} },
    segments: { t1: [{ nativeId: 'parent-native', harness: 'codex' }] },
    runtime: { t1: { loaded: true, turns: [edited] } },
  });
  const r = await mount();
  assert.equal(r.host.querySelector('.summary-activity'), null);
  const older = {
    id: 'old',
    status: 'completed',
    items: [{ type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['first', 'extra', 'extra', 'parent-native'] }],
  };
  await act(() => putAdapterTasks('t1', [{ ...task, id: 'codex-agent:first', status: 'completed', agentKey: 'first' }]));
  await act(() => store.set({ runtime: { t1: { loaded: true, turns: [older, edited] } } }));
  const disclosure = one(r.host, '.summary-agent-transcripts') as HTMLDetailsElement;
  assert.equal(one(disclosure, 'summary').textContent, 'Agent transcripts1');
  const later = { ...older, id: 'later', items: [{ type: 'subAgentActivity', kind: 'started', agentThreadId: 'recorded' }] };
  await act(() => store.set({ runtime: { t1: { loaded: true, turns: [older, edited, later] } } }));
  assert.equal(one(disclosure, 'summary').textContent, 'Agent transcripts2');
  await act(() => {
    disclosure.open = true;
    for (const link of disclosure.querySelectorAll('button')) link.click();
  });
  assert.deepEqual(transcriptRequests, [
    ['extra', 'Agent 2'],
    ['recorded', 'Agent 4'],
  ]);
  await act(() => putAdapterTasks('t1', []));
  assert.equal(one(disclosure, 'summary').textContent, 'Agent transcripts3', 'a pruned agent keeps its stored link');
  await act(() => dismissTasks('t1', ['codex-agent:first']));
  assert.equal(one(disclosure, 'summary').textContent, 'Agent transcripts2', 'clearing a task also clears its backup link');
  assert.equal(r.host.querySelector('.task-stop'), null);
  await r.unmount();
});
for (const harness of ['codex', 'claude', 'acp']) {
  test(`${harness}: merging clears current Changes while the historical turn diff is retained`, async () => {
    store.calls.length = 0;
    store.set({ threads: { t1: { cwd: '/repo', harness } }, runtime: { t1: { turns: [edited] } } });
    files = [{ added: 8, removed: 3 }];
    const r = await mount();
    try {
      const rows = () => [...r.host.querySelectorAll('.summary-changes .summary-row')].map((row) => row.textContent);
      assert.deepEqual(rows(), ['Branch changes1 file+8 -3'], 'the summary has one current repository diff');
      files = [];
      await act(async () => {
        store.set({ runtime: { t1: { turns: [edited, { id: 'merged', items: [], status: 'completed' }] } } });
        window.dispatchEvent(new Event('focus'));
      });
      assert.deepEqual(rows(), ['Branch changesNo changes'], 'a merged turn must not revive the earlier file list');
      assert.equal(store.get().runtime.t1.turns[0].diff, diff, 'history is preserved');
      await act(() => one(r.host, '.summary-row', 'Branch changes').click());
      assert.deepEqual(store.calls.at(-1), ['openChanges', { scope: 'branch' }]);
      await r.rerender(createElement(SummaryPanel, { threadId: 'other' }));
      await r.rerender(createElement(SummaryPanel, { threadId: 't1' }));
      assert.deepEqual(rows(), ['Branch changesNo changes'], 'reopening a chat must not revive historical edits');
    } finally {
      await r.unmount();
    }
  });
}

test('live and repeated editing turns update one summary entry, scoped to the current repo', async () => {
  store.set({ threads: { t1: { cwd: '/repo' }, t2: { cwd: '/repo' } }, runtime: { t1: { activeTurnId: 'edited', turns: [edited] } } });
  files = [{ added: 4, removed: 1 }];
  const r = await mount();
  try {
    const card = one(r.host, '.summary-changes');
    assert.equal(card.textContent, 'Branch changes1 file+4 -1');
    files = [{ added: 6, removed: 2 }];
    await act(async () => store.set({ runtime: { t1: { turns: [edited, { ...edited, id: 'next', diff: '' }] } } }));
    assert.equal(card.textContent, 'Branch changes1 file+6 -2');
    assert.equal(one(card, '.summary-row').tagName, 'BUTTON');
    await r.rerender(createElement(SummaryPanel, { threadId: 't2' }));
    assert.equal(one(r.host, '.summary-changes').textContent, 'Branch changes1 file+6 -2');
    assert.equal(r.host.querySelector('.summary-turn'), null);
  } finally {
    await r.unmount();
  }
});

test('a chat without a folder does not present historical edits as current repository changes', async () => {
  store.set({ threads: { t1: {} }, runtime: { t1: { turns: [edited] } } });
  const r = await mount();
  try {
    assert.equal(r.host.querySelector('.summary-changes .diff-stat'), null);
    assert.equal(r.host.querySelector('.summary-turn'), null);
    assert.doesNotMatch(one(r.host, '.summary-changes').textContent!, /Latest edits|historical\.md/);
  } finally {
    await r.unmount();
  }
});
