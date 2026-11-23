// src/components/tasks/TaskSessions.tsx: the Background tasks tab shows the chats a chat started, on any harness, as their
// live cards grouped Needs you, Running sessions and Finished sessions, oldest first, and a card moves group with its state.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const store = fakeStore<any>({ runtime: {}, segments: {}, archived: [], claudeArchived: {}, agentTabs: {} });
let notify: (v: any) => void = () => {};
const empty = { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
stubStore({ useStore: store.useStore, openInSplit: () => {}, navigate: () => {}, toast: () => {}, chatKind: () => 'codex' });
installNativeStub({ orchestration: { snapshot: async () => empty, onChanged: (cb: any) => ((notify = cb), () => {}) } });
// each chat's row state (the sidebar dot's), set by hand per chat
const rows: Record<string, string> = {};
mock.module('../src/session/useChatRowState.ts', {
  namedExports: {
    useChatRowState: (id: string) => (rows[id] ? { state: rows[id] } : null),
    useChatTurn: () => 'idle',
    retryChatState: async () => {},
  },
});
const { TaskSessions, sessionGroup, startedBy } = await import('../src/components/tasks/TaskSessions.tsx');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const child = (o: any) => ({ parentId: 'top', name: 'n', title: '', harness: null, useWorktree: false, lastReport: null, ...o });
const show = (children: any) => act(async () => notify({ ...empty, children }));
/** Each group's heading and the titles of its cards, in order. */
const groups = (v: any) =>
  [...v.host.querySelectorAll('.tasks-section')].map((s: any) => [
    s.querySelector('.tasks-section-head').textContent,
    ...[...s.querySelectorAll('.session-card-title')].map((t: any) => t.textContent),
  ]);

test('a state goes to its group; one the window does not know yet counts as running', () => {
  assert.equal(sessionGroup('needsInput'), 'needs');
  // went wrong, but asks the user nothing (#3403)
  assert.equal(sessionGroup('failed'), 'failed');
  assert.equal(sessionGroup('held'), 'failed');
  assert.equal(sessionGroup('notStarted'), 'failed');
  assert.equal(sessionGroup('working'), 'running');
  assert.equal(sessionGroup('queued'), 'running');
  assert.equal(sessionGroup('waiting'), 'running');
  assert.equal(sessionGroup(undefined), 'running');
  for (const s of ['done', 'idle'] as const) assert.equal(sessionGroup(s), 'finished');
  assert.equal(sessionGroup('archived'), 'archived');
});

test("a chat's started sessions, oldest first; another chat's and a detached one are not its own", () => {
  const view: any = {
    ...empty,
    children: {
      b: child({ createdAt: 2 }),
      a: child({ createdAt: 1 }),
      other: child({ parentId: 'elsewhere', createdAt: 0 }),
      gone: child({ detached: true, createdAt: 3 }),
    },
  };
  assert.deepEqual(startedBy(view, 'top'), ['a', 'b']);
  assert.deepEqual(startedBy(view, 'nobody'), []);
});

test('the sessions show grouped, Needs you first, and a card moves group as its state changes', async () => {
  Object.assign(rows, { a: 'working', b: 'approval', c: 'done', d: 'working' });
  const children = {
    a: child({ title: 'Trace the race', createdAt: 1 }),
    b: child({ title: 'Read the specs', createdAt: 2 }),
    c: child({ title: 'Document it', createdAt: 3 }),
    d: child({ name: 'port-gate', createdAt: 4 }),
  };
  await show(children);
  const v = await render(h(TaskSessions, { chatId: 'top' }));
  await show(children);
  assert.deepEqual(groups(v), [
    ['Needs you · 1', 'Read the specs'],
    ['Running sessions · 2', 'Trace the race', 'port-gate'],
    ['Finished sessions · 1', 'Document it'],
  ]);
  assert.equal(v.host.querySelector('[data-group="needs"] .session-card-word')!.textContent, 'Needs input');
  // the one that needed input goes back to work, and one that ran finishes
  Object.assign(rows, { b: 'working', a: 'done' });
  await show(children);
  assert.deepEqual(groups(v), [
    ['Running sessions · 2', 'Read the specs', 'port-gate'],
    ['Finished sessions · 2', 'Trace the race', 'Document it'],
  ]);
  // archiving one puts it away, out of sight; unarchived, it comes back
  await act(async () => store.setState({ claudeArchived: { c: 1 } }));
  assert.deepEqual(groups(v), [
    ['Running sessions · 2', 'Read the specs', 'port-gate'],
    ['Finished sessions · 1', 'Trace the race'],
  ]);
  assert.ok(v.host.querySelector('[hidden] .session-card[data-state="archived"]'));
  await act(async () => store.setState({ claudeArchived: {} }));
  assert.deepEqual(groups(v)[1], ['Finished sessions · 2', 'Trace the race', 'Document it']);
  // one that failed is grouped apart from Needs you: it asks the user nothing (#3403)
  Object.assign(rows, { d: 'error' });
  await show(children);
  assert.deepEqual(groups(v)[0], ['Failed sessions · 1', 'port-gate']);
  await v.unmount();
});

test('a chat that started no sessions shows nothing', async () => {
  await show({});
  const v = await render(h(TaskSessions, { chatId: 'top' }));
  assert.equal(v.host.querySelector('.tasks-section'), null);
  await v.unmount();
});
