// src/lib/sessionToolCall.ts, src/components/thread/TaskProposalCard.tsx and SessionCard.tsx: a chat's start_session or
// hand_off_to_session call is read on every harness's shape, and a started session is its live card: its state from
// the chat stores and main's linked sessions, what it is doing or how it ended, and a click that opens it.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, click } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
// no token usage known for any chat (the card's SessionUsage reads it)
const store = fakeStore<any>({ runtime: {}, segments: {}, claudeArchived: {}, agentTabs: {} });
let notify: (v: any) => void = () => {};
let view: any = { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
stubStore({
  useStore: store.useStore,
  // a chat link's ⌥-click (session/openChat.ts)
  openInSplit: () => {},
  navigate: (r: any) => calls.push(['navigate', r]),
  toast: (...a: any[]) => calls.push(['toast', ...a]),
  // the suggestion card's (tests/suggestionCard.test.ts), loaded beside this one
  sendOrDraft: async () => true,
  giveBackToComposer: () => {},
  chatKind: () => 'codex',
});
mock.module('../src/session/harness/select.ts', {
  namedExports: { useHarnessModels: () => [], useEffectiveSelection: () => ({ model: null }) },
});
installNativeStub({
  orchestration: {
    snapshot: async () => view,
    onChanged: (cb: any) => ((notify = cb), () => {}),
    child: async (id: string, action: string) => {
      calls.push(['child', id, action]);
      return { status: 'merged', into: 'main', commit: 'abc' };
    },
  },
});
// the chat's row state is the sidebar dot's (tests/sidebarSessionIndicators.test.ts); here it is set by hand
let rowState: any = null;
let parentTurn = 'idle';
let sessionRead: string | undefined;
mock.module('../src/session/useChatRowState.ts', {
  namedExports: {
    useChatRowState: () => rowState && { state: rowState },
    useChatTurn: (id: string | undefined) => ((sessionRead = id), parentTurn),
    retryChatState: async () => {},
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
const { sessionToolCall } = await import('../src/lib/sessionToolCall.ts');
const { TaskProposalCard, TurnSuggestions } = await import('../src/components/thread/TaskProposalCard.tsx');
const { sessionCardState, sessionCaption, STATE_WORD } = await import('../src/components/thread/SessionCard.tsx');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
// boot has told main this window is ready, as in a window that finished starting
markWindowReady();

const result = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const item = (out: unknown, o: any = {}) => ({
  type: 'mcpToolCall',
  id: 'i1',
  server: 'sage_ab12',
  tool: 'start_session',
  status: 'completed',
  arguments: {},
  result: result(out),
  error: null,
  ...o,
});
/** The card's state dot, by kind; null when it shows none. */
const dot = (v: any) => v.host.querySelector('.session-card-dot')?.getAttribute('data-dot') ?? null;
const started = { status: 'started', chat_id: 'kid', name: 'fix-login', title: 'Fix login', worktree: true, context: 'fork' };

test('dependency-waiting and held starts retain their live session card on every harness', () => {
  for (const status of ['waiting', 'held']) {
    for (const shape of [{}, { type: 'dynamicToolCall', server: undefined, tool: 'sage_x/start_session' }]) {
      const call = sessionToolCall(item({ ...started, status }, shape));
      assert.equal(call?.kind, 'started', status);
      assert.equal(call?.kind === 'started' && call.chatId, 'kid');
    }
  }
});

test('a started or proposed session is read on every harness’s shape; anything else is not a card', () => {
  assert.deepEqual(sessionToolCall(item(started)), {
    kind: 'started',
    chatId: 'kid',
    title: 'Fix login',
    name: 'fix-login',
    worktree: true,
    context: 'fork',
    fallback: null,
    error: null,
    queued: 0,
  });
  assert.deepEqual(
    sessionToolCall(item({ ...started, status: 'not_started', worktree: 'yes', context: 3, context_fallback: 'harness_differs' })),
    {
      kind: 'started',
      chatId: 'kid',
      title: 'Fix login',
      name: 'fix-login',
      worktree: false,
      context: '',
      fallback: 'harness_differs',
      error: 'It did not take its brief yet',
      queued: 0,
    },
  );
  assert.equal((sessionToolCall(item({ ...started, status: 'queued', queue_position: 2 })) as any).queued, 2);
  assert.equal((sessionToolCall(item({ ...started, status: 'queued' })) as any).queued, 1);
  assert.equal(
    sessionToolCall(item({ ...started, status: 'not_started', error: 'login_required' }))?.kind === 'started' && 'login_required',
    'login_required',
  );
  assert.deepEqual(
    sessionToolCall(
      item({ status: 'proposed', task_id: 't1', title: 'T', kind: 'offer' }, { server: undefined, tool: 'mcp__sage_x__start_session' }),
    ),
    {
      kind: 'proposed',
      taskId: 't1',
      title: 'T',
      offer: true,
    },
  );
  assert.equal(
    sessionToolCall(item(started, { server: undefined, tool: 'sage_x/hand_off_to_session', type: 'dynamicToolCall' }))?.kind,
    'started',
  );
  for (const it of [
    null,
    { type: 'agentMessage' },
    item(started, { server: 'github' }),
    item(started, { tool: 'list_sessions' }),
    item(started, { tool: 5 }),
    item(started, { status: 'inProgress' }),
    item(started, { error: { message: 'x' } }),
    item(started, { result: { ...result(started), isError: true } }),
    item(started, { result: { content: [{ type: 'text', text: 'not json' }] } }),
    item({ status: 'proposed', task_id: 4 }),
    item({ ...started, chat_id: null }),
    item(null),
  ])
    assert.equal(sessionToolCall(it), null, JSON.stringify(it));
});

const startedCall = (o: any = {}) =>
  sessionToolCall(item({ ...started, ...o })) as Extract<ReturnType<typeof sessionToolCall>, { kind: 'started' }>;
const show = (v: any) => act(async () => notify({ children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {}, ...v }));

test('a started session is its live card: where it runs until it has more to say, and a click opens it', async () => {
  calls.length = 0;
  rowState = null;
  store.setState({ claudeArchived: {} });
  await show({});
  const v = await render(h(TaskProposalCard, { call: startedCall() }));
  const card = v.host.querySelector('.session-card') as HTMLButtonElement;
  // the window has not listed the chat yet: it is starting
  assert.equal(card.dataset.state, 'starting');
  assert.equal(card.getAttribute('aria-label'), 'Open session Fix login (Starting…)');
  assert.equal(v.host.querySelector('.session-card-caption')!.textContent, 'fix-login · in its own worktree, with this conversation');
  assert.ok(v.host.querySelector('.session-card-title.shimmer-text'), 'its title shimmers while it starts');
  await click(card);
  assert.deepEqual(calls, [['navigate', { name: 'thread', id: 'kid' }]]);
  await act(async () => void card.dispatchEvent(new window.MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true })));
  assert.deepEqual(calls.splice(0), Array(2).fill(['navigate', { name: 'thread', id: 'kid' }]));
  // working: the step its task list is on; then done with its report; the title main keeps wins over the call's
  rowState = 'working';
  await show({
    children: { kid: { parentId: 'top', name: 'fix-login', title: 'Fix login now', lastReport: null } },
    plans: {
      kid: {
        items: [
          { content: 'Read the code', status: 'completed' },
          { content: 'Write the fix', status: 'in_progress' },
        ],
      },
    },
  });
  assert.equal(v.host.querySelector('.session-card-caption')!.textContent, 'Write the fix');
  assert.equal(v.host.querySelector('.session-card-title')!.textContent, 'Fix login now');
  rowState = 'done';
  await show({
    children: { kid: { parentId: 'top', title: 'Fix login', lastReport: { how: 'finished', report: 'Fixed it.\nDetails', at: 1 } } },
  });
  // done: the first line of its report, a green dot, and the chevron that opens it is still there
  assert.equal(v.host.querySelector('.session-card-caption')!.textContent, 'Fixed it.');
  assert.equal(card.dataset.state, 'done');
  assert.equal(dot(v), 'done');
  assert.ok(v.host.querySelector('.session-card-end .lucide-chevron-right'));
  assert.equal(v.host.querySelector('.session-card-title.shimmer-text'), null);
  // needs input and failed lead the caption with the word, beside a dot of their own
  rowState = 'approval';
  await show({ plans: { kid: { items: [{ content: 'Push the branch', status: 'in_progress' }] } } });
  assert.equal(v.host.querySelector('.session-card-word.warn')!.textContent, 'Needs input');
  assert.equal(v.host.querySelector('.session-card-caption')!.textContent, 'Needs input · Push the branch');
  assert.equal(dot(v), 'needs');
  rowState = 'failed';
  await show({});
  assert.equal(v.host.querySelector('.session-card-word.danger')!.textContent, 'Failed');
  // with no report yet, the word leads where it runs
  assert.equal(
    v.host.querySelector('.session-card-caption')!.textContent,
    'Failed · fix-login · in its own worktree, with this conversation',
  );
  assert.equal(dot(v), 'failed');
  // idle: no word, a quiet ring
  rowState = 'idle';
  await show({});
  assert.equal(card.dataset.state, 'idle');
  assert.equal(v.host.querySelector('.session-card-word'), null);
  assert.equal(dot(v), 'idle');
  // archived: the archive mark in place of a dot
  await act(async () => store.setState({ claudeArchived: { kid: 1 } }));
  assert.equal(card.dataset.state, 'archived');
  assert.equal(dot(v), null);
  store.setState({ claudeArchived: {} });
  await v.unmount();
  // a worktree session's git facts go under the card, apart from its open
  rowState = 'done';
  const facts = { branch: 'k', base: 'main', ahead: 1, files: 1, added: 1, removed: 0, uncommitted: 0, pr: null, at: 1 };
  const withFacts = await render(h(TaskProposalCard, { call: startedCall() }));
  await show({ children: { kid: { parentId: 'top', title: 'Fix login', lastReport: { how: 'finished', report: 'ok', at: 1 }, facts } } });
  assert.ok(withFacts.host.querySelector('.session-card-group > .session-card + .session-work'));
  await withFacts.unmount();
  // a start whose brief didn't reach it says why
  const notStarted = await render(h(TaskProposalCard, { call: startedCall({ status: 'not_started', error: 'login_required' }) }));
  assert.match(notStarted.host.querySelector('.session-not-started')!.textContent ?? '', /Session not startedFix login/);
  assert.equal(notStarted.host.querySelector('.session-not-started-reason')!.textContent, 'login_required');
  await notStarted.unmount();
  rowState = null;
});

test('the card state follows the row state, the queue, an archive and a failed start, in that order', () => {
  const st = (row: any, o: any = {}) => sessionCardState({ row, queued: false, archived: false, notStarted: false, ...o });
  assert.equal(st('working', { notStarted: true, archived: true }), 'notStarted');
  assert.equal(st('working', { archived: true, queued: true }), 'archived');
  assert.equal(st('working', { queued: true }), 'queued');
  const map: [any, string][] = [
    [null, 'starting'],
    ['approval', 'needsInput'],
    ['input', 'needsInput'],
    ['error', 'failed'],
    ['failed', 'failed'],
    ['working', 'working'],
    ['elsewhereRunning', 'working'],
    ['done', 'done'],
    ['unread', 'idle'],
    ['idle', 'idle'],
    ['elsewhere', 'idle'],
  ];
  for (const [row, state] of map) assert.equal(st(row), state, String(row));
  // a chat the window doesn't list still says how its last turn ended, as main recorded it
  assert.equal(st(null, { report: 'finished' }), 'done');
  assert.equal(st(null, { report: 'failed' }), 'failed');
  assert.equal(st(null, { report: 'lost' }), 'failed');
  assert.equal(st(null, { report: 'stopped' }), 'idle');
  assert.equal(st(null, { report: null }), 'starting');
  // an ended turn that left a question box or a sign-in hand-off waits on the user; a running one does not (#3403)
  for (const row of [null, 'idle', 'done', 'unread', 'failed'] as const) assert.equal(st(row, { asks: true }), 'needsInput', String(row));
  assert.equal(st('working', { asks: true }), 'working');
  assert.equal(st('elsewhereRunning', { asks: true }), 'working');
  assert.equal(st('idle', { asks: true, archived: true }), 'archived');
  assert.equal(STATE_WORD.queued, 'Queued');
});

test('the caption: the step it is on while it works, its report once it ends, its place in line, else where it runs', () => {
  const view: any = {
    children: { a: { lastReport: { how: 'failed', report: 'Broke\nmore' } }, b: { lastReport: null } },
    plans: { a: { items: [{ content: 'Step 2', status: 'in_progress' }] } },
    queue: ['x', 'q'],
  };
  assert.equal(sessionCaption(view, 'a', 'working', 'fb'), 'Step 2');
  assert.equal(sessionCaption(view, 'a', 'needsInput', 'fb'), 'Step 2');
  assert.equal(sessionCaption(view, 'a', 'failed', 'fb'), 'Broke');
  assert.equal(sessionCaption(view, 'a', 'idle', 'fb'), 'Broke');
  assert.equal(sessionCaption(view, 'a', 'archived', 'fb'), 'Broke');
  assert.equal(sessionCaption(view, 'b', 'working', 'fb'), 'fb');
  assert.equal(sessionCaption(view, 'b', 'done', 'fb'), '');
  assert.equal(sessionCaption(view, 'x', 'queued', 'fb'), 'Queued for this session');
  assert.equal(sessionCaption(view, 'q', 'queued', 'fb'), 'Queued for this session');
  assert.equal(sessionCaption({ ...view, children: { a: { lastReport: { how: 'finished', report: ' ' } } } }, 'a', 'done', 'fb'), '');
  // a session waiting on its wrap-up question says the question (#3403)
  const asking = { ...view, wrapUps: { a: { recap: 'r', ask: 'Merge it?', actions: [] } } };
  assert.equal(sessionCaption(asking, 'a', 'needsInput', 'fb'), 'Merge it?');
  assert.equal(sessionCaption(asking, 'a', 'idle', 'fb'), 'Broke');
  // a list from before the user's last message is not the step it is on
  assert.equal(sessionCaption({ ...view, plans: { a: { ...view.plans.a, stale: true } } }, 'a', 'working', 'fb'), 'fb');
});

test('a started card says where it runs, with what context, and why it started fresh', async () => {
  const { startedFallback } = await import('../src/components/thread/TaskProposalCard.tsx');
  assert.equal(startedFallback(startedCall({ worktree: false, context: 'fresh' })), 'fix-login · in this folder, from a brief');
  assert.equal(
    startedFallback(startedCall({ context_fallback: 'harness_cannot_fork' })),
    'fix-login · in its own worktree, fresh with an excerpt: its harness cannot fork a chat',
  );
  assert.equal(startedFallback(startedCall({ context_fallback: 'other' })), 'fix-login · in its own worktree, fresh');
});

test('live cards retain dependency reasons and PR state, with a dot per state but no clock or token counter', async () => {
  rowState = 'working';
  await act(async () => store.setState({ claudeArchived: {} }));
  const v = await render(h(TaskProposalCard, { call: startedCall({ status: 'waiting' }) }));
  const child = {
    parentId: 'top',
    title: 'Fix login',
    name: 'fix-login',
    worked: { ms: 12_000, turns: 1, since: 1 },
    outside: ['unowned.ts'],
    facts: {
      branch: 'k',
      base: 'main',
      ahead: 0,
      files: 1,
      added: 1,
      removed: 0,
      uncommitted: 0,
      pr: { number: 42, state: 'MERGED', url: 'https://github.com/o/r/pull/42' },
      at: 1,
    },
  };
  rowState = 'idle';
  await show({ children: { kid: { ...child, awaitingBrief: true } } });
  assert.equal(v.host.querySelector('.session-card')?.getAttribute('data-state'), 'starting');
  assert.equal(v.host.querySelector('.session-card-caption')?.textContent, 'Writing the brief…');
  assert.ok(v.host.querySelector('.session-card-title.shimmer-text'));
  rowState = 'working';
  await show({ children: { kid: child, api: { name: 'api' } }, waiting: { kid: { after: ['api'], held: null } } });
  assert.equal(v.host.querySelector('.session-card')?.getAttribute('data-state'), 'waiting');
  // waiting its turn is not trouble: a ring, and no word ahead of its reason
  assert.equal(v.host.querySelector('.session-card-caption')?.textContent, 'Waits for api');
  assert.equal(dot(v), 'queued');
  assert.equal(v.host.querySelector('.session-card-usage'), null);
  assert.equal(v.host.querySelector('.session-card-outside')?.textContent, 'Edited outside its paths: unowned.ts');
  await show({ children: { kid: child, api: { name: 'api' } }, waiting: { kid: { after: ['api'], held: { by: 'api', how: 'failed' } } } });
  assert.equal(v.host.querySelector('.session-card')?.getAttribute('data-state'), 'held');
  assert.equal(v.host.querySelector('.session-card-caption')?.textContent, 'Held: api failed');
  assert.equal(dot(v), 'failed');
  for (const state of ['MERGED', 'CLOSED', 'DRAFT', 'OPEN']) {
    rowState = 'done';
    await show({ children: { kid: { ...child, outside: null, facts: { ...child.facts, pr: { ...child.facts.pr, state } } } } });
    const badge = v.host.querySelector('.session-card-pr');
    assert.equal(badge?.getAttribute('data-state'), state.toLowerCase());
    assert.equal(badge?.getAttribute('aria-label'), `PR #42: ${state.toLowerCase()}`);
    assert.ok(badge?.querySelector('svg'));
    assert.equal(v.host.querySelector('.session-card-word'), null);
    assert.equal(v.host.querySelector('.session-card-caption'), null);
    assert.equal(dot(v), 'done');
  }
  rowState = 'working';
  await show({});
  assert.equal(dot(v), 'working');
  rowState = 'idle';
  await show({});
  assert.equal(dot(v), 'idle');
  assert.equal(sessionCardState({ row: null, queued: false, archived: false, notStarted: false, waiting: 'held' }), 'held');
  assert.equal(sessionCaption({ children: {}, plans: {}, queue: [] } as any, 'gone', 'held', 'waits'), 'waits');
  assert.equal(sessionCaption({ children: {}, plans: {}, queue: [] } as any, 'gone', 'archived', 'fb'), '');
  await v.unmount();
  rowState = null;
});

test('Cmd/Ctrl-clicking a copied proposal’s original session stays in this window', async () => {
  calls.length = 0;
  store.setState({ threads: { fork: { id: 'fork' } }, basicHarnesses: [] });
  const v = await render(
    h(TurnSuggestions, { calls: [{ kind: 'proposed', taskId: 'copied', title: 'Fix red main', offer: false }], threadId: 'fork' }),
  );
  await show({
    proposals: {
      copied: {
        parentId: 'original',
        kind: 'own_initiative',
        title: 'Fix red main',
        prompt: 'Fix main',
        status: 'open',
        chatId: null,
        expiresAt: 9e15,
        waiting: false,
        place: 'folder',
      },
    },
  });
  const link = [...v.host.querySelectorAll('button')].find((b) => b.textContent === 'Open original session')!;
  await act(async () => void link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true })));
  assert.deepEqual(calls, [['navigate', { name: 'thread', id: 'original' }]]);
  await v.unmount();
});

test('copied started cards keep navigation and facts but only the original parent can bring work back', async () => {
  rowState = 'done';
  calls.length = 0;
  const facts = { branch: 'child', base: 'original-main', ahead: 2, files: 1, added: 1, removed: 0, uncommitted: 0, pr: null, at: 1 };
  await show({ children: { kid: { parentId: 'original', title: 'Fix login', facts } } });
  const v = await render(h(TaskProposalCard, { call: startedCall(), threadId: 'fork' }));
  assert.equal(v.host.querySelector('.session-work-actions'), null);
  assert.ok(v.host.querySelector('.session-work-facts'));
  await click([...v.host.querySelectorAll('button')].find((b) => b.textContent === 'Open original session')!);
  assert.deepEqual(calls.splice(0), [['navigate', { name: 'thread', id: 'original' }]]);
  await act(
    async () =>
      void v.host
        .querySelector('.side-session-more')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true })),
  );
  assert.deepEqual(calls.splice(0), [['navigate', { name: 'thread', id: 'original' }]]);
  await v.rerender(h(TaskProposalCard, { call: startedCall(), threadId: 'original', readOnly: true }));
  assert.equal(v.host.querySelector('.session-work-actions'), null);
  await v.rerender(h(TaskProposalCard, { call: startedCall(), threadId: 'original' }));
  const merge = [...v.host.querySelectorAll('button')].find((b) => b.textContent === 'Merge into original-main')!;
  assert.ok(merge);
  assert.equal(sessionRead, 'original');
  parentTurn = 'running';
  await v.rerender(h(TaskProposalCard, { call: startedCall(), threadId: 'original' }));
  assert.equal(merge.disabled, true);
  parentTurn = 'idle';
  await v.rerender(h(TaskProposalCard, { call: startedCall(), threadId: 'original' }));
  assert.equal(merge.disabled, false);
  await click(merge);
  assert.deepEqual(calls.splice(0), [['child', 'kid', 'merge']]);
  await v.rerender(h(TaskProposalCard, { call: startedCall() }));
  assert.equal(v.host.querySelector('.session-work-actions'), null, 'unknown viewing context cannot inherit the parent’s actions');
  await v.rerender(h(TaskProposalCard, { call: startedCall(), threadId: 'fork' }));
  await show({ children: { kid: { parentId: 'original', title: 'Fix login' } } });
  assert.ok(
    [...v.host.querySelectorAll('button')].find((b) => b.textContent === 'Open original session'),
    'provenance survives without git facts',
  );
  await v.unmount();
  rowState = null;
});
