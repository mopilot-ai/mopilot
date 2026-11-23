// Background tasks cards, grouping, status, timers, navigation and task events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  window,
  h,
  act,
  app,
  calls,
  B,
  TaskList,
  TasksTab,
  TaskEventCard,
  sleep,
  task,
  mount,
  click,
  setTasks,
  text,
  byText,
  startedChats,
} from './support/tasks-ui.ts';

/* ---------------------------------------------------------------- list */

test('an empty list says where tasks appear', async () => {
  const v = await mount(h(TaskList, { chatId: 'empty' }));
  assert.equal(text(v.$('.tasks-empty')), 'Background tasks appear here');
  // Claude's diamond marks the empty tab
  assert.ok(v.$('.tasks-empty [data-icon="Diamond"]'));
  await v.unmount();
});

test("the tab leads with the chat's sessions, and a chat with sessions but no tasks is not empty", async () => {
  const tab = (chatId: string) => ({ id: `tasks-${chatId}`, kind: 'tasks', threadId: chatId, views: [] });
  startedChats.kids = ['k1'];
  const only = await mount(h(TasksTab, { tab: tab('kids'), chatId: 'kids', cwd: '/repo' } as any));
  assert.equal(only.$('.tasks-empty'), null);
  assert.equal(only.$('[data-sessions]')?.getAttribute('data-sessions'), 'kids');
  await only.unmount();
  startedChats.c1 = ['k2'];
  await setTasks('c1', [task('sh', { type: 'local_bash', status: 'running', startedAt: Date.now() })]);
  const both = await mount(h(TasksTab, { tab: tab('c1'), chatId: 'c1', cwd: '/repo' } as any));
  const column = both.$('.tasks-column')!;
  assert.ok(column.firstElementChild?.hasAttribute('data-sessions'), 'sessions lead the column');
  assert.ok(column.querySelector('.tasks-section'), 'the running task follows');
  await both.unmount();
  // no sessions: the list as it was, empty when there are no tasks
  delete startedChats.kids;
  const none = await mount(h(TasksTab, { tab: tab('kids'), chatId: 'kids', cwd: '/repo' } as any));
  assert.ok(none.$('.tasks-empty'));
  assert.equal(none.$('[data-sessions]'), null);
  await none.unmount();
  delete startedChats.c1;
  await setTasks('c1', []);
});

test('sections, card meta for agents and shells, nesting, adapter tasks and the Finished toggle', async () => {
  const now = Date.now();
  await setTasks('c1', [
    task('ag', {
      type: 'local_agent',
      description: 'Review the parser',
      startedAt: now - 443_000,
      model: 'Opus 5.5',
      tokens: 165_400,
      toolUses: 81,
      latestTool: 'Bash',
      agentKey: 'k-ag',
    }),
    task('sh', { command: 'npm run build --watch', description: 'build', startedAt: now - 18_000 }),
    task('wf', { type: 'local_workflow', description: 'Release' }),
    task('child', { type: 'local_agent', parentTaskId: 'wf', description: 'Step one' }),
    task('amb', { ambient: true }),
    task('done', { command: 'ls', status: 'completed', startedAt: now - 30_000, completedAt: now - 9_000 }),
    task('bad', { type: 'local_agent', description: 'Broke', status: 'failed', toolUses: 1, startedAt: 1, completedAt: 2 }),
  ]);
  B.putAdapterTasks('c1', [task('cx', { type: 'monitor', description: 'watch logs' })]);
  const v = await mount(h(TaskList, { chatId: 'c1' }));
  const heads = v.$$('.tasks-section-head').map(text);
  assert.deepEqual(heads, ['Running', 'Finished2']);
  const running = v.$$('.tasks-section')[0].querySelectorAll(':scope > .tasks-cards > .task-card');
  assert.deepEqual(
    [...running].map((c: any) => text(c.querySelector('.task-title'))),
    // a shell's title is its description when it has one (Claude's), as in Claude's tab; the command shows when it opens
    ['Review the parser', 'build', 'Release', 'watch logs'],
  );
  const agent = running[0] as any;
  assert.ok(agent.querySelector('.shimmer'));
  const lines = [...agent.querySelectorAll('.task-meta-line')].map((l: any) => [...l.children].map(text));
  assert.deepEqual(lines, [
    ['Agent', '7m 23s'],
    ['Opus 5.5', '165.4k tokens', '81 tool uses', 'Running a command', 'View transcript'],
  ]);
  assert.equal(agent.querySelectorAll('.task-v').length, 4);
  await click(byText(agent, 'button', 'View transcript'));
  assert.deepEqual(calls, [['openAgentPage', 'c1', 'k-ag', 'Review the parser']]);
  assert.deepEqual([...(running[1] as any).querySelector('.task-meta-line').children].map(text), ['Bash', '18s']);
  assert.equal(text(running[3].querySelector('.task-type')), 'Monitor');
  // a workflow's tasks nest under it
  assert.equal(text(running[2].querySelector('.task-children .task-title')), 'Step one');
  // finished: dimmed, with the status word; a failure is in the danger colour
  const finished = v.$$('.tasks-section')[1].querySelectorAll('.task-card');
  assert.deepEqual([...finished[0].querySelector('.task-meta-line').children].map(text), ['Bash', 'Completed', '21s']);
  assert.ok(finished[0].className.includes('finished') && !finished[0].querySelector('.shimmer'));
  assert.equal(text(finished[1].querySelector('.task-failed')), 'Failed');
  assert.ok(text(finished[1]).includes('1 tool use'));
  assert.ok(!finished[1].querySelector('.task-v'));
  // Finished collapses, and stays collapsed for the chat
  await click(v.$('.tasks-finished-toggle'));
  assert.equal(v.$('.tasks-finished-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(v.$$('.tasks-section')[1].querySelectorAll('.task-card').length, 0);
  await v.unmount();
  const again = await mount(h(TaskList, { chatId: 'c1' }));
  assert.equal(again.$('.tasks-finished-toggle').getAttribute('aria-expanded'), 'false');
  await click(again.$('.tasks-finished-toggle'));
  assert.equal(again.$$('.tasks-section')[1].querySelectorAll('.task-card').length, 2);
  await again.unmount();
  await act(() => B.putAdapterTasks('c1', []));
});

test('an agent task takes its title, model and counts from the call that launched it', async () => {
  const run = { key: 'k-run', description: 'Track A: count to five', model: 'claude-haiku-5-5', tokens: 52_400, toolUses: 3 };
  const bare = { key: 'k-bare', description: '', model: null, tokens: null, toolUses: 0 };
  await act(() =>
    app.setState({
      runtime: {
        c9: {
          turns: [
            {
              items: [
                { type: 'collabAgentToolCall', id: 'x', agent: run },
                { type: 'collabAgentToolCall', id: 'y', agent: bare },
              ],
            },
          ],
        },
      },
    }),
  );
  await setTasks('c9', [
    task('a0', { type: 'local_agent', description: 'Kept title', agentKey: 'k-bare', startedAt: Date.now() }),
    task('a1', { type: 'local_agent', description: 'Running Run the loop', agentKey: 'k-run', startedAt: Date.now() }),
    task('a2', {
      type: 'local_agent',
      description: 'Own title',
      agentKey: 'k-run',
      model: 'Opus 5.5',
      tokens: 9,
      toolUses: 1,
      startedAt: Date.now(),
    }),
    task('a3', { type: 'local_agent', description: 'No run', agentKey: 'k-none', startedAt: Date.now() }),
  ]);
  const v = await mount(h(TaskList, { chatId: 'c9' }));
  const cards = [...v.$$('.task-card')] as any[];
  assert.deepEqual(
    cards.map((c) => text(c.querySelector('.task-title'))),
    ['Kept title', 'Track A: count to five', 'Track A: count to five', 'No run'],
  );
  const line2 = (c: any) => [...c.querySelectorAll('.task-meta-line')[1].children].map(text);
  assert.deepEqual(line2(cards[1]).slice(0, 3), ['Haiku 5.5', '52.4k tokens', '3 tool uses']);
  assert.ok(!text(cards[0]).includes('tokens') && !text(cards[0]).includes('tool use'));
  assert.deepEqual(line2(cards[2]).slice(0, 3), ['Opus 5.5', '9 tokens', '1 tool use']);
  await v.unmount();
  await act(() => app.setState({ runtime: {} }));
});

test('a running timer ticks once a second; a card with no start shows no time', async () => {
  await setTasks('c2', [task('a', { startedAt: Date.now() }), task('b')]);
  const v = await mount(h(TaskList, { chatId: 'c2' }));
  const time = () => v.$$('.task-card')[0].querySelector('.task-time').textContent;
  assert.equal(time(), '0s');
  assert.equal(v.$$('.task-card')[1].querySelector('.task-time'), null);
  await act(() => sleep(2100));
  assert.notEqual(time(), '0s');
  await v.unmount();
});

test('Stop: a square while running, "Stopping…" while in flight, disabled when the harness cannot stop it', async () => {
  await setTasks('c3', [task('a', { description: 'sleep' }), task('b', { stoppable: false })]);
  const v = await mount(h(TaskList, { chatId: 'c3' }));
  const [a, b] = v.$$('.task-stop');
  assert.equal(a.getAttribute('aria-label'), 'Stop sleep');
  assert.equal(a.title, 'Stop this task');
  assert.ok(b.disabled);
  assert.equal(b.title, "This task can't be stopped from here");
  // no stopper: nothing happens
  await click(a);
  assert.equal(a.getAttribute('aria-busy'), null);
  let release!: (v: boolean) => void;
  B.setTaskStopperResolver(() => () => new Promise<boolean>((r) => (release = r)));
  await click(a);
  const busy = v.$$('.task-stop')[0];
  assert.equal(busy.getAttribute('aria-label'), 'Stopping…');
  assert.equal(busy.title, 'Stopping…');
  assert.ok(busy.disabled);
  assert.ok(busy.querySelector('[data-icon="Spinner"]'));
  await act(async () => release(true));
  assert.equal(v.$$('.task-stop')[0].getAttribute('aria-label'), 'Stop sleep');
  // settled tasks have no Stop
  await setTasks('c3', [task('a', { status: 'stopped' })]);
  assert.equal(v.$('.task-stop'), null);
  await v.unmount();
});

test('clicking a card expands it: a shell shows its command and output, an agent its summary', async () => {
  await setTasks('c4', [
    task('sh', { command: 'npm test', status: 'completed' }),
    task('ag', { type: 'local_agent', summary: 'All done', status: 'completed' }),
    task('plain', { type: 'local_agent', status: 'completed' }),
    task('linked', { type: 'local_agent', status: 'completed', agentKey: 'k9', summary: 'Running a command' }),
  ]);
  const v = await mount(h(TaskList, { chatId: 'c4' }));
  const cards = () => v.$$('.task-card');
  // every card opens: one with nothing to say says so, and an agent with a page opens it, even with a summary
  await click(cards()[2].querySelector('.task-opener'));
  assert.equal(text(cards()[2].querySelector('.task-summary')), 'No further details yet.');
  await click(cards()[2].querySelector('.task-opener'));
  assert.equal(cards()[3].querySelector('.task-opener').getAttribute('aria-expanded'), null);
  calls.length = 0;
  await click(cards()[3].querySelector('.task-opener'));
  assert.deepEqual(calls, [['openAgentPage', 'c4', 'k9', 'linked']]);
  assert.equal(cards()[3].querySelector('.task-body'), null);
  await click(cards()[0].querySelector('.task-opener'));
  assert.ok(cards()[0].className.includes('open'));
  assert.equal(cards()[0].querySelector('.task-opener').getAttribute('aria-expanded'), 'true');
  assert.equal(cards()[0].querySelector('pre[data-code]').getAttribute('data-code'), '$ npm test');
  assert.equal(text(cards()[0].querySelector('.task-output-note')), 'Output unavailable');
  await click(cards()[1].querySelector('.task-opener'));
  assert.equal(text(cards()[1].querySelector('.task-summary')), 'All done');
  await click(cards()[0].querySelector('.task-opener'));
  assert.equal(cards()[0].querySelector('.task-body'), null);
  // a shell without its command shows only the output
  await setTasks('c4', [task('sh', { status: 'completed' })]);
  await click(cards()[0].querySelector('.task-opener'));
  assert.equal(cards()[0].querySelector('pre[data-code]'), null);
  await v.unmount();
});

/* ---------------------------------------------------------------- tab */

test('the tab: title, clear finished (persisted; a task that runs again comes back), expand and close', async () => {
  const tab = { id: 'tab1', kind: 'tasks', threadId: 'c6' } as any;
  await setTasks('c6', [task('run'), task('old', { status: 'completed' })]);
  const v = await mount(h(TasksTab, { tab, chatId: 'c6', cwd: '/repo' }));
  assert.equal(text(v.$('.tasks-tab-title')), 'Background tasks');
  assert.equal(v.$('[aria-label="Back"]'), null);
  const trash = () => v.$('[aria-label="Clear finished tasks"]');
  assert.equal(trash().getAttribute('aria-disabled'), 'false');
  await click(trash());
  assert.deepEqual(
    v.$$('.task-card').map((c: any) => text(c.querySelector('.task-title'))),
    ['run'],
  );
  assert.deepEqual(JSON.parse(window.localStorage.getItem('mopilot.dismissedTasks')!).c6, ['old']);
  assert.equal(trash().getAttribute('aria-disabled'), 'true');
  await click(trash());
  // the cleared task runs again: it is back, and stays back once it finishes
  await setTasks('c6', [task('run'), task('old')]);
  await setTasks('c6', [task('run'), task('old', { status: 'completed' })]);
  assert.equal(v.$$('.task-card').length, 2);
  assert.ok(!JSON.parse(window.localStorage.getItem('mopilot.dismissedTasks')!).c6);
  // expand and collapse follow the pane's full view
  assert.ok(v.$('[data-icon="Maximize2"]'));
  await click(v.$('[aria-label="Expand"]'));
  assert.equal(app.get().paneFull, true);
  assert.ok(v.$('[aria-label="Collapse"] [data-icon="Minimize2"]'));
  await click(v.$('[aria-label="Collapse"]'));
  assert.equal(app.get().paneFull, false);
  await click(v.$('[aria-label="Close"]'));
  assert.deepEqual(calls, [['closePaneTab', 'tab1']]);
  await v.unmount();
});

test('an agent page over the list: back, its title, expand and close, and the page body', async () => {
  const tab = { id: 'tab2', kind: 'tasks', threadId: 'c7', views: [{ kind: 'agent', key: 'k1', title: 'Review the parser' }] } as any;
  const v = await mount(h(TasksTab, { tab, chatId: 'c7', cwd: '/repo' }));
  assert.equal(text(v.$('.tasks-tab-title')), 'Review the parser');
  assert.equal(v.$('[aria-label="Clear finished tasks"]'), null);
  assert.ok(v.$('[aria-label="Expand"]') && v.$('[aria-label="Close"]'));
  // the agent's page also opens in a window of its own
  calls.length = 0;
  await click(v.$('[aria-label="Open in new window"]'));
  assert.deepEqual(calls, [['winOpen', 'thread=c7&agent=k1&title=Review%20the%20parser']]);
  const page = v.$('[data-agent]');
  assert.deepEqual([page.dataset.agent, page.dataset.chat, page.dataset.cwd], ['k1', 'c7', '/repo']);
  calls.length = 0;
  await click(v.$('[aria-label="Back"]'));
  assert.deepEqual(calls, [['popPaneView', 'tab2']]);
  await v.unmount();
});

/* ---------------------------------------------------------------- transcript event card */

const ev = (taskId: string, status = 'running', o: object = {}): any => ({
  taskId,
  kind: 'shell',
  title: taskId,
  status,
  durationMs: null,
  ...o,
});

test('a settled task event is an inline line; it opens the tab when it knows the chat', async () => {
  const v = await mount(h(TaskEventCard, { events: [ev('npm test', 'completed', { durationMs: 21_000 })], chatId: 'e1' }));
  const line = v.$('button.task-event-inline');
  assert.deepEqual([...line.querySelectorAll('.task-event-line > span')].map(text), [
    'Background command completed',
    '· npm test',
    '· took 21s',
  ]);
  await click(line);
  assert.deepEqual(calls, [['toggleTasksPane', 'e1']]);
  await v.rerender(h(TaskEventCard, { events: [ev('', 'failed', { kind: 'agent' })] }));
  const plain = v.$('div.task-event-inline');
  assert.deepEqual([...plain.querySelectorAll('.task-event-line > span')].map(text), ['Background agent failed']);
  assert.ok(plain.querySelector('.task-failed'));
  await v.unmount();
});

test('a running event whose task has settled reads as its settled line', async () => {
  await setTasks('e3', [task('a', { status: 'completed', startedAt: 1000, completedAt: 22_000 })]);
  const v = await mount(h(TaskEventCard, { events: [ev('a', 'running', { title: 'npm run dev' })], chatId: 'e3' }));
  assert.ok(v.$('button.task-event-inline'));
  assert.equal(v.$('button.task-event-card'), null);
  assert.match(text(v.$('.task-event-line')), /Background command completed.*took 21s/);
  await v.unmount();
});

test('a running agent card says it waits for approval while one of its tool calls is pending', async () => {
  const agent = task('ag1', { type: 'local_agent', agentKey: 'tu1', description: 'Check CI' });
  await setTasks('w1', [agent, task('sh1')], [{ id: 'p1', method: 'claude/permission', params: { toolName: 'Bash', agentID: 'ag1' } }]);
  const v = await mount(h(TaskList, { chatId: 'w1' }));
  const waiting = v.$$('.task-waiting');
  assert.deepEqual(
    waiting.map((e: any) => text(e)),
    ['Waiting for approval'],
  );
  assert.ok(waiting[0].closest('.task-card').textContent.includes('Check CI'));
  // the main session's own approval (no agent), another agent's, or none at all marks nothing
  await setTasks(
    'w1',
    [agent, task('sh1')],
    [
      { id: 'p2', method: 'claude/permission', params: { toolName: 'Bash', agentID: null } },
      { id: 'p3', method: 'x', params: null },
    ],
  );
  assert.equal(v.$$('.task-waiting').length, 0);
  // Codex names the agent's thread instead
  const codexAgent = task('codex-agent:th9', { type: 'local_agent', agentKey: 'th9', description: 'Fix lint' });
  await setTasks(
    'w1',
    [codexAgent, task('sh1')],
    [{ id: 'p4', method: 'item/commandExecution/requestApproval', params: { threadId: 'th9' } }],
  );
  assert.deepEqual(
    v.$$('.task-waiting').map((e: any) => e.closest('.task-card').textContent.includes('Fix lint')),
    [true],
  );
  await setTasks('w1', [codexAgent], [{ id: 'p5', method: 'item/commandExecution/requestApproval', params: { threadId: 'the-chat' } }]);
  assert.equal(v.$$('.task-waiting').length, 0);
  // a settled agent never waits
  await setTasks('w1', [{ ...agent, status: 'completed' }], [{ id: 'p1', method: 'claude/permission', params: { agentID: 'ag1' } }]);
  assert.equal(v.$$('.task-waiting').length, 0);
  await v.unmount();
});

test('a running task event is a 318 px card with a live timer; a group sums up by status', async () => {
  await setTasks('e2', [task('a', { startedAt: Date.now() - 5000 })]);
  const v = await mount(h(TaskEventCard, { events: [ev('a', 'running', { title: 'npm run dev' })], chatId: 'e2' }));
  const card = v.$('button.task-event-card');
  assert.equal(text(card.querySelector('.task-event-label .shimmer')), 'npm run dev');
  assert.match(text(card.querySelector('.task-event-time')), /^[45]s$/); // the shared clock ticks once a second
  assert.ok(card.querySelector('.task-event-label.single'));
  assert.ok(card.querySelector('[data-icon="Diamond"]') && card.querySelector('[data-icon="ChevronRight"]'));
  await click(card);
  assert.deepEqual(calls, [['toggleTasksPane', 'e2']]);
  // no matching task: no timer; no chat: not clickable
  await v.rerender(h(TaskEventCard, { events: [ev('zz')] }));
  assert.equal(v.$('.task-event-time'), null);
  assert.ok(v.$('button.task-event-card').disabled);
  B.putAdapterTasks('', [task('zz')]);
  await v.rerender(h(TaskEventCard, { events: [ev('zz')], chatId: 'e2' }));
  assert.equal(v.$('.task-event-time'), null);
  await act(() => B.putAdapterTasks('', []));
  // a group
  await v.rerender(h(TaskEventCard, { events: [ev('a', 'completed'), ev('b')], chatId: 'e2' }));
  assert.equal(text(v.$('.task-event-label')), '1 background command completed, 1 running');
  assert.ok(v.$('.task-event-label .shimmer'));
  assert.ok(!v.$('.task-event-label.single'));
  // a group whose tasks all settled is a line, not a card, with its failures in the danger color
  await v.rerender(h(TaskEventCard, { events: [ev('a', 'completed'), ev('b', 'failed')], chatId: 'e2' }));
  assert.equal(v.$('.task-event-card'), null);
  const heads = v.$$('button.task-event-inline .task-event-head');
  assert.deepEqual(heads.map(text), ['1 background command completed', ', 1 failed']);
  assert.deepEqual(
    heads.map((e: any) => e.classList.contains('task-failed')),
    [false, true],
  );
  assert.equal(v.$('.task-event-inline [data-icon]'), null);
  await v.unmount();
});

test('a task its step row stands for gets no event: by the event, or by the chat task list for older notes', async () => {
  // the event names the step that started it (a Claude tool call, a Codex command item)
  const v = await mount(h(TaskEventCard, { events: [ev('a', 'running', { toolUseId: 'tu1' })], chatId: 'r1' }));
  assert.equal(v.host.innerHTML, '');
  await v.rerender(h(TaskEventCard, { events: [ev('a', 'failed', { toolUseId: 'tu1' })], chatId: 'r1' }));
  assert.equal(v.host.innerHTML, '');
  // a note saved before events carried it: the chat's task list knows the step
  await setTasks('r1', [task('a', { status: 'completed', toolUseId: 'tu1' })]);
  await v.rerender(h(TaskEventCard, { events: [ev('a', 'completed')], chatId: 'r1' }));
  assert.equal(v.host.innerHTML, '');
  // in a group only the tasks with no row are left: one left reads as a single line
  await v.rerender(
    h(TaskEventCard, { events: [ev('a', 'completed'), ev('m', 'completed', { kind: 'monitor', title: 'Watch CI' })], chatId: 'r1' }),
  );
  assert.equal(text(v.$('.task-event-line')), 'Background monitor completed· Watch CI');
  await v.unmount();
});
