// src/components/thread/TurnBox.tsx: a chat's own task list (as Claude Desktop's turn box: no header, twelve steps at
// a time, "Plan from before your last message" until the agent updates it, gone after a turn that finished it) and its
// wrap-up box, which takes the list's place, under the latest message; an answer goes as the user's own reply; a
// read-only view offers none; nothing shows for a chat with neither.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, flush } from './support/pages-kit.ts';
import { mockTsx } from './support/composer-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore, stubSlice } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
let notify: (v: any) => void = () => {};
let sendFails = false;
let authoredInputs: Record<string, Record<string, { by: 'momo'; title: string; at: number }>> = {};
let momoChats: Record<string, string> = {};
stubStore({
  useStore: (sel: (s: any) => unknown) => sel({ authoredInputs, momoChats }),
  stopAllTasks: async () => {},
  sendOrDraft: async (...a: any[]) => {
    calls.push(['send', ...a]);
    if (sendFails) throw new Error('main gone');
  },
});
const asked: string[] = [];
installNativeStub({
  orchestration: { snapshot: async () => undefined, onChanged: (cb: any) => ((notify = cb), () => {}) },
  session: { snapshot: async (id: string) => (asked.push(id), null), onPatch: () => {} },
});
mockTsx(new URL('../src/components/thread/Items.tsx', import.meta.url), {
  TodoSteps: ({ steps, active }: any) =>
    h('div', { 'data-stub': 'TodoPlan', 'data-steps': JSON.stringify(steps), 'data-active': String(active) }),
});
// Keep the real task-count hook and its approval classification; isolate only task inventory and pane actions.
let useSessionsLate: any = () => [];
mockTsx(new URL('../src/components/tasks/TaskList.tsx', import.meta.url), {
  useChatTasks: (id: string) => useSessionsLate((st: any) => st.sessions[id]?.tasks ?? EMPTY_SESSION.tasks),
});
stubSlice('src/store/panes.ts', { toggleTasksPane: () => {} });
const { TurnBox, stepWindow } = await import('../src/components/thread/TurnBox.tsx');
const { useSessions } = await import('../src/store/session/useSession.ts');
useSessionsLate = useSessions;
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');

const view = (plans: any = {}, wrapUps: any = {}, children: any = {}) => ({
  children,
  deliveries: {},
  proposals: {},
  queue: [],
  plans,
  wrapUps,
});
const turn = (status = 'inProgress', extra: any = {}) => ({ id: 't1', status, items: [], ...extra }) as any;
const running = [turn()];
const items = [
  { content: 'Read', status: 'completed' },
  { content: 'Write', status: 'in_progress' },
  { content: 'Test', status: 'pending' },
];

test('the task list shows in a headerless card, live while a step is open', async () => {
  const v = await render(h(TurnBox, { threadId: 'top', turns: running }));
  await flush();
  assert.equal(v.host.innerHTML, '', 'nothing for a chat with neither');
  await act(async () => notify(view({ top: { items, stale: false } })));
  assert.ok(v.host.querySelector('.turn-box.with-tasks'));
  const plan = v.host.querySelector('.turn-tasks [data-stub="TodoPlan"]') as HTMLElement;
  assert.deepEqual(JSON.parse(plan.dataset.steps!), [
    { step: 'Read', status: 'completed' },
    { step: 'Write', status: 'inProgress' },
    { step: 'Test', status: 'pending' },
  ]);
  assert.equal(plan.dataset.active, 'true');
  assert.equal(v.host.querySelector('.todo-head'), null, 'no "N out of M" header, as Claude Code');
  assert.equal(v.host.querySelector('.turn-tasks-more'), null, 'a short list shows whole');
  await act(async () => notify(view({ top: { items: items.map((s) => ({ ...s, status: 'completed' })), stale: false } })));
  assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'false');
  await act(async () => notify(view({ other: { items, stale: false } })));
  assert.equal(v.host.innerHTML, '', 'another chat’s list is not this one’s');
});

test('a long list shows twelve steps from the one before the open step, counting the rest', async () => {
  const many = (open: number) =>
    Array.from({ length: 16 }, (_, i) => ({
      content: `s${i + 1}`,
      status: i < open ? 'completed' : i === open ? 'in_progress' : 'pending',
    }));
  const v = await render(h(TurnBox, { threadId: 'top', turns: running }));
  await act(async () => notify(view({ top: { items: many(1), stale: false } })));
  const shown = () => JSON.parse((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.steps!).map((s: any) => s.step);
  const notes = () => [...v.host.querySelectorAll('.turn-tasks-more')].map((p) => p.querySelector('span')?.textContent ?? p.textContent);
  assert.deepEqual(shown(), ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12']);
  assert.deepEqual(notes(), ['4 more to go']);
  await act(async () => notify(view({ top: { items: many(6), stale: false } })));
  // never fewer than twelve shown: the window stops at the end of the list
  assert.deepEqual([shown()[0], shown().length], ['s5', 12]);
  assert.deepEqual(notes(), ['4 earlier steps']);
  await act(async () => notify(view({ top: { items: many(3), stale: false } })));
  assert.deepEqual(notes(), ['2 earlier steps', '2 more to go']);
  // the window is the reference's: done steps after it are not "to go"; one earlier step reads singular
  const done = { status: 'completed' };
  assert.deepEqual(stepWindow([done, done, { status: 'inProgress' }, done, done], 2), {
    visible: [done, { status: 'inProgress' }],
    hiddenBefore: 1,
    openAfter: 0,
  });
  await act(async () => notify(view({ top: { items: many(2), stale: false } })));
  assert.deepEqual(notes(), ['1 earlier step', '3 more to go']);
  // no step open: the window starts before the first one left; all done, it ends at the last
  assert.equal(stepWindow([{ status: 'completed' }, { status: 'completed' }, { status: 'pending' }], 2).hiddenBefore, 1);
  assert.equal(stepWindow([{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }], 2).hiddenBefore, 1);
});

test('the wrap-up box shows the recap and question; an answer is the user’s reply, its message or its label', async () => {
  calls.length = 0;
  const v = await render(h(TurnBox, { threadId: 'top', turns: running }));
  await act(async () =>
    notify(
      view(
        { top: { items, stale: false } },
        {
          top: {
            recap: 'Done; not pushed.',
            ask: 'Push it?',
            actions: [
              { label: 'Push', message: 'Push the branch' },
              { label: 'Not now', message: null },
            ],
          },
        },
      ),
    ),
  );
  // the wrap-up box takes the list's place, as in Claude Code
  assert.equal(v.host.querySelector('[data-stub="TodoPlan"]'), null);
  assert.equal(v.host.querySelector('.wrap-up-recap')!.textContent, 'Done; not pushed.');
  assert.equal(v.host.querySelector('.wrap-up-question')!.textContent, 'Push it?');
  const buttons = [...v.host.querySelectorAll('.wrap-up-actions button')] as HTMLButtonElement[];
  assert.deepEqual(
    buttons.map((b) => [b.textContent, b.className]),
    [
      ['Push', 'btn-pill'],
      ['Not now', 'btn-pill soft'],
    ],
  );
  await click(buttons[0]);
  // answered: the buttons go, so a reply waiting behind a busy turn is not sent twice
  assert.equal(v.host.querySelector('.wrap-up-actions'), null);
  assert.equal(v.host.querySelector('.wrap-up-sent')!.textContent, 'Sent');
  // a new box (the next turn's) has its own answers
  await act(async () => notify(view({}, { top: { recap: 'Next.', ask: 'Push it?', actions: [{ label: 'Not now', message: null }] } })));
  sendFails = true;
  await click(v.host.querySelector('.wrap-up-actions button')!);
  await flush();
  sendFails = false;
  assert.deepEqual(calls, [
    // the agent's message behind a label is not the user's words; a label sent as it reads is
    ['send', 'top', 'Push the branch', { human: false }],
    ['send', 'top', 'Not now', { human: true }],
  ]);
});

test('a recap alone shows no question; a read-only view shows the question without answers', async () => {
  const v = await render(h(TurnBox, { threadId: 'top', readOnly: true }));
  await act(async () => notify(view({}, { top: { recap: 'Just a recap.', ask: null, actions: [] } })));
  assert.equal(v.host.querySelector('.turn-box.with-tasks'), null);
  assert.equal(v.host.querySelector('[data-stub="TodoPlan"]'), null);
  assert.equal(v.host.querySelector('.wrap-up-ask'), null);
  await act(async () => notify(view({}, { top: { recap: 'r', ask: 'Go?', actions: [{ label: 'Yes', message: null }] } })));
  assert.equal(v.host.querySelector('.wrap-up-question')!.textContent, 'Go?');
  assert.equal(v.host.querySelector('.wrap-up-actions'), null);
  const open = await render(h(TurnBox, { threadId: 'top' }));
  await act(async () => notify(view({}, { top: { recap: 'r', ask: 'Go?', actions: [] } })));
  assert.equal(open.host.querySelector('.wrap-up-actions'), null, 'a question with no answers offers none');
});

test('the latest turn’s native plan shows in the box, in place of an agent’s list; the wrap-up takes its place', async () => {
  const plan = {
    explanation: null,
    steps: [
      { step: 'Plan', status: 'completed' },
      { step: 'Build', status: 'inProgress' },
    ],
  } as any;
  const v = await render(h(TurnBox, { threadId: 'native', turns: [turn('inProgress', { plan })] }));
  await act(async () => notify(view({ native: { items, stale: false } })));
  assert.ok(v.host.querySelector('.turn-box.with-tasks'));
  const list = () => v.host.querySelector('.turn-tasks [data-stub="TodoPlan"]') as HTMLElement | null;
  const shown = () => JSON.parse(list()!.dataset.steps!).map((s: any) => s.step);
  assert.deepEqual(JSON.parse(list()!.dataset.steps!), plan.steps);
  assert.equal(list()!.dataset.active, 'true', 'its turn is running: the open step spins');
  // a stopped turn's plan freezes; an empty plan of its own leaves the agent's list
  await v.rerender(h(TurnBox, { threadId: 'native', turns: [turn('interrupted', { plan })] }));
  assert.equal(list()!.dataset.active, 'false');
  await v.rerender(h(TurnBox, { threadId: 'native', turns: [turn('inProgress', { plan: { explanation: null, steps: [] } })] }));
  assert.deepEqual(shown(), ['Read', 'Write', 'Test']);
  await act(async () => notify(view({}, { native: { recap: 'Done.', ask: 'Ship?', actions: [] } })));
  assert.equal(list(), null);
  assert.equal(v.host.querySelector('.wrap-up-recap')!.textContent, 'Done.');
});

test('after the user’s message the plan from before it shows still, labelled, until the agent updates it', async () => {
  const v = await render(h(TurnBox, { threadId: 'top', turns: running }));
  await act(async () => notify(view({ top: { items, stale: true } })));
  const notes = () => [...v.host.querySelectorAll('.turn-tasks-more')].map((p) => p.querySelector('span')?.textContent ?? p.textContent);
  assert.deepEqual(notes(), ['Plan from before your last message']);
  assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'false', 'not the step being worked on');
  // a native plan the user steered a message in after is the same
  const plan = { explanation: null, steps: [{ step: 'Build', status: 'inProgress' }], steered: 0 };
  const steered = turn('inProgress', {
    plan,
    items: [
      { type: 'userMessage', id: 'a' },
      { type: 'userMessage', id: 'b' },
    ],
  });
  await v.rerender(h(TurnBox, { threadId: 'top', turns: [steered] }));
  assert.deepEqual(notes(), ['Plan from before your last message']);
  // updated: the label goes and the open step spins again
  await v.rerender(h(TurnBox, { threadId: 'top', turns: running }));
  await act(async () => notify(view({ top: { items, stale: false } })));
  assert.deepEqual(notes(), []);
  assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'true');
});

test('after a turn that finished, the list goes; linked sessions still working keep it, live while a step is open', async () => {
  asked.length = 0;
  const v = await render(h(TurnBox, { threadId: 'top', turns: [turn('completed')] }));
  await act(async () => notify(view({ top: { items, stale: false } })));
  assert.equal(v.host.innerHTML, '', 'finished: nothing left to follow');
  await act(async () =>
    notify(view({ top: { items, stale: false } }, {}, { kid: { parentId: 'top', createdAt: 1 }, other: { parentId: 'x', createdAt: 2 } })),
  );
  await flush();
  assert.ok(asked.includes('kid'), 'the window follows its linked session even without a child row');
  assert.ok(
    asked.every((id) => id === 'top' || id === 'kid'),
    'only the chat and its linked session are read',
  );
  assert.equal(v.host.innerHTML, '', 'a session that is not working keeps nothing');
  await act(async () => useSessions.setState({ sessions: { kid: { ...EMPTY_SESSION, turn: 'running' } } }));
  assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'true', 'the work goes on: it spins');
  await act(async () =>
    notify(
      view(
        { top: { items: items.map((s) => ({ ...s, status: 'completed' })), stale: false } },
        {},
        { kid: { parentId: 'top', createdAt: 1 } },
      ),
    ),
  );
  assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'false', 'every step done: still');
  await act(async () => notify(view({ top: { items, stale: false } }, {}, { kid: { parentId: 'top', createdAt: 1 } })));
  await act(async () => useSessions.setState({ sessions: { kid: { ...EMPTY_SESSION, queue: [{} as any] } } }));
  assert.equal(
    (v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active,
    'false',
    'queued input retains a still list',
  );
  await act(async () => useSessions.setState({ sessions: { kid: { ...EMPTY_SESSION, turn: 'awaitingUser' } } }));
  assert.equal(
    (v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active,
    'false',
    'a child waiting on the user stays still',
  );
  await act(async () => useSessions.setState({ sessions: { kid: { ...EMPTY_SESSION, turn: 'running' } } }));
  assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'true', 'a resumed child animates again');
  await act(async () => useSessions.setState({ sessions: { kid: EMPTY_SESSION } }));
  assert.equal(v.host.innerHTML, '');
});

test('after a turn, a background task still running keeps the open step spinning; one waiting on nothing else goes', async () => {
  const bg = { id: 'b1', type: 'local_bash', description: 'ci', status: 'running', toolUseId: null };
  await act(async () => useSessions.setState({ sessions: {} }));
  const v = await render(h(TurnBox, { threadId: 'bg', turns: [turn('completed')] }));
  await act(async () => notify(view({ bg: { items, stale: false } })));
  assert.equal(v.host.innerHTML, '', 'nothing runs: the finished turn leaves no list');
  await act(async () => useSessions.setState({ sessions: { other: { ...EMPTY_SESSION, tasks: [bg] } as any } }));
  assert.equal(v.host.innerHTML, '', 'another chat cannot animate this plan');
  await act(async () => useSessions.setState({ sessions: { bg: { ...EMPTY_SESSION, tasks: [bg] } as any } }));
  assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'true');
  await v.rerender(h(TurnBox, { threadId: 'other', turns: [turn('completed')] }));
  assert.equal(v.host.innerHTML, '', 'switching chats drops the previous chat’s activity');
  await v.rerender(h(TurnBox, { threadId: 'bg', turns: [turn('completed')] }));
  assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'true');
  await act(async () =>
    useSessions.setState({ sessions: { bg: { ...EMPTY_SESSION, tasks: [bg], approvals: [{ params: { agentID: bg.id } }] } as any } }),
  );
  assert.equal(v.host.innerHTML, '', 'a task waiting on the user is not progressing');
  await act(async () => useSessions.setState({ sessions: { bg: { ...EMPTY_SESSION, tasks: [{ ...bg, status: 'pending' }] } as any } }));
  assert.equal(
    (v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active,
    'true',
    'accepted unsettled task states count',
  );
  await act(async () => useSessions.setState({ sessions: { bg: { ...EMPTY_SESSION, tasks: [{ ...bg, status: 'completed' }] } as any } }));
  assert.equal(v.host.innerHTML, '', 'the task settled: the list goes with it');
});

test('a running child keeps the plan active beside a waiting child regardless of their order', async () => {
  await act(async () =>
    useSessions.setState({
      sessions: {
        ready: { ...EMPTY_SESSION, turn: 'running' },
        blocked: { ...EMPTY_SESSION, turn: 'awaitingUser' },
      },
    }),
  );
  const v = await render(h(TurnBox, { threadId: 'mixed', turns: [turn('completed')] }));
  for (const ids of [
    ['blocked', 'ready'],
    ['ready', 'blocked'],
  ]) {
    const children = Object.fromEntries(ids.map((id, index) => [id, { parentId: 'mixed', createdAt: index + 1 }]));
    await act(async () => notify(view({ mixed: { items, stale: false } }, {}, children)));
    assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'true');
  }
  await act(async () =>
    useSessions.setState({
      sessions: { ready: EMPTY_SESSION, blocked: { ...EMPTY_SESSION, turn: 'awaitingUser' } },
    }),
  );
  assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'false');
  await act(async () => useSessions.setState({ sessions: { ready: EMPTY_SESSION, blocked: EMPTY_SESSION } }));
  assert.equal(v.host.innerHTML, '');
  await v.unmount();
});

test('authored input preserves a prior plan’s background animation only in its owning chat; human input makes it stale', async (t) => {
  const entry = { by: 'momo' as const, title: 'Topic update', at: 1 };
  authoredInputs = { other: { 'momo-input': entry } };
  await act(async () =>
    useSessions.setState({ sessions: { authored: { ...EMPTY_SESSION, tasks: [{ id: 'bg', status: 'running' }] as any } } }),
  );
  const prior = turn('completed', { id: 'prior', plan: { steps: [{ step: 'Follow background work', status: 'inProgress' }] } });
  const latest = turn('completed', { id: 'latest', items: [{ type: 'userMessage', id: 'server-input', clientId: 'momo-input' }] });
  const v = await render(h(TurnBox, { threadId: 'authored', turns: [prior, latest] }));
  t.after(async () => {
    authoredInputs = {};
    await v.unmount();
  });
  await act(async () => notify(view()));
  assert.equal(v.host.innerHTML, '', 'another chat’s authored record cannot preserve this plan');
  authoredInputs = { authored: { 'momo-input': entry } };
  await v.rerender(h(TurnBox, { threadId: 'authored', turns: [prior, latest] }));
  assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'true');
  const human = { ...latest, items: [{ type: 'userMessage', id: 'human-input' }] };
  await v.rerender(h(TurnBox, { threadId: 'authored', turns: [prior, human] }));
  assert.equal(v.host.innerHTML, '', 'human input still invalidates the prior plan despite running background work');
});

test('the plan follows all background tasks until the last settles, regardless of completion order or outcome', async () => {
  for (const status of ['completed', 'failed', 'stopped']) {
    for (const first of [0, 1]) {
      const tasks = ['first', 'second'].map((id) => ({ id, status: 'running' }));
      await act(async () => useSessions.setState({ sessions: { multi: { ...EMPTY_SESSION, tasks: [...tasks] as any } } }));
      const v = await render(h(TurnBox, { threadId: 'multi', turns: [turn('completed')] }));
      await act(async () => notify(view({ multi: { items, stale: false } })));
      assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'true');
      tasks[first] = { ...tasks[first], status };
      await act(async () => useSessions.setState({ sessions: { multi: { ...EMPTY_SESSION, tasks: [...tasks] as any } } }));
      assert.equal((v.host.querySelector('[data-stub="TodoPlan"]') as HTMLElement).dataset.active, 'true', 'one task still executes');
      tasks[1 - first] = { ...tasks[1 - first], status };
      await act(async () => useSessions.setState({ sessions: { multi: { ...EMPTY_SESSION, tasks: [...tasks] as any } } }));
      assert.equal(v.host.innerHTML, '', `both tasks ${status}: no work remains`);
      await v.unmount();
    }
  }
});

test('paused and failed retained plans offer continuation; live, completed and read-only plans do not', async () => {
  const v = await render(h(TurnBox, { threadId: 'recover', turns: [turn('interrupted')] }));
  await act(async () => notify(view({ recover: { items, stale: false } })));
  assert.match(v.host.textContent!, /Paused/);
  assert.equal(v.host.querySelector('.turn-tasks-recovery button')!.textContent, 'Continue task');
  await v.rerender(h(TurnBox, { threadId: 'recover', turns: [turn('failed')], readOnly: true }));
  assert.match(v.host.textContent!, /Stopped after an error/);
  assert.equal(v.host.querySelector('.turn-tasks-recovery button'), null);
  await v.rerender(h(TurnBox, { threadId: 'recover', turns: running }));
  assert.equal(v.host.querySelector('.turn-tasks-recovery'), null);
  await v.rerender(h(TurnBox, { threadId: 'recover', turns: [turn('completed')] }));
  assert.equal(v.host.querySelector('.turn-box'), null);
  await v.unmount();
});

test('the plan from before the last message can be dismissed; a fresh list has no Dismiss (#4927)', async () => {
  momoChats = {};
  const v = await render(h(TurnBox, { threadId: 'top', turns: running }));
  await act(async () => notify(view({ top: { items, stale: false } })));
  assert.equal(v.host.querySelector('.turn-tasks-dismiss'), null);
  await act(async () => notify(view({ top: { items, stale: true } })));
  assert.match(v.host.querySelector('.turn-tasks-stale')!.textContent!, /Plan from before your last message/);
  await click(v.host.querySelector('.turn-tasks-dismiss'));
  assert.equal(v.host.innerHTML, '', 'gone once dismissed');
  // another stale plan is its own: it shows
  await act(async () => notify(view({ top: { items: [{ content: 'Other', status: 'pending' }], stale: true } })));
  assert.ok(v.host.querySelector('.turn-tasks-dismiss'));
});

test('MoMo’s chats draw no task list or box, ordinary chats still do (#4927)', async () => {
  momoChats = { top: 'main' };
  const v = await render(h(TurnBox, { threadId: 'top', turns: running }));
  await act(async () =>
    notify(view({ top: { items, stale: true } }, { top: { turn: 't', recap: 'r', ask: 'Go?', actions: [{ label: 'Go' }] } })),
  );
  assert.equal(v.host.innerHTML, '');
  momoChats = {};
  await act(async () => notify(view({ top: { items, stale: true } })));
  assert.ok(v.host.querySelector('.turn-tasks'));
});
