// The strips above the composer (computer control, background tasks, another app holding the chat), the goal's pill
// and card, and the plan and review cards, rendered against a fake store and session.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import {
  mockStore,
  autoMock,
  stubComponent,
  render,
  resetStore,
  setStore,
  trustedClick,
  callsTo,
  moduleCalls,
  native,
  impl,
  key,
  settle,
  window,
} from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown') });
autoMock('src/session/open.ts', 'open');
autoMock('src/store/panes.ts', 'panes');
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { StatusStrip } = await import('../src/components/thread/StatusStrip.tsx');
const { ComputerActivity } = await import('../src/components/thread/ComputerActivity.tsx');
const { GoalMark, goalShown } = await import('../src/components/thread/GoalBar.tsx');
const { ComposerPills } = await import('../src/components/thread/ComposerPills.tsx');
const { ElsewhereNotice } = await import('../src/components/thread/ElsewhereNotice.tsx');
const { PlanCard, pendingPlan } = await import('../src/components/thread/PlanCard.tsx');
const { ReviewCard } = await import('../src/components/thread/ReviewCard.tsx');

const T = 't1';
const session = (patch: any) => useSessions.setState({ sessions: { [T]: { ...EMPTY_SESSION, rev: 1, ...patch } } });
const computerCalls: any[] = [];
native.computer = {
  resume: (id: string) => computerCalls.push(['resume', id]),
  stop: (id: string) => computerCalls.push(['stop', id]),
  openSettings: (p: string) => computerCalls.push(['settings', p]),
  requestPermission: async (p: string) => computerCalls.push(['request', p]),
  recheck: async (id: string) => computerCalls.push(['recheck', id]),
  // what is granted, read by the permission card (not recorded)
  status: async () => ({ permissions: {} }),
};
beforeEach(() => {
  resetStore();
  for (const action of ['pauseGoal', 'resumeGoal', 'clearGoal', 'extendGoal']) impl[`store:${action}`] = async () => {};
  useSessions.setState({ sessions: {} });
  computerCalls.length = 0;
  moduleCalls.length = 0;
});
const text = (el: Element | null) => el?.textContent ?? '';
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLElement;

/* ---------------------------------------------------------------- computer */

test('computer control: nothing without it; Stop needs a real click; the reader is named', async () => {
  const v = await render(h(ComputerActivity, { threadId: T }));
  assert.equal(v.host.innerHTML, '');
  await settle(() => session({ computer: { app: 'Safari', state: 'active', read: null } }));
  assert.equal(text(v.$('.elsewhere-title')), 'Using Safari · Esc to stop');
  assert.equal(v.$('.cu-activity')?.dataset.state, 'active');
  assert.ok(v.$('.elsewhere-icon > .cu-activity-dot'), 'the working strip carries the pulsing dot');
  await settle(() => button(v.host, 'Stop').click()); // synthetic: ignored
  assert.deepEqual(computerCalls, []);
  await trustedClick(button(v.host, 'Stop'));
  assert.deepEqual(computerCalls, [['stop', T]]);
  await settle(() => session({ computer: { app: 'Safari', state: 'active', read: { model: 'gpt-x', vendor: 'OpenAI' } } }));
  assert.match(text(v.$('.elsewhere-title')), /Esc to stop · .*gpt-x/);
  await settle(() => session({ computer: { app: 'Safari', state: 'reading', read: { text: true } } }));
  assert.ok(text(v.$('.elsewhere-title')).length > 0);
  assert.ok(v.$('.cu-activity-dot'), 'reading the screen is work too');
  assert.ok(!v.$('.elsewhere-actions'));
  await v.unmount();
});

test('after a takeover Done, continue hands control back; a waiting chat can jump to the holder', async () => {
  session({ computer: { app: 'Notes', state: 'takeover' } });
  const v = await render(h(ComputerActivity, { threadId: T }));
  assert.equal(text(v.$('.elsewhere-title')), 'You took over Notes');
  assert.ok(!v.$('.cu-activity-dot'), 'a paused agent does not pulse');
  await settle(() => button(v.host, 'Done, continue').click());
  await trustedClick(button(v.host, 'Done, continue'));
  assert.deepEqual(computerCalls, [['resume', T]]);
  await settle(() => session({ computer: { app: 'Notes', state: 'waiting', holder: 'other' } }));
  assert.equal(text(v.$('.elsewhere-title')), 'Notes · in use by another chat');
  await settle(() => button(v.host, 'View').click());
  assert.deepEqual(callsTo('panes:navigate'), [[{ name: 'thread', id: 'other' }]]);
  await settle(() => session({ computer: { app: 'Notes', state: 'waiting', holder: T } }));
  assert.ok(!v.$('.elsewhere-actions'));
  await settle(() => session({ computer: { app: 'Notes', state: 'waiting', holder: null } }));
  assert.ok(!v.$('.elsewhere-actions'));
  await v.unmount();
});

test('a missing permission shows the permission card: request, open settings, look again', async () => {
  impl['store:chatHarnessLabel'] = () => 'Codex';
  session({ computer: { app: 'Notes', state: 'permission' } });
  const v = await render(h(ComputerActivity, { threadId: T }));
  assert.equal(v.$('.cu-permission')?.dataset.permission, 'accessibility');
  assert.match(text(v.$('.cu-guide-text')), /Codex/);
  // Request and Open settings for the missing permission, Open settings for Screen Recording, Try again
  const [req, settings, , recheck] = v.$$('button');
  for (const b of [req, settings, recheck]) await settle(() => b.click());
  assert.deepEqual(computerCalls, []);
  await trustedClick(req);
  await trustedClick(settings);
  await trustedClick(recheck);
  assert.deepEqual(computerCalls, [
    ['request', 'accessibility'],
    ['recheck', T],
    ['settings', 'accessibility'],
    ['recheck', T],
  ]);
  await settle(() => session({ computer: { app: 'Notes', state: 'permission', permission: 'screenRecording' } }));
  assert.equal(v.$('.cu-permission')?.dataset.permission, 'screenRecording');
  await v.unmount();
});

/* ---------------------------------------------------------------- goal */

const codexGoal = (patch: any = {}) => ({ objective: 'Ship it', status: 'active', tokenBudget: 200000, tokensUsed: 1500, ...patch });

/** The chat's pill row: the goal pill. */
const pills = () => h(ComposerPills, { threadId: T, showGoal: true });
/** The goal card the pill opens (it renders in its own layer, outside the view). */
const card = () => document.querySelector('.goal-card') as HTMLElement | null;
const openCard = async (v: { $: (s: string) => HTMLElement | null }) => {
  if (!card()) await settle(() => v.$('.goal-pill')!.click());
  return card()!;
};

test('a Codex goal: pause, and edit its objective (Cancel backs out, a blank one is refused)', async () => {
  session({ goal: codexGoal() });
  const v = await render(pills());
  assert.equal(v.$('.goal-pill')?.title, 'Ship it');
  assert.equal(v.$('.goal-pill')?.dataset.tone, 'running');
  // the pill never carries the budget; the card does, once the goal has one
  assert.doesNotMatch(text(v.$('.goal-pill')), /token|Goal|Active/);
  const c = await openCard(v);
  assert.equal(text(c.querySelector('.goal-budget')), '200k token budget (soft, checked between turns) · 2k used');
  assert.ok(!button(c, 'Edit budget'));
  await settle(() => button(c, 'Pause').click());
  assert.deepEqual(callsTo('store:pauseGoal'), [[T]]);
  await settle(() => button(card()!, 'Edit goal').click());
  const input = () => card()!.querySelector('textarea') as HTMLTextAreaElement;
  assert.equal(input().value, 'Ship it');
  await key(input(), 'keydown', { key: 'a' });
  assert.ok(input());
  await settle(() => button(card()!, 'Cancel').click());
  assert.ok(!card()!.querySelector('form'));
  await settle(() => button(card()!, 'Edit goal').click());
  const set = (value: string) =>
    settle(() => {
      const el = input();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
    });
  const submit = () =>
    settle(() =>
      card()!
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as any),
    );
  await set('   ');
  assert.equal(input().value, '   ');
  await submit();
  assert.deepEqual(callsTo('store:editGoal'), []);
  impl['store:editGoal'] = async () => true;
  await set(' Ship it today ');
  await submit();
  assert.deepEqual(callsTo('store:editGoal'), [[T, 'Ship it today']]);
  assert.ok(!card()!.querySelector('form'));
  await settle(() => button(card()!, 'Clear').click());
  assert.deepEqual(callsTo('store:clearGoal'), [[T]]);
  await v.unmount();
  assert.equal(card(), null);
});

test('a goal without a budget has no budget line; a paused one resumes; one paused at quit says so in its card', async () => {
  session({ goal: codexGoal({ status: 'paused', tokenBudget: null, pausedAtQuit: true }) });
  const v = await render(pills());
  assert.equal(text(v.$('.goal-pill')), 'Paused');
  assert.equal(v.$('.goal-pill')?.getAttribute('aria-label'), 'Goal, Paused');
  const c = await openCard(v);
  assert.equal(text(c.querySelector('.goal-card-summary')), 'Paused when MoPilot quit');
  assert.ok(!c.querySelector('.goal-budget'));
  assert.ok(!button(c, 'Pause'));
  await settle(() => button(c, 'Resume').click());
  assert.deepEqual(callsTo('store:resumeGoal'), [[T]]);
  await settle(() => button(card()!, 'Edit goal').click());
  assert.equal((card()!.querySelector('textarea') as HTMLTextAreaElement).value, 'Ship it');
  await settle(() => session({ goal: codexGoal({ status: 'blocked' }) }));
  assert.equal(text(v.$('.goal-pill')), 'Blocked');
  await v.unmount();
});

test('Claude goals: extra rounds at the limit, resume when paused, kept on screen when complete', async () => {
  const claudeGoal = (status: string, claude: any = { iterations: 30, limit: 30, lastReason: 'not yet' }) => ({
    objective: 'Fix tests',
    status,
    tokenBudget: null,
    tokensUsed: 0,
    claude,
  });
  session({ goal: claudeGoal('active', { iterations: 3, limit: null, lastReason: null }) });
  const v = await render(pills());
  assert.equal(text(v.$('.goal-pill')), '3 turns');
  await settle(() => session({ goal: claudeGoal('budgetLimited') }));
  assert.equal(text(v.$('.goal-pill')), 'Round limit reached');
  assert.equal(v.$('.goal-pill')?.dataset.tone, 'limit');
  const c = await openCard(v);
  assert.deepEqual([...c.querySelectorAll('.goal-card-summary')].map(text), [
    'Reached the limit (30 rounds). Goal paused · Limit set by MoPilot',
    'Last check: not yet',
  ]);
  assert.ok(!button(c, 'Resume'));
  assert.ok(!button(c, 'Edit goal'));
  await settle(() => button(c, '10 more rounds').click());
  assert.deepEqual(callsTo('store:extendGoal'), [[T]]);
  await settle(() => session({ goal: claudeGoal('paused') }));
  assert.ok(button(card()!, 'Resume'));
  await settle(() => session({ goal: claudeGoal('complete') }));
  assert.equal(text(v.$('.goal-pill')), 'Complete');
  await settle(() => session({ goal: codexGoal({ status: 'complete' }) }));
  assert.equal(v.host.innerHTML, '');
  assert.equal(card(), null);
  assert.equal(goalShown(null), false);
  await v.unmount();
});

test('the sidebar goal mark shows only for an unfinished goal', async () => {
  const v = await render(h(GoalMark, { threadId: T }));
  assert.equal(v.host.innerHTML, '');
  await settle(() => session({ goal: codexGoal({ status: 'complete' }) }));
  assert.equal(v.host.innerHTML, '');
  await settle(() => session({ goal: codexGoal() }));
  assert.equal(v.$('.row-goal')?.title, 'Goal · Active: Ship it');
  await v.unmount();
});

/* ---------------------------------------------------------------- tasks */

const tasks = [
  { id: 's1', type: 'local_bash', description: 'sleep', summary: '', status: 'running' },
  { id: 'amb', type: 'local_bash', ambient: true, status: 'running' },
  { id: 'done', type: 'local_bash', description: 'old', status: 'completed' },
];

test('the strip shows computer control first, then the Stop all question; the goal and the running count are not strips', async () => {
  const strip = (confirm = false) => h(StatusStrip, { threadId: T, approval: false, confirm, setConfirm: () => {} });
  setStore({ paneTabs: [], paneActive: '', diffPanel: { open: false } });
  const v = await render(strip());
  assert.ok(!v.$('.queued, .elsewhere-notice, .tasks-count'));
  // finished and housekeeping tasks ask nothing; a Skill call is never a task
  await settle(() => session({ tasks: [tasks[1], tasks[2]] }));
  assert.ok(!v.$('.tasks-bar'));
  await settle(() =>
    setStore({
      runtime: { [T]: { activeTurnId: 'turn', turns: [{ items: [{ type: 'mcpToolCall', tool: 'Skill', id: 'sk', arguments: {} }] }] } },
    }),
  );
  assert.ok(!v.$('.tasks-bar'));
  await settle(() => setStore({ runtime: {} }));
  await settle(() => session({ tasks }));
  // a running task shows its count in the turn's status line, not above the composer
  assert.equal(v.host.innerHTML, '');
  await v.rerender(strip(true));
  assert.equal(text(v.$('.tasks-bar .queued-text')), 'Stop all 1 background tasks?');
  await v.rerender(strip());
  // the goal is no strip (it has its pill), and the Stop-all question does not wait for it
  await settle(() => session({ tasks, goal: codexGoal() }));
  assert.equal(v.host.innerHTML, '');
  await v.rerender(strip(true));
  assert.equal(text(v.$('.tasks-bar .queued-text')), 'Stop all 1 background tasks?');
  await settle(() => session({ tasks, goal: codexGoal(), computer: { app: 'Mail', state: 'active' } }));
  assert.ok(v.$('.cu-activity'));
  await v.rerender(h(StatusStrip, { threadId: T, approval: true, confirm: false, setConfirm: () => {} }));
  assert.ok(v.$('.cu-activity'));
  await settle(() => session({ goal: codexGoal() }));
  await v.rerender(h(StatusStrip, { threadId: T, approval: true, confirm: false, setConfirm: () => {} }));
  assert.equal(v.host.innerHTML, ''); // the approval card itself takes the place
  await v.unmount();
});

test('Your Chrome waiting for the connection approval: the strip says where to approve it, after a pending card (CM-Y02e)', async () => {
  const strip = (approval: boolean) => h(StatusStrip, { threadId: T, approval, confirm: false, setConfirm: () => {} });
  setStore({ paneTabs: [], paneActive: '', diffPanel: { open: false } });
  session({ chromeApproval: true, goal: codexGoal() });
  const v = await render(strip(false));
  assert.equal(v.$('.elsewhere-notice')?.dataset.state, 'approve');
  assert.equal(text(v.$('.elsewhere-title')), 'Waiting for you in Chrome');
  assert.match(text(v.$('.elsewhere-body')), /^Approve it in Chrome: click "Allow & select"/);
  await v.rerender(strip(true));
  assert.equal(v.host.innerHTML, '');
  await v.unmount();
});

/* ---------------------------------------------------------------- another app */

test('another app holding the chat: running, open there (hard or soft), and the held message', async () => {
  const v = await render(h(ElsewhereNotice, { threadId: T }));
  assert.equal(v.host.innerHTML, '');
  await settle(() => setStore({ elsewhere: { [T]: { app: 'claude-cli', running: true } } }));
  assert.equal(text(v.$('.elsewhere-title')), 'Claude Code in a terminal is working on this chat.');
  assert.equal(text(v.$('.elsewhere-body')), 'You can watch here, and continue once it finishes.');
  const long = 'x'.repeat(150);
  await settle(() => setStore({ runtime: { [T]: { held: { text: long } } } }));
  assert.equal(text(v.$('.elsewhere-body')), 'Your message will be sent when it finishes.');
  assert.equal(text(v.$('.elsewhere-held')), `“${'x'.repeat(140)}…”`);
  await settle(() => button(v.host, 'Cancel').click());
  assert.deepEqual(callsTo('store:cancelHeld'), [[T]]);

  await settle(() =>
    setStore({ elsewhere: { [T]: { app: 'claude-desktop', running: false, hard: true } }, runtime: { [T]: { held: { text: 'hi' } } } }),
  );
  assert.equal(text(v.$('.elsewhere-title')), 'This chat is open in Claude desktop.');
  assert.match(text(v.$('.elsewhere-body')), /^Your message sends once/);
  assert.equal(text(v.$('.elsewhere-held')), '“hi”');
  await settle(() => setStore({ runtime: {} }));
  assert.equal(text(v.$('.elsewhere-body')), 'Close it there, or switch to another chat, to continue here.');

  await settle(() => setStore({ elsewhere: { [T]: { app: 'sage', running: false, hard: false } } }));
  assert.equal(v.host.innerHTML, '', 'idle processes do not display the notice');
  await settle(() => setStore({ runtime: { [T]: { held: { text: 'hi' } } } }));
  await settle(() => button(v.host, 'Send here').click());
  assert.deepEqual(callsTo('store:continueHere'), [[T]]);
  await settle(() => setStore({ runtime: { [T]: { held: { text: 'hi' } } } }));
  assert.match(text(v.$('.elsewhere-body')), /^Send it here\?/);
  assert.ok(button(v.host, 'Send here'));
  await settle(() => setStore({ runtime: { [T]: { held: { text: 'hi' }, continueHere: true } } }));
  assert.ok(button(v.host, 'Send here')); // still holding a message
  await settle(() => setStore({ runtime: { [T]: { continueHere: true } } }));
  assert.equal(v.host.innerHTML, ''); // already continuing here

  await settle(() => setStore({ elsewhere: {}, runtime: { [T]: { held: { text: 'later' } } } }));
  assert.equal(text(v.$('.elsewhere-title')), 'Your message is waiting.');
  await settle(() => button(v.host, 'Send now').click());
  assert.deepEqual(callsTo('store:sendHeld'), [[T, true]]);
  await v.unmount();
});

/* ---------------------------------------------------------------- cards */

test("a plan Claude's call carried no text for shows the plan its approval card asks about, until the result fills it in (#1933)", async () => {
  const planFilePath = '/Users/me/Library/Application Support/MoPilot Code/claude-accounts/a1/plans/q.md';
  const ask = (params: any, method = 'claude/permission') => ({ id: 'cperm-1', method, params });
  session({ approvals: [ask({ toolName: 'ExitPlanMode', toolUseID: 'tu1', input: { plan: '# Steps', planFilePath } })] });
  setStore({ runtime: { [T]: { activeTurnId: 'current', turns: [] } } });
  const v = await render(h(PlanCard, { item: { id: 'tu1', text: '' }, cwd: '/repo', threadId: T, turnId: 'current' }));
  assert.equal(v.$('[data-stub="Markdown"]')?.dataset.text, '# Steps');
  assert.equal(text(v.$('.plan-card-path')), ' q.md');
  await v.unmount();
  // the item's own text and file win; a request for another call, tool or harness, or with no input, is not this plan
  const own = { id: 'tu1', text: '# Own', planFilePath: '/own.md' };
  assert.equal(pendingPlan(own, [ask({ toolName: 'ExitPlanMode', toolUseID: 'tu1', input: { plan: 'x' } })]), own);
  const empty = { id: 'tu1', text: '', planFilePath: '/own.md' };
  for (const a of [
    ask({ toolName: 'ExitPlanMode', toolUseID: 'tu2', input: { plan: 'x' } }),
    ask({ toolName: 'Bash', toolUseID: 'tu1', input: { plan: 'x' } }),
    ask({ toolName: 'ExitPlanMode', toolUseID: 'tu1', input: { plan: 'x' } }, 'acp/permission'),
    ask({ toolName: 'ExitPlanMode', toolUseID: 'tu1' }),
    { id: 'x', method: 'claude/permission', params: undefined },
  ])
    assert.equal(pendingPlan(empty, [a as any]), empty);
  assert.equal(pendingPlan({ text: '' }, [ask({ toolName: 'ExitPlanMode', toolUseID: undefined, input: { plan: 'x' } })]).text, '');
  // a request whose plan or file is not text keeps what the item has
  assert.deepEqual(
    pendingPlan(empty, [ask({ toolName: 'ExitPlanMode', toolUseID: 'tu1', input: { plan: 3, planFilePath: '/new.md' } })]),
    empty,
  );
  assert.deepEqual(
    pendingPlan({ id: 'tu1' }, [ask({ toolName: 'ExitPlanMode', toolUseID: 'tu1', input: { plan: 'p', planFilePath: 7 } })]),
    {
      id: 'tu1',
      text: 'p',
      planFilePath: null,
    },
  );
});

test('the plan card shows the plan and opens the file Claude saved it to, named without its app-data folder (#1933)', async () => {
  const planFilePath = '/Users/me/Library/Application Support/MoPilot Code/claude-accounts/a1/plans/p.md';
  const v = await render(h(PlanCard, { item: { planFilePath }, cwd: '/repo' }, h('b', null, 'extra')));
  assert.equal(v.$('[data-stub="Markdown"]')?.dataset.text, '');
  assert.equal(text(v.$('.plan-card-path')), ' p.md');
  assert.equal(v.$('.plan-card-path')?.getAttribute('title'), planFilePath);
  await settle(() => v.$('.plan-card-path')!.click());
  assert.equal(callsTo('open:openMessageLink')[0][0], planFilePath);
  assert.equal(text(v.$('b')), 'extra');
  await v.rerender(h(PlanCard, { item: { text: 'do it' }, cwd: '/repo' }));
  assert.ok(!v.$('.plan-card-path'));
  assert.equal(v.$('[data-stub="Markdown"]')?.dataset.text, 'do it');
  await v.unmount();
});

test('the review card names what it reviewed', async () => {
  const v = await render(h(ReviewCard, { item: { id: 'r', review: 'LGTM', target: { type: 'commit' } }, cwd: '/r' }));
  assert.equal(text(v.$('.plan-card-head')), 'Review · Commit');
  await v.rerender(h(ReviewCard, { item: { id: 'r', review: 'LGTM' }, cwd: '/r' }));
  assert.equal(text(v.$('.plan-card-head')), 'Review');
  await v.unmount();
});
