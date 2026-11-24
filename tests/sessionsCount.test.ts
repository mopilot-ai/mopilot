// src/components/tasks/SessionsCount.tsx: after a turn, the status line counts the sessions the chat started that still
// run, wait, need the user or failed, on any harness, from each session's live card state. "Needs you" counts only
// sessions blocked on the user and opens the first of them (#3403); the others open Background tasks.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, click } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore, stubSlice } from './support/stubs.ts';
import { inboxCount, type InboxRow } from '../src/lib/prInbox.ts';

const { createElement: h, act } = await import('react');
const store = fakeStore<any>({ runtime: {}, segments: {}, archived: [], claudeArchived: {}, agentTabs: {} });
let notify: (v: any) => void = () => {};
const empty = { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
const opened: string[] = [];
stubStore({ useStore: store.useStore, navigate: () => {}, toast: () => {}, chatKind: () => 'claude', chatOf: (id: string) => id });
stubSlice('src/store/panes.ts', { toggleTasksPane: (id: string) => opened.push(id) });
// the session a "needs you" click opens
const chatsOpened: string[] = [];
const chatPolicies: unknown[] = [];
mock.module('../src/session/openChat.ts', {
  namedExports: {
    openChatFrom: (_e: unknown, id: string, policy?: unknown) => {
      chatPolicies.push(policy);
      chatsOpened.push(id);
    },
    openChat: () => {},
  },
});
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
// the tasks count's own line (tests/tasksCountUI.test.ts): here it shows what it is handed after its tasks
let pressed = false;
mock.module('../src/components/tasks/TasksPill.tsx', {
  namedExports: {
    useTasksTabPressed: () => pressed,
    TasksStatusRow: (p: any) => (p.extra ? h('div', { className: 'tasks-status-row' }, p.extra) : null),
    InlineTasksCount: (p: any) => h('i', { 'data-tasks': p.chatId }),
  },
});
const { InlineCounts, StatusCounts, sessionCounts, sessionsRunningLabel, sessionsWaitingLabel, sessionsQueuedLabel, sessionsFailedLabel } =
  await import('../src/components/tasks/SessionsCount.tsx');
const { NEEDS_USER, STATE_WORD } = await import('../src/components/thread/SessionCard.tsx');
const { clearPrLine, setPrLine } = await import('../src/components/thread/prLine.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const child = (o: any = {}) => ({
  parentId: 'top',
  name: 'n',
  title: 't',
  harness: null,
  useWorktree: false,
  lastReport: null,
  createdAt: 1,
  ...o,
});
// these tests change what the rows read outside the view; an equal view wakes nobody (#5398), so each broadcast carries a new revision
let rev = 0;
const show = (children: any, more: any = {}) => act(async () => notify({ ...empty, children, ...more, rev: ++rev }));
const line = (v: any) => v.host.querySelector('.tasks-status-row')?.textContent ?? null;
const prCount = (open: number, merged = 0) => inboxCount({ needs: [], moving: Array<InboxRow>(open), landed: Array<InboxRow>(merged) });

test('the labels count one and many', () => {
  assert.equal(sessionsRunningLabel(1), '1 session running');
  assert.equal(sessionsRunningLabel(3), '3 sessions running');
  assert.equal(sessionsWaitingLabel(1), '1 session needs you');
  assert.equal(sessionsWaitingLabel(2), '2 sessions need you');
  assert.equal(sessionsQueuedLabel(1), '1 session queued');
  assert.equal(sessionsQueuedLabel(4), '4 sessions queued');
  assert.equal(sessionsFailedLabel(1), '1 session failed');
  assert.equal(sessionsFailedLabel(2), '2 sessions failed');
});

const reset = () => {
  for (const k of Object.keys(rows)) delete rows[k];
  opened.length = 0;
  chatsOpened.length = 0;
  chatPolicies.length = 0;
  store.setState({ claudeArchived: {}, agentTabs: {} });
};

test('running sessions open the tab; "needs you" opens the first session blocked on the user', async () => {
  reset();
  Object.assign(rows, { a: 'working', b: 'working', c: 'approval', d: 'done', e: 'input' });
  const children = { a: child(), b: child(), c: child(), d: child(), e: child(), other: child({ parentId: 'elsewhere' }) };
  await show(children);
  const v = await render(h(StatusCounts, { chatId: 'top' }));
  await show(children);
  assert.equal(line(v), '2 sessions running·2 sessions need you');
  const [running, waiting] = [...v.host.querySelectorAll('.tasks-count')] as HTMLButtonElement[];
  assert.equal(waiting.className, 'tasks-count waiting');
  assert.equal(running.getAttribute('aria-pressed'), 'false');
  await click(running);
  await click(waiting);
  assert.deepEqual(opened, ['top']);
  assert.deepEqual(chatsOpened, ['c']);
  assert.deepEqual(chatPolicies, [{ newWindow: false }]);
  // all settled: nothing left to count, so the sessions add nothing to the line
  Object.assign(rows, { a: 'done', b: 'idle', c: 'done', e: 'done' });
  await show(children);
  assert.equal(line(v), null);
  await v.unmount();
});

test('#3403: archived children whose last turn failed or was lost need nothing, though the archive list is not loaded', async () => {
  reset();
  // the reported chat: two archived children (not in the sidebar, so no row) ended failed and lost; the Settings
  // archive list (store.archived) is empty, as it is until that page opens; their archive mark is in the chat meta
  const children = {
    audit: child({ lastReport: { how: 'failed', report: null, at: 1 } }),
    research: child({ lastReport: { how: 'lost', report: null, at: 1 } }),
    android: child({ lastReport: { how: 'stopped', report: 'Stopped: you interrupted sdkmanager twice', at: 2 } }),
    remote: child({ lastReport: { how: 'finished', report: 'Status: E2E found a real bug', at: 3 } }),
  };
  Object.assign(rows, { android: 'idle', remote: 'done' });
  store.setState({ claudeArchived: { audit: 10, research: 11 } });
  await show(children);
  const v = await render(h(StatusCounts, { chatId: 'top' }));
  await show(children);
  // interrupted, idle with a report, and archived: none of them is waiting on the user
  assert.equal(line(v), null);
  await v.unmount();
});

test('a failed session is counted as failed, not as needing the user, and opens the tab', async () => {
  reset();
  const children = { f: child({ lastReport: { how: 'failed', report: 'Crashed', at: 1 } }), n: child() };
  Object.assign(rows, { n: 'error' });
  await show(children);
  const v = await render(h(StatusCounts, { chatId: 'top' }));
  await show(children);
  assert.equal(line(v), '2 sessions failed');
  await click(v.host.querySelector('.tasks-count') as HTMLButtonElement);
  assert.deepEqual(opened, ['top']);
  assert.deepEqual(chatsOpened, []);
  await v.unmount();
});

test('an unanswered wrap-up question and a sign-in hand-off need the user; an answered question does not', async () => {
  reset();
  Object.assign(rows, { q: 'idle', s: 'idle', w: 'working' });
  const children = { q: child(), s: child(), w: child() };
  const asked = {
    wrapUps: { q: { recap: 'r', ask: 'Merge it?', actions: [{ label: 'Merge', message: null }] }, w: { recap: '', ask: 'x', actions: [] } },
  };
  store.setState({ agentTabs: { s: [{ tabKey: null, signin: { reason: 'Sign in', credential: true } }] } });
  await show(children, asked);
  const v = await render(h(StatusCounts, { chatId: 'top' }));
  await show(children, asked);
  // w still works: its old box is not what it is doing now
  assert.equal(line(v), '1 session running·2 sessions need you');
  await click(v.host.querySelector('.tasks-count.waiting') as HTMLButtonElement);
  assert.deepEqual(chatsOpened, ['q']);
  // the user answered q (its next turn cleared the box) and finished the sign-in: nothing left to count
  store.setState({ agentTabs: { s: [{ tabKey: null, signin: null }] } });
  await show(children);
  assert.equal(line(v), '1 session running');
  await v.unmount();
});

test('guard: "needs you" counts exactly the sessions it can open, for every state, so the target exists when shown', () => {
  // only the state blocked on the user counts; a failure is not something the user can answer
  assert.deepEqual([...NEEDS_USER], ['needsInput']);
  const all = Object.keys(STATE_WORD) as (keyof typeof STATE_WORD)[];
  for (const a of [...all, undefined])
    for (const b of [...all, undefined]) {
      const states = { x: a, y: b };
      const { needs } = sessionCounts(['x', 'y', 'z'], states);
      const expected = ['x', 'y'].filter((id) => (states as any)[id] === 'needsInput');
      assert.deepEqual(needs, expected, `${a}/${b}`);
      if (needs.length) assert.equal(states[needs[0] as 'x' | 'y'], 'needsInput');
    }
});

test('sessions waiting their turn count as queued, not running', async () => {
  reset();
  Object.assign(rows, { a: 'working', q: 'working', w: 'working' });
  const children = { a: child(), q: child(), w: child(), api: child({ parentId: 'elsewhere' }) };
  // q waits for a free slot, w for another session
  const more = { queue: ['q'], waiting: { w: { after: ['api'], held: null } } };
  await show(children, more);
  const v = await render(h(StatusCounts, { chatId: 'top' }));
  await show(children, more);
  assert.equal(line(v), '1 session running·2 sessions queued');
  await v.unmount();
});

test('pressed while the tab is open; a chat with no sessions adds nothing', async () => {
  reset();
  rows.a = 'working';
  pressed = true;
  await show({ a: child() });
  const v = await render(h(StatusCounts, { chatId: 'top' }));
  await show({ a: child() });
  assert.equal(v.host.querySelector('.tasks-count')!.getAttribute('aria-pressed'), 'true');
  await v.unmount();
  pressed = false;
  await show({});
  const none = await render(h(StatusCounts, { chatId: 'top' }));
  assert.equal(line(none), null);
  await none.unmount();
});

test('a deeper session asking about its PR counts under "needs you", once, while PR inventory stays in its rail', async () => {
  reset();
  Object.assign(rows, { a: 'working', c: 'input' });
  const children = { a: child(), c: child() };
  await show(children);
  const v = await render(h(StatusCounts, { chatId: 'top' }));
  await show(children);
  await act(async () => setPrLine('top', { count: prCount(2, 3), asking: ['c', 'grand'] }));
  assert.equal(line(v), '1 session running·2 sessions need you');
  await click(v.host.querySelector('.tasks-count.waiting') as HTMLButtonElement);
  assert.deepEqual(chatsOpened, ['c']);
  // the grandchild alone still opens; PR inventory alone does not leave a status line
  rows.c = 'done';
  rows.a = 'done';
  await show(children);
  await act(async () => setPrLine('top', { asking: ['grand'] }));
  assert.equal(line(v), '1 session needs you');
  await click(v.host.querySelector('.tasks-count.waiting') as HTMLButtonElement);
  assert.deepEqual(chatsOpened, ['c', 'grand']);
  await act(async () => setPrLine('top', { asking: [] }));
  assert.equal(line(v), null);
  await act(async () => clearPrLine('top'));
  assert.equal(line(v), null);
  await v.unmount();
});

test('the running line carries the same counts after its tasks, or only its tasks with none', async () => {
  reset();
  Object.assign(rows, { a: 'working', c: 'input' });
  const children = { a: child(), c: child() };
  await show(children);
  const v = await render(h(InlineCounts, { chatId: 'top' }));
  await show(children);
  assert.equal(v.host.querySelector('[data-tasks]')?.getAttribute('data-tasks'), 'top');
  assert.equal(v.host.querySelector('.tasks-count-inline')?.textContent, '·1 session running·1 session needs you');
  await act(async () => setPrLine('top', { count: prCount(1) }));
  assert.equal(v.host.querySelector('.tasks-count-inline')?.textContent, '·1 session running·1 session needs you');
  await act(async () => clearPrLine('top'));
  await show({});
  assert.equal(v.host.querySelector('.tasks-count-inline'), null);
  assert.ok(v.host.querySelector('[data-tasks]'));
  await v.unmount();
});
