// Sidebar question counts belong to their asking chat, including folded mixed-harness families and cleared requests.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
mock.module('../src/lib/onScreen.ts', { namedExports: { useOnScreen: () => true } });
const { reset, fx, thread, mountSidebar, flush, update, getState, click } = await import('./support/shell-sidebar-kit.ts');

const { resetSideSessions } = await import('../src/lib/sideSessions.ts');
const { resetNestedHidden } = await import('../src/lib/nestedHidden.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const child = (parentId: string, harness: string, createdAt: number) => ({
  parentId,
  name: harness,
  title: harness,
  harness,
  createdAt,
  useWorktree: false,
  lastReport: null,
});
const empty = { deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
const row = (host: HTMLElement, id: string) => host.querySelector(`[data-sidebar-chat="${id}"]`) as HTMLElement | null;
const badge = (host: HTMLElement, id: string) =>
  row(host, id)?.querySelector('[role="img"][aria-label*="needs you"], [role="img"][aria-label*="need you"]') ?? null;

test('a child wrap-up question is counted on its row, never its parent or sibling, even with the family folded', async (t) => {
  localStorage.clear();
  resetNestedHidden();
  resetSideSessions();
  const ids = ['top', 'child', 'sibling'];
  reset({ threadOrder: ids, threads: Object.fromEntries(ids.map((id) => [id, thread(id)])), agentTabs: {} });
  fx.orchestration = {
    ...empty,
    children: {
      child: { ...child('top', 'codex', 1), facts: { pr: { number: 1, state: 'OPEN', url: 'https://github.com/acme/demo/pull/1' } } },
      sibling: child('top', 'claude', 2),
    },
    wrapUps: { child: { recap: 'Ready.', ask: 'Keep the alias?', actions: [] } },
  };
  const view = await mountSidebar();
  t.after(() => view.unmount());
  await flush();
  assert.equal(badge(view.host, 'top'), null);
  assert.equal(badge(view.host, 'child')?.textContent, '1');
  assert.equal(badge(view.host, 'sibling'), null);
  const family = row(view.host, 'top')!.closest('.sidebar-section') as HTMLElement;
  await click(row(family, 'top')!.querySelector('.nested-caret')!);
  assert.ok(row(family, 'child'), 'the asking child stays reachable while folded');
  assert.equal(badge(family, 'child')?.getAttribute('aria-label'), '1 request needs you');
  assert.equal(row(family, 'sibling'), null);
  await act(async () => fx.orchestrationChanged({ ...fx.orchestration, wrapUps: {} }));
  await flush();
  assert.equal(row(family, 'child'), null, 'answering lets the child fold again');
  assert.equal(badge(view.host, 'top'), null);
  await update({ ...getState(), agentTabs: { child: [{ signin: { url: 'https://example.test' } }], sibling: [{}] } });
  assert.equal(badge(family, 'child')?.textContent, '1', 'a sign-in hand-off reveals only its owner too');
  assert.equal(row(family, 'sibling'), null);
  await update({ ...getState(), agentTabs: {} });
  assert.equal(row(family, 'child'), null);
});

test('mixed-harness requests and reused native request ids count only for their own chat and clear independently', async (t) => {
  resetSideSessions();
  const ids = ['top', 'codex', 'claude', 'acp'];
  const approval = (method: string, id = 'same-native-id', params = {}) => ({ id, method, params });
  reset({
    threadOrder: ids,
    threads: Object.fromEntries(ids.map((id) => [id, thread(id)])),
    agentTabs: {},
    sessions: {
      codex: { rev: 1, approvals: [approval('item/tool/requestUserInput')] },
      claude: {
        rev: 1,
        approvals: [
          approval('claude/permission', 'same-native-id', { toolName: 'AskUserQuestion', input: { questions: [] } }),
          approval('sage/approval', 'site'),
        ],
      },
      acp: {
        rev: 1,
        questions: [
          { id: 'same-native-id', status: 'pending' },
          { id: 'answered', status: 'written' },
        ],
      },
    },
  });
  fx.orchestration = {
    ...empty,
    children: { codex: child('top', 'codex', 1), claude: child('codex', 'claude', 2), acp: child('top', 'opencode', 3) },
  };
  const view = await mountSidebar();
  t.after(() => view.unmount());
  await flush();
  assert.deepEqual(
    ids.map((id) => badge(view.host, id)?.textContent ?? null),
    [null, '1', '2', '1'],
  );
  assert.equal(badge(view.host, 'claude')?.getAttribute('aria-label'), '2 requests need you');
  await update({
    ...getState(),
    sessions: {
      ...getState().sessions,
      codex: { rev: 2, approvals: [] },
      acp: { rev: 2, questions: [{ id: 'same-native-id', status: 'cancelled' }] },
    },
  });
  assert.deepEqual(
    ids.map((id) => badge(view.host, id)?.textContent ?? null),
    [null, null, '2', null],
  );
});
