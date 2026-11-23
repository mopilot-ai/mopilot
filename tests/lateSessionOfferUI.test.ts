// Title-only offers remain visible through briefing; a late acceptance creates human intent and preserves refused input for retry.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, click, flush } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
const { createElement: h, act } = await import('react');
const calls: any[] = [];
const store = fakeStore<any>({
  archived: [],
  claudeArchived: {},
  agentTabs: {},
  runtime: {},
  segments: {},
  basicHarnesses: [],
  threads: { top: { cwd: '/repo' } },
});
let sendAnswer: boolean | undefined;
let sendFail: Error | null = null;
let taskAnswer: any;
let notify: (view: any) => void = () => {};
stubStore(
  {
    useStore: store.useStore,
    // a chat link's ⌥-click (session/openChat.ts)
    openInSplit: () => {},
    chatKind: () => 'codex',
    navigate: (route: any) => calls.push(['navigate', route]),
    giveBackToComposer: (...args: any[]) => calls.push(['draft', ...args]),
    toast: (...args: any[]) => calls.push(['toast', ...args]),
    sendOrDraft: async (...args: any[]) => {
      calls.push(['send', ...args]);
      if (sendFail) throw sendFail;
      return sendAnswer;
    },
  },
  {
    'src/store/core.ts': { setPrefs: () => {} },
  },
);
mock.module('../src/lib/flags.ts', { namedExports: { useEnabledHarnesses: () => ['codex', 'claude'] } });
mock.module('../src/session/harness/select.ts', {
  namedExports: { useHarnessModels: () => [], useEffectiveSelection: () => ({ model: null }) },
});
mock.module('../src/session/useChatRowState.ts', {
  namedExports: { useChatRowState: () => ({ state: 'working' }), useChatTurn: () => 'idle', retryChatState: async () => {} },
});
installNativeStub({
  git: { branches: async () => ({ current: 'main', default: 'main', branches: ['main'], commits: true }) },
  orchestration: {
    snapshot: async () => ({ children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} }),
    onChanged: (cb: any) => {
      notify = cb;
      return () => {};
    },
    task: async (id: string, action: string) => {
      calls.push(['task', id, action]);
      return taskAnswer;
    },
  },
});
mock.module('../src/components/ui/Popover.tsx', {
  namedExports: {
    Popover: (p: any) =>
      p.open
        ? h(
            'div',
            { 'data-popover': p.placement },
            p.children,
            h('button', { 'aria-label': 'Close start options', onClick: p.onClose }, 'Close'),
          )
        : null,
  },
});
const { TurnSuggestions, briefPrompt } = await import('../src/components/thread/SuggestionCard.tsx');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();
const proposal = (over: any = {}) => ({
  parentId: 'top',
  kind: 'offer',
  title: 'Docs',
  prompt: '',
  status: 'open',
  chatId: null,
  expiresAt: 9e15,
  waiting: false,
  place: 'worktree',
  ...over,
});
const show = (proposals: any) => act(async () => notify({ children: {}, deliveries: {}, proposals, queue: [], plans: {}, wrapUps: {} }));
const call = (taskId: string | null, title: string, offer = false) => ({ kind: 'proposed' as const, taskId, title, offer });
const text = (element: Element | null) => element?.textContent ?? '';
test('a title-only offer keeps its card while briefing and after the final proposal fill', async () => {
  const { turnProposals } = await import('../src/lib/sessionToolCall.ts');
  const offered = {
    type: 'mcpToolCall',
    server: 'sage_t',
    tool: 'start_session',
    status: 'completed',
    result: { content: [{ type: 'text', text: JSON.stringify({ status: 'briefing', task_id: 'brief', chat_id: 'kid', title: 'Docs' }) }] },
  };
  const offeredCalls = turnProposals([offered]);
  const v = await render(h(TurnSuggestions, { calls: offeredCalls, threadId: 'top' }));
  await show({ brief: proposal({ kind: 'offer', title: 'Docs', status: 'briefing', chatId: 'kid' }) });
  assert.equal(text(v.host.querySelector('.suggest-row-status-label')), 'Writing the brief…');
  assert.ok(v.host.querySelector('.suggest-row-title.shimmer-text'));
  await v.rerender(h(TurnSuggestions, { calls: offeredCalls, threadId: 'top', readOnly: true }));
  assert.equal(v.host.querySelector('.suggest-row-status button'), null);
  const filled = {
    ...offered,
    result: { content: [{ type: 'text', text: JSON.stringify({ status: 'started', task_id: 'brief', chat_id: 'kid', title: 'Docs' }) }] },
  };
  const finalCalls = turnProposals([offered, filled]);
  assert.equal(finalCalls.length, 1);
  await v.rerender(h(TurnSuggestions, { calls: finalCalls, threadId: 'top' }));
  await show({ brief: proposal({ title: 'Docs', status: 'started', chatId: 'kid' }) });
  assert.equal(v.host.querySelectorAll('.session-card').length, 1);
  await v.unmount();
});

test('a late accepted title offer asks its parent for the brief as human intent and retains retryable input', async () => {
  calls.length = 0;
  taskAnswer = { status: 'briefing', answered: false, task_id: 'late' };
  const v = await render(h(TurnSuggestions, { calls: [call('late', 'Docs', true)], threadId: 'top' }));
  await show({ late: proposal({ kind: 'offer', title: 'Docs' }) });
  const start = [...v.host.querySelectorAll('.suggest-row-actions button')].find((b) => b.textContent?.startsWith('New session'))!;
  await click(start);
  await flush();
  assert.deepEqual(calls.splice(0), [
    ['task', 'late', 'start'],
    ['send', 'top', briefPrompt('late', 'Docs'), { human: true }],
  ]);
  await show({ late: proposal({ kind: 'offer', title: 'Docs', status: 'briefing', chatId: 'kid' }) });
  const retry = () => v.host.querySelector('.suggest-row-status button')!;
  sendAnswer = false;
  await click(retry());
  await flush();
  assert.deepEqual(calls.splice(0), [['send', 'top', briefPrompt('late', 'Docs'), { human: true }]]);
  assert.match(text(v.host.querySelector('.suggest-row-status')), /Your request is kept in the composer/);
  sendFail = new Error('chat closed');
  await click(retry());
  await flush();
  assert.deepEqual(calls.splice(0), [
    ['send', 'top', briefPrompt('late', 'Docs'), { human: true }],
    ['draft', 'top', briefPrompt('late', 'Docs')],
    ['toast', 'chat closed', 'error'],
  ]);
  sendFail = null;
  sendAnswer = true;
  await click(retry());
  await flush();
  assert.deepEqual(calls.splice(0), [['send', 'top', briefPrompt('late', 'Docs'), { human: true }]]);
  assert.doesNotMatch(text(v.host.querySelector('.suggest-row-status')), /kept in the composer/);
  await act(async () => store.set({ runtime: { top: { activeTurnId: 'writing-brief' } } }));
  assert.equal(retry(), null);
  await v.unmount();
  store.set({ runtime: {} });
  taskAnswer = { status: 'briefing', answered: true };
  const waiting = await render(h(TurnSuggestions, { calls: [call('waiting', 'Docs', true)], threadId: 'top' }));
  await show({ waiting: proposal({ kind: 'offer', title: 'Docs', waiting: true }) });
  await click([...waiting.host.querySelectorAll('.suggest-row-actions button')].find((b) => b.textContent?.startsWith('New session'))!);
  await flush();
  assert.deepEqual(calls.splice(0), [['task', 'waiting', 'start']]);
  await waiting.unmount();
  taskAnswer = undefined;
  sendAnswer = undefined;
});

test('copied foreign proposals are historical: no starts, keys, settings or brief messages can escape their original parent', async () => {
  calls.length = 0;
  const data = {
    foreign: proposal({ parentId: 'original', title: 'Foreign offer', waiting: true }),
    second: proposal({ parentId: 'original', title: 'Foreign proposal', kind: 'own_initiative' }),
  };
  const v = await render(
    h(TurnSuggestions, { calls: [call('foreign', 'Foreign offer', true), call('second', 'Foreign proposal')], threadId: 'top' }),
  );
  await show(data);
  assert.equal(v.host.querySelectorAll('.suggest-row-actions').length, 0);
  assert.equal(v.host.querySelector('.suggest-start-all'), null);
  const origins = [...v.host.querySelectorAll('button')].filter((b) => b.textContent === 'Open original session');
  assert.equal(origins.length, 2);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.deepEqual(calls, []);
  await click(origins[0]);
  assert.deepEqual(calls.splice(0), [['navigate', { name: 'thread', id: 'original' }]]);
  await show({ ...data, foreign: { ...data.foreign, status: 'briefing', chatId: 'old-child' } });
  assert.equal(v.host.querySelector('.suggest-row-status button'), null);
  assert.equal(v.host.querySelector('.start-options'), null);
  await v.unmount();
});
