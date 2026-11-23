// The agent group (src/components/agents/AgentGroup.tsx) a step group with agent launches renders as: the live
// conjugated header with its 650 ms dwell, the summary once settled, agent rows that open their agent page, and a
// card the header folds at any time, live or not.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, settle, resetStore, setStore, callsTo, moduleCalls } from './support/thread-kit.ts';

mockStore();
let sessionNow: any = { tasks: [] };
autoMock('src/store/session/useSession.ts', 'sess', {
  useSession: () => sessionNow,
  useSessionField: (id: any, pick: any) => pick(((() => sessionNow) as (id: any) => any)(id)),
});
autoMock('src/store/panes.ts', 'panes');
autoMock('src/components/tasks/TasksPill.tsx', 'pill', { InlineTasksCount: stubComponent('InlineTasksCount') });
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/ui/Presence.tsx', 'presence', {
  Collapse: ({ open, children }: any) => (open ? h('div', { className: 'collapse open' }, children) : null),
});
const { StepGroup } = await import('../src/components/thread/Items.tsx');
const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
const { AgentChatContext, AgentRow, hasAgentRun } = await import('../src/components/agents/AgentGroup.tsx');
const { AgentChatContext: SharedChatContext } = await import('../src/components/agents/AgentChatContext.ts');
const { LABEL_DWELL_MS } = await import('../src/lib/minDwell.ts');
const { StatusSlot } = await import('../src/components/thread/statusSlot.tsx');

test('the agent-group export retains the shared context used by work rows', () => {
  assert.equal(AgentChatContext, SharedChatContext);
});

beforeEach(() => {
  resetStore();
  moduleCalls.length = 0;
});

const sleep = (ms: number) => settle(() => new Promise((r) => setTimeout(r, ms)));
const run = (key: string, status: string, extra: any = {}) => ({
  key,
  description: `Track ${key}: fix things`,
  prompt: 'p',
  model: null,
  background: false,
  status,
  toolUses: 0,
  latestTool: null,
  tokens: null,
  startedAt: null,
  completedAt: null,
  report: null,
  transcript: 'full',
  ...extra,
});
// an adapter-built agent item (any harness may set `agent`), shaped like a tool call
const agent = (key: string, status: string, extra: any = {}) => ({
  id: `i-${key}`,
  type: 'dynamicToolCall',
  tool: 'Task',
  status: status === 'running' ? 'inProgress' : 'completed',
  agent: run(key, status, extra),
});
const thought = (id: string, text: string) => ({ id, type: 'reasoning', summary: [text], content: [] });
const command = (id: string, cmd: string, status = 'completed') => ({
  id,
  type: 'commandExecution',
  command: cmd,
  status,
  commandActions: [],
});

const group = (items: any[], active = false, chatId = 'chat-1') =>
  h(AgentChatContext.Provider, { value: chatId }, h(StepGroup, { items, cwd: '/repo', active }));
const head = (v: any) => v.$('.agent-group-head') as HTMLElement;
const title = (v: any) => v.$('.agent-group-title .morph-layer:not(.morph-out)')!.textContent;
// a row's text without the label that is crossfading out
const rows = (v: any) =>
  v.$$('.agent-row').map((r: HTMLElement) => {
    const c = r.cloneNode(true) as HTMLElement;
    c.querySelectorAll('.morph-out').forEach((n) => n.remove());
    return c.textContent;
  });

test('only groups with an agent launch are agent groups', () => {
  assert.equal(hasAgentRun([command('c', 'ls')] as any), false);
  assert.equal(hasAgentRun([command('c', 'ls'), agent('A', 'running')] as any), true);
  // a Codex wait is agent activity but no launch
  assert.equal(hasAgentRun([{ id: 'w', type: 'collabAgentToolCall', tool: 'wait' }] as any), false);
});

test('a running group follows its first running agent with the conjugated label and holds each label 650 ms', async () => {
  const lead = thought('r1', 'Planning the tracks');
  const build = command('c0', 'npm run build', 'inProgress');
  // before any agent runs the header names the running step
  const v = await render(group([lead, agent('Z', 'completed'), build], true));
  assert.equal(title(v), 'Running npm run build');
  await sleep(LABEL_DWELL_MS);
  const items = [lead, agent('Z', 'completed'), command('c0', 'npm run build'), agent('A', 'running'), agent('B', 'running')];
  await v.rerender(group(items, true));
  // Active reasoning stays opt-in above the card even when an agent launch changes the renderer.
  assert.equal(v.$('.reasoning-text'), null);
  await settle(() => v.$('.step-row-hit')!.click());
  assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'Planning the tracks');
  assert.equal(title(v), 'Tracking A: fix things');
  assert.ok(v.$('.agent-group-title .shimmer'));
  assert.match(head(v).className, /running/);
  assert.equal(head(v).getAttribute('aria-expanded'), 'false', 'the group mounted before agents ran stays as the user left it');
  await settle(() => head(v).click());
  assert.deepEqual(rows(v), ['Ran agentTrack Z: fix things', 'Running agentTrack A: fix things', 'Running agentTrack B: fix things']);
  assert.equal(v.$$('.agent-row-caret').length, 1, 'no caret while running');
  // other steps keep their own rows in the card
  assert.equal(v.$('.agent-card .agent-card-cell .step-text')!.textContent, 'Ran npm run build');

  // A finishes: its row settles, but the header waits out A's dwell before naming B
  await v.rerender(group([lead, items[1], items[2], agent('A', 'completed'), items[4]], true));
  assert.equal(title(v), 'Tracking A: fix things');
  assert.equal(rows(v)[1], 'Ran agentTrack A: fix things');
  assert.ok(v.$$('.agent-row')[1].querySelector('.agent-row-caret'), 'a settled agent shows its caret');
  await sleep(LABEL_DWELL_MS + 60);
  assert.equal(title(v), 'Tracking B: fix things');

  // everything settles: the header returns to the summary after the fall hold
  await v.rerender(group([lead, items[1], items[2], agent('A', 'completed'), agent('B', 'completed')], false));
  assert.notEqual(title(v), 'Ran 3 agents, ran a command');
  await sleep(LABEL_DWELL_MS + 60);
  assert.equal(title(v), 'Ran 3 agents, ran a command');
  assert.equal(v.$$('.agent-group-title .morph-layer:not(.morph-out) .shimmer').length, 0);
  assert.match(head(v).className, /open/);
  await v.unmount();
});

test('a group mounted while its agents run starts open', async () => {
  const v = await render(group([agent('A', 'running')], true));
  assert.equal(head(v).getAttribute('aria-expanded'), 'true');
  assert.equal(v.$('.agent-card')!.hidden, false);
  await v.unmount();
});

test('a background agent stays live outside the active group, then retires before its label dwell ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const background = (status: string) => group([agent('A', status, { background: true })], false);
  const v = await render(background('running'));
  t.after(() => v.unmount());
  assert.match(head(v).className, /running/);
  assert.ok(v.$('.agent-group-title .shimmer'));
  assert.equal(v.$('[role="timer"]'), null, 'the background agent owns no turn clock');
  await v.rerender(background('completed'));
  assert.doesNotMatch(head(v).className, /running/);
  assert.equal(v.$('.agent-group-title .shimmer'), null);
  assert.equal(v.$('.claude-activity'), null, 'an inactive settled group owns no waiting line');
});

test('the header folds a card its running agents opened, and the fold stays while they still report', async () => {
  const v = await render(group([agent('A', 'running')], true));
  assert.equal(head(v).getAttribute('aria-disabled'), null);
  await settle(() => head(v).click());
  assert.equal(head(v).getAttribute('aria-expanded'), 'false');
  assert.equal(v.$('.agent-card')!.hidden, true);
  // more steps arrive and a second agent starts: the user's fold stays
  await v.rerender(group([agent('A', 'running'), command('c1', 'npm test', 'inProgress'), agent('B', 'running')], true));
  assert.equal(head(v).getAttribute('aria-expanded'), 'false');
  // a second click opens it again, still live
  await settle(() => head(v).click());
  assert.equal(head(v).getAttribute('aria-expanded'), 'true');
  assert.equal(v.$('.agent-card')!.hidden, false);
  // and it settles open as the user left it
  await v.rerender(group([agent('A', 'completed'), agent('B', 'completed')], false));
  await sleep(LABEL_DWELL_MS + 50);
  assert.equal(head(v).getAttribute('aria-expanded'), 'true');
  await v.unmount();
});

test('a live group the group left closed opens and folds again on the header', async () => {
  // a running step with no running agent: the group's own policy leaves the card closed, and the header is live
  const v = await render(group([agent('A', 'completed'), command('c1', 'npm run build', 'inProgress')], true));
  assert.equal(head(v).getAttribute('aria-expanded'), 'false');
  await settle(() => head(v).click());
  assert.equal(head(v).getAttribute('aria-expanded'), 'true');
  assert.equal(v.$('.agent-card')!.hidden, false);
  await settle(() => head(v).click());
  assert.equal(head(v).getAttribute('aria-expanded'), 'false');
  assert.equal(v.$('.agent-card')!.hidden, true);
  await v.unmount();
});

test('a held label whose agent left the group shows the live one; a running step titles a group with no running agent', async () => {
  const v = await render(group([agent('A', 'running'), agent('B', 'running')], true));
  assert.equal(title(v), 'Tracking A: fix things');
  await v.rerender(group([agent('B', 'running')], true));
  assert.equal(title(v), 'Tracking B: fix things');
  await v.unmount();

  const s = await render(group([agent('A', 'completed'), command('c1', 'npm run build', 'inProgress')], true));
  assert.equal(title(s), 'Running npm run build');
  // the same group outside the active turn is settled
  await s.unmount();
  const q = await render(group([agent('A', 'completed'), command('c1', 'npm run build', 'inProgress')], false));
  assert.equal(title(q), 'Ran an agent, ran a command');
  assert.equal(q.$('.agent-card'), null, 'a settled group starts collapsed and mounts its card on first open');
  await q.unmount();
});

test('the header toggles the card; agent rows open the agent page by chat id, key and description', async () => {
  const v = await render(group([agent('A', 'completed'), agent('B', 'failed'), agent('C', 'stopped')], false, 'claude:abc'));
  assert.equal(head(v).getAttribute('aria-expanded'), 'false');
  assert.doesNotMatch(head(v).className, /open|running/);
  await settle(() => head(v).click());
  assert.equal(head(v).getAttribute('aria-expanded'), 'true');
  assert.equal(v.$('.agent-card')!.hidden, false);
  assert.deepEqual(rows(v), [
    'Ran agentTrack A: fix things',
    'Failed to run agentTrack B: fix things',
    'Ran agentTrack C: fix thingsStopped',
  ]);
  const [, failed, stopped] = v.$$('.agent-row');
  assert.match(failed.className, /failed/);
  assert.equal(stopped.querySelector('.agent-row-outcome')!.textContent, 'Stopped');
  await settle(() => failed.click());
  assert.deepEqual(callsTo('panes:openAgentPage'), [['claude:abc', 'B', 'Track B: fix things']]);
  // closing keeps the card mounted, hidden
  await settle(() => head(v).click());
  assert.equal(v.$('.agent-card')!.hidden, true);
  await v.unmount();
});

test('Codex spawn items are agent rows too, and hidden thoughts stay hidden', async () => {
  setStore({ prefs: { showReasoning: false } });
  const spawn = {
    id: 'sp',
    type: 'collabAgentToolCall',
    tool: 'spawnAgent',
    status: 'inProgress',
    prompt: 'Review the parser',
    receiverThreadIds: ['th-1'],
    agentsStates: { 'th-1': { status: 'running' } },
  };
  const v = await render(group([thought('r1', 'hidden'), spawn, thought('r2', 'also hidden')], true));
  assert.equal(v.$('.agent-group-thoughts'), null);
  assert.equal(title(v), 'Running agent Review the parser');
  assert.deepEqual(rows(v), ['Running agentReview the parser']);
  assert.equal(v.$$('.agent-card-cell').length, 1, 'a hidden thought is no row');
  await settle(() => v.$('.agent-row')!.click());
  assert.deepEqual(callsTo('panes:openAgentPage'), [['chat-1', 'th-1', 'Review the parser']]);
  await v.unmount();

  // shown, a thought after the first step is a row in the card
  setStore({ prefs: { showReasoning: true } });
  const s = await render(group([agent('A', 'completed'), thought('r2', 'later')], false));
  await settle(() => head(s).click());
  assert.equal(s.$$('.agent-card-cell')[1].textContent, 'Thought');
  await s.unmount();
});

test('an agent row holds its status label 650 ms, and outside a context opens with an empty chat id', async () => {
  const row = (status: string) => h(AgentRow, { run: run('Z', status) as any, chatId: '' });
  const v = await render(row('running'));
  await sleep(LABEL_DWELL_MS);
  await v.rerender(row('completed'));
  assert.deepEqual(rows(v), ['Ran agentTrack Z: fix things']);
  // resumed right away: the settled label stays up its dwell first
  await v.rerender(row('running'));
  assert.deepEqual(rows(v), ['Ran agentTrack Z: fix things']);
  await sleep(LABEL_DWELL_MS + 60);
  assert.deepEqual(rows(v), ['Running agentTrack Z: fix things']);
  await v.rerender(row('completed'));
  await settle(() => v.$('.agent-row')!.click());
  assert.deepEqual(callsTo('panes:openAgentPage'), [['', 'Z', 'Track Z: fix things']]);
  await v.unmount();
});

test('once nothing runs and the turn moved past the group, its header stops being a running line at once; while it is the active block it keeps the dwell', async () => {
  const v = await render(group([agent('A', 'running')], true));
  assert.match(head(v).className, /running/);
  await sleep(LABEL_DWELL_MS);
  // the agent ended, the group is still the turn's last block: the header holds the running label through the dwell
  await v.rerender(group([agent('A', 'completed')], true));
  assert.match(head(v).className, /running/);
  assert.ok(v.$('.agent-group-title .shimmer'));
  // the reply started (the group is no longer the active block): no running header beside the status slot's waiting line
  await v.rerender(group([agent('A', 'completed')], false));
  assert.doesNotMatch(head(v).className, /running/);
  assert.equal(v.$('.agent-group-title .shimmer'), null);
  // a background agent still running in a group the turn moved past is still running
  await v.rerender(group([agent('B', 'running', { background: true })], false));
  assert.match(head(v).className, /running/);
  await v.unmount();
});

test('a group that settled while its turn runs keeps the clock and the counts on a thinking row under it', async () => {
  const v = await render(
    h(
      AgentChatContext.Provider,
      { value: 'c' },
      h(StepGroup, { items: [agent('A', 'completed')] as any, cwd: '/r', active: true, elapsedMs: 72000 }),
    ),
  );
  assert.match(v.$('.agent-group > .claude-activity .claude-activity-time')!.textContent!, /1m 12s/);
  assert.equal(v.$('.agent-group > .claude-activity [data-stub="InlineTasksCount"]')!.dataset.chatid, 'c');
  await v.unmount();
});

test('a running agent group carries the turn clock beside its header, and a settled or untimed one carries none', async () => {
  const running = [agent('A', 'running')] as any;
  const v = await render(
    h(AgentChatContext.Provider, { value: 'c' }, h(StepGroup, { items: running, cwd: '/r', active: true, elapsedMs: 72000 })),
  );
  assert.equal(v.$('.agent-group-head [role="timer"]')!.textContent, '1m 12s');
  assert.ok(v.$('.agent-group-main > [data-stub="InlineTasksCount"]'), 'the running-tasks count beside the header');
  // no clock for a page that runs no turn (hideTime) or when the turn's time is unknown
  await v.rerender(
    h(
      AgentChatContext.Provider,
      { value: 'c' },
      h(StepGroup, { items: running, cwd: '/r', active: true, elapsedMs: 72000, hideTime: true }),
    ),
  );
  assert.equal(v.$('[role="timer"]'), null);
  // an agent's page runs no turn of its own: no running-tasks count beside its header, and no "Thinking…" row once settled
  assert.equal(v.$('[data-stub="InlineTasksCount"]'), null);
  const settled = [agent('A', 'completed')] as any;
  await v.rerender(
    h(
      AgentChatContext.Provider,
      { value: 'c' },
      h(StepGroup, { items: settled, cwd: '/r', active: true, elapsedMs: 72000, hideTime: true }),
    ),
  );
  await sleep(LABEL_DWELL_MS + 50);
  assert.equal(v.$('.claude-activity'), null);
  await v.rerender(h(AgentChatContext.Provider, { value: 'c' }, h(StepGroup, { items: running, cwd: '/r', active: true })));
  assert.equal(v.$('[role="timer"]'), null);
  await v.rerender(
    h(
      AgentChatContext.Provider,
      { value: 'c' },
      h(StepGroup, { items: [agent('A', 'completed')] as any, cwd: '/r', active: false, elapsedMs: 5000 }),
    ),
  );
  assert.equal(v.$('[role="timer"]'), null);
  await v.unmount();
});

test('in a thread view the agent group moves its single running line below the task list and names commands safely', async () => {
  const slot = document.createElement('div');
  document.body.append(slot);
  const inView = (items: any[], active = true) =>
    h(
      StatusSlot.Provider,
      { value: slot },
      h(AgentChatContext.Provider, { value: 'c' }, h(StepGroup, { items, cwd: '/r', active, elapsedMs: 72000 })),
    );
  const v = await render(inView([agent('A', 'running')]));
  const label = () => slot.querySelector('.claude-activity-label')!.textContent;
  assert.equal(label(), 'Tracking A: fix things');
  assert.equal(slot.querySelector('.claude-activity-time')!.textContent, '1m 12s');
  assert.equal(v.$('.claude-activity'), null);
  assert.equal(v.$('.agent-group-head'), null);
  assert.equal(slot.querySelectorAll('.claude-activity').length, 1);
  // a command that could carry a credential is not shown
  await v.rerender(inView([agent('A', 'completed'), command('c1', 'curl -H "Authorization: Bearer abc" https://h', 'inProgress')]));
  assert.equal(label(), 'Running a command');
  // any other step keeps its own wording
  const read = {
    ...command('r1', 'Read /r/a.ts', 'inProgress'),
    commandActions: [{ type: 'read', command: 'Read', name: 'a.ts', path: '/r/a.ts' }],
  };
  await v.rerender(inView([agent('A', 'completed'), read]));
  assert.equal(label(), 'Reading a.ts');
  assert.equal(slot.querySelectorAll('.claude-activity').length, 1);
  // Settled while the turn still runs: the same lower row becomes Thinking, with no second group title.
  await v.rerender(inView([agent('A', 'completed')]));
  await sleep(LABEL_DWELL_MS + 50);
  assert.equal(v.$('.agent-group-head'), null);
  assert.equal(slot.querySelectorAll('.claude-activity').length, 1);
  assert.equal(slot.querySelector('.working-mark')!.getAttribute('data-activity'), 'think');
  assert.equal(label(), 'Thinking…');
  assert.equal(slot.querySelector('.claude-activity-time')!.textContent, '1m 12s');
  await v.rerender(inView([agent('A', 'completed')], false));
  assert.equal(v.$('.claude-activity'), null, 'the turn ended');
  assert.equal(slot.childElementCount, 0);
  await v.unmount();
  slot.remove();
});

test('a command sent to the background keeps its shimmering "Running" row until its task settles', async () => {
  const bg = { ...command('c1', 'sleep 90; echo bg'), background: true };
  const label = (v: any) => v.$('.step-row')!.textContent;
  const row = (tasks: any[]) => {
    sessionNow = { tasks };
    return h(AgentChatContext.Provider, { value: 'chat-1' }, h(StepRow, { step: { kind: 'command', item: bg } as any, cwd: '/r' }));
  };
  const v = await render(row([{ id: 'k', toolUseId: 'c1', status: 'running' }]));
  assert.equal(label(v), 'Running sleep 90; echo bgView live output');
  // while it runs, "View live output ›" sits on the row's own line, as Claude has it, and opens the Background tasks tab
  assert.ok(v.$('.step-row .step-text .step-live-link svg'));
  await settle(() => v.$('.step-live-link')!.click());
  assert.deepEqual(callsTo('panes:toggleTasksPane'), [['chat-1']]);
  assert.ok(v.$('.step-row .shimmer'));
  // the task ended, or is not known (yet): the row reads as any finished command
  await v.rerender(row([{ id: 'k', toolUseId: 'c1', status: 'completed' }]));
  assert.equal(label(v), 'Ran sleep 90; echo bg');
  assert.equal(v.$('.step-row .shimmer'), null);
  assert.equal(v.$('.step-live-link'), null);
  await v.rerender(row([]));
  assert.equal(label(v), 'Ran sleep 90; echo bg');
  // a task that failed says so on its row (no card elsewhere does)
  await v.rerender(row([{ id: 'k', toolUseId: 'c1', status: 'failed' }]));
  assert.equal(label(v), 'Ran sleep 90; echo bg · failed');
  assert.ok(v.$('.step-row .step-exit'));
  // Codex puts the exit code on the item: that says it, once
  const exited = { ...bg, exitCode: 2 };
  sessionNow = { tasks: [{ id: 'k', toolUseId: 'c1', status: 'failed' }] };
  await v.rerender(
    h(AgentChatContext.Provider, { value: 'chat-1' }, h(StepRow, { step: { kind: 'command', item: exited } as any, cwd: '/r' })),
  );
  assert.equal(label(v), 'Ran sleep 90; echo bg · exit 2');
  // Codex's tasks come from the app, not the session: the same row follows one of those
  const { putAdapterTasks } = await import('../src/store/backgroundTasks.ts');
  putAdapterTasks('chat-1', [{ id: 'codex-shell:p', toolUseId: 'c1', status: 'running' } as any]);
  await v.rerender(row([]));
  assert.equal(label(v), 'Running sleep 90; echo bgView live output');
  putAdapterTasks('chat-1', []);
  // outside any chat (no context) there is no tab to open
  sessionNow = { tasks: [{ id: 'k', toolUseId: 'c1', status: 'running' }] };
  await v.rerender(h(StepRow, { step: { kind: 'command', item: bg } as any, cwd: '/r' }));
  assert.equal(label(v), 'Running sleep 90; echo bg');
  assert.equal(v.$('.step-live-link'), null);
  // an ordinary command never looks at the tasks, and a declined one says so
  await v.rerender(h(StepRow, { step: { kind: 'command', item: command('c2', 'ls') } as any, cwd: '/r' }));
  assert.equal(label(v), 'Ran ls');
  await v.rerender(h(StepRow, { step: { kind: 'command', item: { ...bg, status: 'declined' } } as any, cwd: '/r' }));
  assert.equal(label(v), 'Declined sleep 90; echo bg');
  await v.unmount();
});

test('a collapsed group offers "View live output" while a background command inside it runs', async () => {
  const bg = { ...command('c1', 'sleep 90; echo bg'), background: true };
  const plain = [command('c0', 'ls'), bg];
  sessionNow = { tasks: [{ id: 'k', toolUseId: 'c1', status: 'running' }] };
  const v = await render(group(plain));
  // the summary row keeps its place; the link follows it
  const link = v.$('.step-group > .step-row.summary + .step-live-link');
  assert.ok(link);
  await settle(() => link.click());
  assert.deepEqual(callsTo('panes:toggleTasksPane').at(-1), ['chat-1']);
  // open, the command's own row carries it instead
  await settle(() => v.$('.step-row.summary > .step-row-hit')!.click());
  assert.equal(v.$('.step-group > .step-live-link'), null);
  assert.ok(v.$('.step-list .step-live-link'));
  await v.unmount();
  // settled, or a command not sent to the background: no link
  sessionNow = { tasks: [{ id: 'k', toolUseId: 'c1', status: 'completed' }] };
  const done = await render(group(plain));
  assert.equal(done.$('.step-live-link'), null);
  await done.unmount();
  sessionNow = { tasks: [{ id: 'k', toolUseId: 'c0', status: 'running' }] };
  const fg = await render(group(plain));
  assert.equal(fg.$('.step-live-link'), null);
  await fg.unmount();
  // outside any chat there is no tab to open
  sessionNow = { tasks: [{ id: 'k', toolUseId: 'c1', status: 'running' }] };
  const loose = await render(h(StepGroup, { items: plain as any, cwd: '/repo', active: false }));
  assert.equal(loose.$('.step-live-link'), null);
  await loose.unmount();
  // while the group runs, the current step's line carries it for a command sent to the background earlier
  sessionNow = { tasks: [{ id: 'k', toolUseId: 'c1', status: 'running' }] };
  const running = await render(group([bg, thought('t', 'x')], true));
  assert.ok(running.$('.step-row.active .step-live-link'));
  await running.unmount();
  const dots = await render(
    h(
      AgentChatContext.Provider,
      { value: 'chat-1' },
      h(StepGroup, { items: [bg, thought('t', 'x')] as any, cwd: '/repo', active: true, ux: 'dots' }),
    ),
  );
  // beside the running row's toggle, never inside it: the link is a button of its own
  assert.ok(dots.$('.claude-step-head > button.claude-activity + .step-live-link'));
  assert.equal(dots.$('button.claude-activity .step-live-link'), null);
  await dots.unmount();
  // an agent group folded shut does the same, after its header
  const withAgent = [agent('a1', 'completed'), bg];
  const a = await render(group(withAgent));
  assert.ok(a.$('.agent-group-main > .agent-group-head + .step-live-link'));
  await settle(() => head(a).click());
  assert.equal(a.$('.agent-group-main > .step-live-link'), null);
  await a.unmount();
  sessionNow = { tasks: [] };
});

test('consecutive thoughts in the card read as one row, a step between them keeps two', async () => {
  setStore({ prefs: { showReasoning: true } });
  const s = await render(
    group([agent('A', 'completed'), thought('r1', 'first'), thought('r2', 'second'), command('c', 'ls'), thought('r3', 'third')], false),
  );
  await settle(() => head(s).click());
  const cells = s.$$('.agent-card-cell').map((c: HTMLElement) => c.textContent);
  // the agent's own row, then one row for r1 and r2, the command, and r3 on its own
  assert.deepEqual(cells.slice(1), ['Thought', 'Ran ls', 'Thought']);
  await s.unmount();
});
