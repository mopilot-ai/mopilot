// MoMo's four-tab Tasks panel names a channel's waiting card by its channel (A2, #4846; src/components/momo/tasks/taskCopy.ts, TaskRow.tsx): the row's grey line starts with #name and Review opens that channel's own chat; a card of Main has no such name and opens Main's page.
import './support/tz-la.ts';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { mockSource } from './support/stubs.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { calls: [], answer: null };
mockSource('src/store/panes.ts', { navigate: (r: any) => f.calls.push(['navigate', r]) });
mock.module('../src/store/send.ts', { namedExports: { sendMessage: async () => undefined } });
installNativeStub({
  momoTasks: { list: async () => f.answer(), mark: async () => ({ ok: true }), onChanged: () => () => undefined },
  momoMemory: { loopAct: async () => ({ ok: true, loop: {} }), onChanged: () => () => undefined },
  momoRoutines: { edit: async () => ({ ok: true }) },
  momoPrefs: { set: async () => true },
  // suggestions are off here (the panel then shows the tasks alone)
  momoSuggestions: {
    list: async () => ({ ok: false, reason: 'unavailable' }),
    act: async () => ({ ok: false, reason: 'unavailable' }),
    onChanged: () => () => undefined,
  },
});
const { TasksPanel } = await import('../src/components/momo/tasks/TasksPanel.tsx');
const { lineOf } = await import('../src/components/momo/tasks/taskCopy.ts');

const NOW = new Date(2026, 10, 15, 12, 0).getTime();
const row = (over: any) => ({
  id: 'x',
  kind: 'card',
  tab: 'active',
  state: 'needs-you',
  title: 'T',
  detail: null,
  at: null,
  dueAt: null,
  dueDay: null,
  ref: 'x',
  outcome: null,
  nextAt: null,
  paused: false,
  ...over,
});
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

test('the panel names a channel’s card by its channel and Review opens that channel’s chat; Main’s card opens Main', async () => {
  const kitchen = row({
    id: 'card:ch_1:a9',
    title: 'Order the oven',
    detail: 'Mail',
    ref: 'a9',
    channel: { id: 'ch_1', name: 'Kitchen' },
    chatId: 'chat-kitchen',
  });
  const main = row({ id: 'card:a1', title: 'Send the mail', detail: 'Mail', ref: 'a1' });
  assert.equal(lineOf(kitchen, NOW), '#Kitchen · Mail');
  assert.equal(lineOf(main, NOW), 'Mail');
  f.calls = [];
  f.answer = async () => ({ ok: true, v: 2, tasks: [kitchen, main], paused: false, now: NOW });
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(TasksPanel)));
  await flush();
  const reviewIn = (id: string) =>
    [...(host as any).querySelectorAll(`[data-task="${id}"] button`)].find((b: any) => b.textContent === 'Review');
  await act(async () => reviewIn('card:ch_1:a9').click());
  await act(async () => reviewIn('card:a1').click());
  assert.deepEqual(
    f.calls.filter((c: any) => c[0] === 'navigate'),
    [
      ['navigate', { name: 'momo', tab: 'chat', chatId: 'chat-kitchen' }],
      ['navigate', { name: 'momo', tab: 'chat' }],
    ],
  );
  await act(async () => root.unmount());
});
