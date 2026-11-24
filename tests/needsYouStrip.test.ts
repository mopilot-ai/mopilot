// Child requests appear expanded in the parent's transcript, retaining the child's approval and ACP form owner.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, click } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
const store = fakeStore<any>({ threads: { kid: { id: 'kid', cwd: '/repo-wt', title: 'Fix login' } } });
const states: Record<string, string> = {};
let notify: (v: any) => void = () => {};
stubStore({
  useStore: store.useStore,
  // a chat link's ⌥-click (session/openChat.ts)
  openInSplit: () => {},
  navigate: (r: any) => calls.push(['navigate', r]),
  threadTitle: (t: any) => t.title,
});

mock.module('../src/session/useChatRowState.ts', {
  namedExports: { useChatRowState: (id: string) => (states[id] ? { state: states[id] } : null) },
});
mock.module('../src/components/thread/Approvals.tsx', {
  namedExports: { Approvals: (p: any) => h('div', { 'data-stub': 'Approvals', 'data-chat': p.threadId, 'data-cwd': p.cwd }) },
});
installNativeStub({
  orchestration: {
    snapshot: async () => ({ children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} }),
    onChanged: (cb: any) => ((notify = cb), () => {}),
  },
});
mock.module('../src/components/thread/AcpQuestions.tsx', {
  namedExports: {
    AcpQuestions: (p: any) => h('div', { 'data-stub': 'AcpQuestions', 'data-chat': p.threadId, 'data-read-only': p.readOnly }),
  },
});
const { NeedsYouStrip } = await import('../src/components/thread/NeedsYouStrip.tsx');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const child = (o: any) => ({
  parentId: 'top',
  name: 'n',
  title: 'T',
  harness: null,
  useWorktree: true,
  createdAt: 1,
  lastReport: null,
  ...o,
});
// these tests change what the rows read outside the view; an equal view wakes nobody (#5398), so each broadcast carries a new revision
let rev = 0;
const show = (children: any) =>
  act(async () => notify({ children, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {}, rev: ++rev }));
const text = (el: Element | null) => el?.textContent ?? '';

test('each child request is expanded by default, keeps its child owner and disappears when resolved', async () => {
  const v = await render(h(NeedsYouStrip, { threadId: 'top' }));
  await show({});
  assert.equal(v.host.querySelector('.needs-you'), null, 'a chat that started none');
  states.kid = 'approval';
  states.other = 'working';
  states.asks = 'input';
  await show({
    kid: child({ name: 'fix-login', createdAt: 1 }),
    other: child({ name: 'busy', createdAt: 2 }),
    asks: child({ name: 'questions', createdAt: 3 }),
    elsewhere: child({ parentId: 'another', name: 'not-mine' }),
  });
  const rows = [...v.host.querySelectorAll('.needs-you-row')];
  assert.equal(v.host.querySelector('[role="status"]')?.textContent, '2 nested sessions need input');
  assert.deepEqual(
    rows.map((r) => text(r.querySelector('.needs-you-text'))),
    ['Request from Fix login', 'Request from questions'],
  );
  const answer = rows[0].querySelector('[aria-label="Hide request from Fix login"]') as HTMLButtonElement;
  assert.equal(answer.getAttribute('aria-expanded'), 'true');
  const card = v.host.querySelector('[data-stub="Approvals"]') as HTMLElement;
  assert.deepEqual([card.dataset.chat, card.dataset.cwd], ['kid', '/repo-wt']);
  assert.equal(answer.getAttribute('aria-label'), 'Hide request from Fix login');
  assert.equal(v.host.querySelector('[data-stub="AcpQuestions"]')?.getAttribute('data-chat'), 'kid');
  await click(answer);
  assert.equal(rows[0].querySelector('[data-stub="Approvals"]'), null);
  assert.equal(answer.getAttribute('aria-label'), 'Show request from Fix login');
  await click(answer);
  assert.ok(rows[0].querySelector('[data-stub="Approvals"]'));
  await click([...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Open')!);
  assert.deepEqual(calls.splice(0), [['navigate', { name: 'thread', id: 'asks' }]]);
  // the name is a link to the session too
  await click(rows[1].querySelector('.needs-you-name')!);
  assert.deepEqual(calls.splice(0), [['navigate', { name: 'thread', id: 'asks' }]]);
  for (const button of [
    rows[1].querySelector('.needs-you-name')!,
    [...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Open')!,
  ]) {
    await act(async () => void button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true })));
    assert.deepEqual(calls.splice(0), [['navigate', { name: 'thread', id: 'asks' }]]);
  }
  // its cwd unknown to the window: the card still opens, in no folder
  assert.equal((rows[1].querySelector('[data-stub="Approvals"]') as HTMLElement).dataset.cwd, '');
  states.kid = 'working';
  states.asks = 'idle';
  await show({ kid: child({}), asks: child({}) });
  assert.equal(v.host.querySelectorAll('.needs-you-row').length, 0);
  assert.equal(v.host.querySelector('[role="status"]'), null);
  await v.unmount();
});

test('a child whose title and handle are not loaded keeps its stable chat id in request controls', async () => {
  const v = await render(h(NeedsYouStrip, { threadId: 'top' }));
  states.unnamed = 'input';
  await show({ unnamed: child({ name: '' }), grandchild: child({ parentId: 'unnamed', name: 'nested-worker' }) });
  assert.ok(v.host.querySelector('[aria-label="Hide request from unnamed"]'));
  assert.equal(v.host.querySelector('[data-stub="Approvals"]')?.getAttribute('data-chat'), 'unnamed');
  states.grandchild = 'approval';
  await show({ unnamed: child({ name: '' }), grandchild: child({ parentId: 'unnamed', name: 'nested-worker' }) });
  assert.ok(v.host.querySelector('[aria-label="Hide request from nested-worker"]'));
  assert.equal(v.host.querySelectorAll('[data-stub="Approvals"]').length, 2, 'nested workers keep their own request owner');
  states.unnamed = 'working';
  await show({ unnamed: child({ name: '' }), grandchild: child({ parentId: 'unnamed', name: 'nested-worker' }) });
  assert.equal(v.host.querySelector('[role="status"]')?.textContent, '1 nested session needs input');
  await v.rerender(h(NeedsYouStrip, { threadId: 'other-parent' }));
  assert.equal(v.host.querySelector('.needs-you'), null, 'a parent switch retires the old family and its count');
  await v.unmount();
});
