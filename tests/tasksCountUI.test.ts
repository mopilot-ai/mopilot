// The running-tasks count in the turn's status line and the Stop all question (src/components/tasks/TasksPill.tsx), rendered
// with the real task store and fake app and session stores.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveTypeScale } from './support/app-css.ts';
import { window } from './support/dom.ts';
import { fakeStore, iconStubs, mockSource, taggedIcon, stubStore, stubSlice } from './support/stubs.ts';
import { createElement as h, act, useEffect } from 'react';

const app = fakeStore<any>({ paneTabs: [], paneActive: '', diffPanel: { open: false }, runtime: {} });
const sessions = fakeStore<any>({});
const EMPTY = { tasks: [], approvals: [] };
const calls: any[][] = [];
const rec =
  (name: string) =>
  (...a: any[]) => {
    calls.push([name, ...a]);
  };
stubStore({ useStore: app.useStore, setState: app.setState, stopAllTasks: rec('stopAllTasks') });
stubSlice('src/store/panes.ts', { openAgentPage: rec('openAgentPage'), toggleTasksPane: rec('toggleTasksPane') });
mockSource('src/store/session/useSession.ts', {
  useSession: (id: string) => sessions.useStore((s: any) => (id && s[id]) || EMPTY),
  useSessionField: (id: any, pick: any) =>
    pick((((id: string) => sessions.useStore((s: any) => (id && s[id]) || EMPTY)) as (id: any) => any)(id)),
});
mockSource('src/components/markdown/Markdown.tsx', { CodeBlock: () => null });
mockSource('src/components/ui/Presence.tsx', { Collapse: ({ open, children }: any) => (open ? children : null) });
mockSource('src/components/ui/icons.tsx', iconStubs(taggedIcon));

const { createRoot } = await import('react-dom/client');
const { InlineTasksCount, StopAllConfirm, TasksStatusRow, useRunningCalls, useTasksPill, pillShown } = await import(
  '../src/components/tasks/TasksPill.tsx'
);
const { FINISHED_HOLD_MS } = await import('../src/lib/tasks.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const task = (id: string, o: object = {}): any => ({ id, type: 'local_bash', description: id, status: 'running', toolUseId: null, ...o });

async function mount(el: any) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(() => root.render(el));
  return {
    host,
    $: (s: string) => host.querySelector(s) as any,
    unmount: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}
const click = (el: any) => act(() => el.click());
const setTasks = (chat: string, tasks: any[]) => act(() => sessions.set({ [chat]: { tasks, approvals: [] } }));
const setChat = (chat: string, tasks: any[], approvals: any[]) => act(() => sessions.set({ [chat]: { tasks, approvals } }));
const text = (el: any) => el?.textContent ?? '';
const byText = (host: any, sel: string, t: string) => [...host.querySelectorAll(sel)].find((e: any) => e.textContent === t) as any;

beforeEach(() => {
  calls.length = 0;
  app.reset({ paneTabs: [], paneActive: '', diffPanel: { open: false }, runtime: {} });
});

test('the count is a 20 px ghost button in the 12 px status line, with no border or pill', async () => {
  const style = window.document.createElement('style');
  // the rule reads the type scale, and jsdom substitutes no custom property, so resolve the steps first
  style.textContent = resolveTypeScale(readFileSync(new URL('../src/styles/tasks-pane.css', import.meta.url), 'utf8'));
  window.document.head.appendChild(style);
  await setTasks('position', [task('a')]);
  const v = await mount(h(TasksStatusRow, { chatId: 'position' }));
  try {
    const row = window.getComputedStyle(v.$('.tasks-status-row'));
    const count = v.$('.tasks-count');
    const button = window.getComputedStyle(count);
    assert.equal(v.$('.tasks-status-row').getAttribute('role'), 'status');
    assert.equal(row.display, 'flex');
    // --fs-small, the scale's step for a status line: 11.998px at the shipped 14px default (src/styles/tokens.css)
    assert.ok(Math.abs(Number.parseFloat(row.fontSize) - 12) < 0.01, row.fontSize);
    // a floor, not a pin: a line of counts wraps once a zoomed pane is too narrow for it
    assert.equal(row.minHeight, '20px');
    assert.equal(row.height, '');
    // a floor, not a pin: the button grows with the count's type at the larger Chat sizes
    assert.equal(button.minHeight, '20px');
    assert.equal(button.height, '');
    assert.equal(button.borderTopWidth, '0px');
    assert.equal(button.backgroundColor, 'transparent');
    assert.equal(button.borderRadius, '5px');
    const label = window.getComputedStyle(count.querySelector('.morph-text'));
    assert.equal(Number.parseFloat(label.minWidth), 0);
    assert.equal(label.overflow, 'hidden');
    assert.equal(count.querySelector('[data-icon]'), null);
    assert.equal(count.title, 'View background tasks');
    await click(count);
    assert.deepEqual(calls, [['toggleTasksPane', 'position']]);
  } finally {
    await v.unmount();
    style.remove();
  }
});

test('the count says how many run, lingers "N tasks finished" for 1.5 s, and toggles the tab', async () => {
  const v = await mount(h(TasksStatusRow, { chatId: 'p1' }));
  assert.equal(v.host.innerHTML, '');
  await setTasks('p1', [task('a'), task('b'), task('c', { status: 'completed' })]);
  assert.equal(text(v.$('.tasks-count')), '2 running tasks');
  assert.equal(v.$('.tasks-count').getAttribute('aria-pressed'), 'false');
  await click(v.$('.tasks-count'));
  assert.deepEqual(calls, [['toggleTasksPane', 'p1']]);
  await setTasks('p1', [task('a'), task('b', { status: 'completed' })]);
  assert.equal(text(v.$('.tasks-count .morph-layer:not(.morph-out)')), '1 running task');
  await setTasks('p1', [task('a', { status: 'stopped' })]);
  assert.equal(text(v.$('.tasks-count .morph-layer:not(.morph-out)')), '1 task finished');
  // running again before the hold ends shows the count at once
  await setTasks('p1', [task('a'), task('d')]);
  assert.equal(text(v.$('.tasks-count .morph-layer:not(.morph-out)')), '2 running tasks');
  await setTasks('p1', []);
  assert.equal(text(v.$('.tasks-count .morph-layer:not(.morph-out)')), '2 tasks finished');
  await act(() => sleep(FINISHED_HOLD_MS + 100));
  assert.equal(v.host.innerHTML, '');
  await v.unmount();
});

test('in a running turn the count follows the clock after a separator, and is absent with no tasks', async () => {
  const v = await mount(h(InlineTasksCount, { chatId: 'i1' }));
  assert.equal(v.host.innerHTML, '');
  await setTasks('i1', [task('a')]);
  const inline = v.$('.tasks-count-inline');
  assert.equal(text(inline.querySelector('.tasks-count-sep')), '·');
  assert.equal(inline.querySelector('.tasks-count-sep').getAttribute('aria-hidden'), 'true');
  assert.equal(text(inline.querySelector('.tasks-count')), '1 running task');
  await v.unmount();
});

test('the count goes from running to finished without a render that hides it in between', async () => {
  const shown: boolean[] = [];
  function Probe() {
    // what was committed to the screen, not render passes React throws away
    const visible = pillShown(useTasksPill('p4'));
    useEffect(() => void shown.push(visible));
    return null;
  }
  await setTasks('p4', [task('a')]);
  const v = await mount(h(Probe));
  await setTasks('p4', [task('a', { status: 'completed' })]);
  assert.deepEqual(new Set(shown), new Set([true]));
  await act(() => sleep(FINISHED_HOLD_MS + 100));
  assert.equal(shown.at(-1), false);
  await v.unmount();
});

test("the count is pressed while this chat's tasks tab is in front", async () => {
  await setTasks('p2', [task('a')]);
  const v = await mount(h(TasksStatusRow, { chatId: 'p2' }));
  const pressed = () => v.$('.tasks-count').getAttribute('aria-pressed');
  await act(() => app.set({ paneTabs: [{ id: 'T', kind: 'tasks', threadId: 'p2' }], paneActive: 'T', diffPanel: { open: true } }));
  assert.equal(pressed(), 'true');
  await act(() => app.set({ paneTabs: [{ id: 'T', kind: 'tasks', threadId: 'other' }] }));
  assert.equal(pressed(), 'false');
  await act(() => app.set({ paneTabs: [{ id: 'T', kind: 'tasks', threadId: 'p2' }], paneActive: 'X' }));
  assert.equal(pressed(), 'false');
  await act(() => app.set({ paneActive: 'T', diffPanel: { open: false } }));
  assert.equal(pressed(), 'false');
  await act(() => app.set({ paneTabs: [], diffPanel: { open: true } }));
  assert.equal(pressed(), 'false');
  await v.unmount();
});

test('the Esc-Esc question: Cancel closes it, Stop all stops every task of the chat', async () => {
  const set: boolean[] = [];
  const v = await mount(h(StopAllConfirm, { chatId: 'p3', running: 2, setConfirm: (b: boolean) => set.push(b) }));
  assert.equal(text(v.$('.queued-text')), 'Stop all 2 background tasks?');
  await click(byText(v.host, 'button', 'Cancel'));
  assert.deepEqual(set, [false]);
  assert.deepEqual(calls, []);
  await click(byText(v.host, 'button', 'Stop all'));
  assert.deepEqual(set, [false, false]);
  assert.deepEqual(calls, [['stopAllTasks', 'p3']]);
  await v.unmount();
});

test('the calls whose background task still runs: one set, kept while the list is the same', async () => {
  const seen: ReadonlySet<string>[] = [];
  function Probe() {
    seen.push(useRunningCalls('rc'));
    return null;
  }
  const v = await mount(h(Probe));
  assert.deepEqual([...seen.at(-1)!], []);
  await setTasks('rc', [task('a', { toolUseId: 'tu1' }), task('b'), task('c', { toolUseId: 'tu3', status: 'completed' })]);
  assert.deepEqual([...seen.at(-1)!], ['tu1']);
  const first = seen.at(-1);
  // another render with the same running calls hands back the same set
  await setTasks('rc', [task('a', { toolUseId: 'tu1', description: 'renamed' })]);
  assert.equal(seen.at(-1), first);
  await setTasks('rc', [task('a', { toolUseId: 'tu1', status: 'completed' })]);
  assert.deepEqual([...seen.at(-1)!], []);
  await v.unmount();
});

test('a task parked on an approval is counted apart from the ones still working', async () => {
  const tasks = [task('a'), task('b'), task('c'), task('d', { agentKey: 'thread-9' })];
  // Claude names the agent on the approval; Codex names the agent's thread
  const parked = [{ params: { agentID: 'c' } }, { params: { threadId: 'thread-9' } }];
  await setChat('split', tasks, parked);
  const v = await mount(h(TasksStatusRow, { chatId: 'split' }));
  try {
    assert.deepEqual([...v.host.querySelectorAll('.tasks-count')].map(text), ['2 running tasks', '2 need you']);
    const waiting = v.$('.tasks-count.waiting');
    assert.equal(waiting.title, 'View the tasks waiting for you');
    await click(waiting);
    assert.deepEqual(calls, [['toggleTasksPane', 'split']]);
    // answered in another window: the count is derived every render, so nothing stale keeps claiming they wait
    await setChat('split', tasks, []);
    assert.equal(v.$('.tasks-count.waiting'), null);
    assert.equal(text(v.$('.tasks-count .morph-layer:not(.morph-out)')), '4 running tasks');
    // all four parked: the running half goes rather than reading "0 running tasks"
    await setChat('split', tasks, [...parked, { params: { agentID: 'a' } }, { params: { agentID: 'b' } }]);
    assert.equal(v.$('.tasks-count:not(.waiting)'), null);
    assert.equal(text(v.$('.tasks-count.waiting .morph-layer:not(.morph-out)')), '4 need you');
    // and the pill still shows at all, though nothing is working
    assert.ok(v.$('.tasks-count.waiting'));
    // one of each reads in the singular on both halves
    await setChat('split', [task('a'), task('c')], [{ params: { agentID: 'c' } }]);
    assert.deepEqual([...v.host.querySelectorAll('.tasks-count .morph-layer:not(.morph-out)')].map(text), [
      '1 running task',
      '1 needs you',
    ]);
  } finally {
    await v.unmount();
  }
});

test('more counts after it share the status line: shown alone with no tasks, after a separator with them', async () => {
  const extra = h('button', { className: 'tasks-count', 'data-extra': '' }, '2 sessions running');
  const alone = await mount(h(TasksStatusRow, { chatId: 'quiet', extra }));
  assert.equal(text(alone.$('.tasks-status-row')), '2 sessions running');
  assert.equal(alone.$('.tasks-count-sep'), null);
  await alone.unmount();
  await setTasks('busy', [task('t1')]);
  const both = await mount(h(TasksStatusRow, { chatId: 'busy', extra }));
  assert.equal(text(both.$('.tasks-status-row')), '1 running task·2 sessions running');
  await both.unmount();
  // nothing to count and no extra: no line
  const none = await mount(h(TasksStatusRow, { chatId: 'quiet' }));
  assert.equal(none.$('.tasks-status-row'), null);
  await none.unmount();
});
