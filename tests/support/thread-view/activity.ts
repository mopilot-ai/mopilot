// Conversation-view UI unit cases for activity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  render,
  settle,
  flush,
  setStore,
  setRunningCalls,
  impl,
  callsTo,
  moduleCalls,
  window,
  T,
  text,
  user,
  reply,
  turn,
  chat,
  view,
} from './fixture.ts';
import { EMPTY_SESSION } from '../../../src/store/session/sessionState.ts';
import { LABEL_DWELL_MS } from '../../../src/lib/minDwell.ts';

export function registerActivity() {
  test('a running turn: the timer, the current step and a thinking row, with no files-changed pill', async () => {
    const now = Date.now();
    const running = turn(
      't1',
      [
        user('u1', 'Fix it'),
        { id: 'c1', type: 'commandExecution', command: 'npm test', status: 'completed' },
        {
          id: 'f1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: '/repo/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' }],
        },
      ],
      { status: 'inProgress', startedAt: (now - 5000) / 1000 },
    );
    chat([running], { activeTurnId: 't1' });
    const v = await render(view());
    // a running turn has no header in any harness: its activity line carries the clock
    assert.equal(v.$('.worked-for'), null);
    assert.match(text(v.$('.claude-activity-time')), /^[56]s$/);
    // the turn has changed a file, but no pill above the composer repeats its totals
    assert.equal(v.$('.composer-pills'), null);
    // scrolled up while it works: the scroll-to-bottom button shows the working mark, in its own place
    const scroller = v.$('.thread-scroll')!;
    for (const [k, val] of Object.entries({ scrollHeight: 1000, clientHeight: 300 }))
      Object.defineProperty(scroller, k, { configurable: true, get: () => val });
    await flush();
    scroller.scrollTop = 100;
    await settle(() => scroller.dispatchEvent(new window.Event('scroll') as any));
    const down = v.$('.scroll-bottom')!;
    assert.equal(down.className.split(/\s+/).filter(Boolean).join(' '), 'scroll-bottom working');
    const mark = down.querySelector('.working-mark');
    assert.ok(mark, 'the working mark stands in for the arrow');
    assert.equal(mark.getAttribute('data-activity'), 'default');
    assert.ok(down.querySelector('.scroll-bottom-arrow'), 'the arrow is there for hover');
    // a reply as the last block: the thinking row follows it
    const withReply = { ...running, items: [...running.items, { id: 's', type: 'contextCompaction' }] };
    await settle(() => chat([withReply], { activeTurnId: 't1' }));
    // after a reply the turn is waiting on the model again
    assert.equal(v.$('.turn-status-slot .claude-activity .working-mark')?.getAttribute('data-activity'), 'think');
    assert.equal(text(v.$('.turn-status-slot .claude-activity-thinking')), '· Thinking…');
    assert.equal(v.$('.turn-status-slot .claude-activity .claude-activity-label'), null);
    // nothing at all yet: the thinking mark, and no clock before two seconds
    await settle(() => chat([turn('t1', [user('u1', 'Hi')], { status: 'inProgress' })], { activeTurnId: 't1' }));
    const thinking = v.$('.turn-status-slot .claude-activity')!;
    assert.equal(thinking.querySelector('.working-mark')?.getAttribute('data-activity'), 'think');
    assert.equal(thinking.querySelector('.claude-activity-label'), null);
    assert.equal(thinking.querySelector('.claude-activity-time'), null);
    assert.equal(v.$('.worked-for'), null);
    await v.unmount();
  });

  test("the chat's goal: its pill sits in the row above the composer, which the scroll button clears, but not in a read-only thread", async () => {
    const goal = { objective: 'Ship it', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 60, createdAt: 1 };
    impl['session:useSession'] = () => ({ ...EMPTY_SESSION, goal });
    impl['session:useSessions'] = (select: (s: any) => unknown) => select({ sessions: { [T]: { goal } } });
    chat([turn('t1', [user('u1', 'Go'), reply('a1', 'Done')], { durationMs: 1000 })]);
    const v = await render(view());
    // no turn runs: the goal pill alone
    assert.equal(text(v.$('.composer-pills')), '1m');
    const scroller = v.$('.thread-scroll')!;
    for (const [k, val] of Object.entries({ scrollHeight: 1000, clientHeight: 300 }))
      Object.defineProperty(scroller, k, { configurable: true, get: () => val });
    await flush();
    scroller.scrollTop = 100;
    await settle(() => scroller.dispatchEvent(new window.Event('scroll') as any));
    assert.equal(v.$('.scroll-bottom')!.className.split(/\s+/).filter(Boolean).join(' '), 'scroll-bottom above-pill');
    await v.unmount();
    // a sub-agent's read-only thread shows no goal
    const ro = await render(view({ readOnly: true }));
    assert.equal(ro.$('.composer-pills'), null);
    await ro.unmount();
  });

  test('a finished turn keeps a still-running background agent in view while the rest of its work folds', async () => {
    const agent = (status: string) => ({
      id: 'ag',
      type: 'dynamicToolCall',
      tool: 'Task',
      status: 'completed',
      agent: {
        key: 'A',
        description: 'Track A: fix it',
        status,
        background: true,
        prompt: null,
        model: null,
        toolUses: 0,
        latestTool: null,
        tokens: null,
        startedAt: null,
        completedAt: null,
        report: null,
        transcript: 'full',
      },
    });
    const items = (status: string) => [
      user('u1', 'Go'),
      { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed' },
      reply('a0', 'Listing first'),
      agent(status),
      reply('a1', 'Launched'),
    ];
    chat([turn('t1', items('running'), { durationMs: 5000 })]);
    const v = await render(view());
    assert.equal(text(v.$('.worked-for span')), 'Worked for 5s');
    // the agent group stays under the fold's header; the command folded away
    assert.equal(!!v.$('.work .agent-group'), true);
    assert.equal(text(v.$('.work')).includes('ls'), false);
    assert.equal(text(v.$('.work')).includes('Listing first'), false);
    // once the agent settles it folds like any other work
    chat([turn('t1', items('completed'), { durationMs: 5000 })]);
    await v.rerender(view());
    assert.equal(!!v.$('.work'), false);
    // a command sent to the background stays in view the same way while its task runs, and folds once it ends
    const bg = [user('u1', 'Go'), { id: 'b1', type: 'commandExecution', command: 'npm run dev', status: 'completed', background: true }];
    setRunningCalls(['b1']);
    chat([turn('t1', bg, { durationMs: 5000 })]);
    await v.rerender(view());
    assert.equal(text(v.$('.work')).includes('npm run dev'), true);
    // a foreground command with the same id never pins
    chat([turn('t1', [user('u1', 'Go'), { ...bg[1], background: false }], { durationMs: 5000 })]);
    await v.rerender(view());
    assert.equal(!!v.$('.work'), false);
    setRunningCalls([]);
    chat([turn('t1', bg, { durationMs: 5000 })]);
    await v.rerender(view());
    assert.equal(!!v.$('.work'), false);
    await v.unmount();
  });

  test('a finished turn folds its work under "Worked for", and the last turn offers the plan', async () => {
    const done = turn(
      't1',
      [
        user('u1', 'Plan it'),
        { id: 'r1', type: 'reasoning', summary: ['thinking hard'] },
        { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed' },
        { id: 'p1', type: 'plan', text: '1. do it' },
        reply('a1', 'Here is the plan'),
      ],
      { durationMs: 65000, plan: { steps: [{ step: 'one', status: 'completed' }] } },
    );
    chat([done]);
    const v = await render(view());
    assert.equal(text(v.$('.worked-for span')), 'Worked for 1m 5s');
    assert.ok(!v.$('.work'));
    await settle(() => v.$('.worked-for')!.click());
    assert.ok(v.$('.work .step-group, .work .step'));
    await settle(() => v.$('.worked-for')!.click());
    assert.ok(!v.$('.work'));
    // its finished plan leaves the turn box, as in Claude Desktop
    assert.ok(!v.$('.turn-tasks'));
    assert.equal(text(v.$('.plan-card-head > span')), 'Plan');
    assert.equal(text(v.$('.plan-card-head button')), 'Open plan');
    assert.equal(v.$('.assistant-message [data-stub="Markdown"]')!.dataset.text, 'Here is the plan');
    impl['store:sendMessage'] = async () => true;
    // the chat is in plan mode until the click turns it off
    let planning = true;
    impl['session:sessionOf'] = () => ({ plan: planning });
    impl['session:setSession'] = (_id: string, patch: { plan: boolean }) => void (planning = patch.plan);
    await settle(() => v.$('.plan-card-actions button')!.click());
    assert.deepEqual(callsTo('session:setSession'), [[T, { plan: false }]]);
    assert.deepEqual(callsTo('store:sendMessage'), [
      [T, 'Implement the plan.', [], { plan: false, human: true, acceptedPlan: { itemId: 'p1', text: '1. do it' } }],
    ]);
    // main didn't take it (sendMessage said why), or the send failed: the chat stays in plan mode, to implement again
    impl['store:sendMessage'] = async () => false;
    planning = true;
    await settle(() => v.$('.plan-card-actions button')!.click());
    impl['store:sendMessage'] = async () => {
      throw new Error('bridge gone');
    };
    impl['store:toastFailure'] = (what: string) => (e: Error) => moduleCalls.push(['failed', [what, e.message]]);
    planning = true;
    await settle(() => v.$('.plan-card-actions button')!.click());
    assert.deepEqual(callsTo('session:setSession').slice(1), [
      [T, { plan: false }],
      [T, { plan: true }],
      [T, { plan: false }],
      [T, { plan: true }],
    ]);
    assert.deepEqual(callsTo('failed'), [["Couldn't implement the plan", 'bridge gone']]);
    // a chat that wasn't in plan mode isn't put in it
    planning = false;
    impl['store:sendMessage'] = async () => false;
    await settle(() => v.$('.plan-card-actions button')!.click());
    assert.equal(planning, false);
    assert.equal(callsTo('session:setSession').length, 6);
    // an earlier turn keeps neither the plan button nor the todo list
    await settle(() => chat([done, turn('t2', [user('u2', 'next')])]));
    assert.equal(v.$$('.plan-card-actions').length, 0);
    assert.equal(v.$$('.todo-card').length, 0);
    // an approved plan has no button
    await settle(() => chat([turn('t1', [{ id: 'p1', type: 'plan', text: 'x', approvedInTurn: true }])]));
    assert.ok(!v.$('.plan-card-actions'));
    await v.unmount();
  });

  test('a plan approved mid-turn stays where it was approved; the work carrying it out shows below it', async () => {
    const items = [
      user('u1', 'Redesign it'),
      { id: 'c0', type: 'commandExecution', command: 'ls', status: 'completed' },
      { id: 'p1', type: 'plan', text: '1. do it', approvedInTurn: true },
      { id: 'c1', type: 'commandExecution', command: 'npm test', status: 'inProgress' },
    ];
    chat([turn('t1', items, { status: 'inProgress', startedAt: Date.now() / 1000 })], { activeTurnId: 't1' });
    const v = await render(view());
    const order = () =>
      v
        .$$('.turn .step-group, .turn .step, .turn .plan-card, .turn-status-slot .claude-step')
        .map((e) => (e.matches('.plan-card') ? 'plan' : 'step'));
    assert.equal(v.$$('.plan-card').length, 1);
    assert.deepEqual(order(), ['step', 'plan', 'step']);
    // done: the work folds, the plan stays in view above the reply, and still has no button
    await settle(() =>
      chat([turn('t1', [...items.slice(0, 3), { ...items[3], status: 'completed' }, reply('a1', 'Done')], { durationMs: 5000 })]),
    );
    assert.ok(v.$('.work .plan-card'));
    assert.ok(!v.$('.work .step-group, .work .step'));
    assert.ok(!v.$('.plan-card-actions'));
    assert.equal(v.$('.assistant-message [data-stub="Markdown"]')!.dataset.text, 'Done');
    // a plan nothing follows (rejected) still ends the turn, after its reply's fold, with the reply kept as the answer
    await settle(() => chat([turn('t1', [...items.slice(0, 2), reply('a0', 'Here it is'), items[2]], { durationMs: 5000 })]));
    assert.ok(!v.$('.work .plan-card'));
    assert.equal(v.$$('.plan-card').length, 1);
    assert.equal(v.$('.assistant-message [data-stub="Markdown"]')!.dataset.text, 'Here it is');
    await v.unmount();
  });

  test('a running group owns one row below the task list: the mark, what runs and the clock', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 0;
    t.mock.method(performance, 'now', () => clock);
    const now = Date.now();
    const heredoc = { id: 'c1', type: 'commandExecution', command: "python3 - <<'EOF'\nprint(1)\nEOF", status: 'inProgress' };
    const thought = { id: 'th', type: 'reasoning', summary: ['Plan the check'], content: [] };
    const at = (items: any[]) =>
      chat([turn('t1', [user('u1', 'Go'), ...items], { status: 'inProgress', startedAt: (now - 21_000) / 1000 })], {
        activeTurnId: 't1',
      });
    setStore({ prefs: { showReasoning: true } });
    at([thought, { ...heredoc, aggregatedOutput: '1\n' }]);
    const v = await render(view());
    // The tool row owns the mark and clock, with its thoughts available inside its disclosure.
    const row = () => v.$('.turn-status-slot .claude-activity')!;
    assert.equal(text(row().querySelector('.claude-activity-label')), 'Running python3…');
    assert.equal(row().querySelector('.working-mark')?.getAttribute('data-activity'), 'code');
    assert.match(text(row().querySelector('.claude-activity-time')), /^2[12]s$/);
    assert.equal(v.$$('.turn-status-slot .claude-activity').length, 1);
    assert.equal(v.$('.work .step-row-hit'), null, 'its thought is inside the row, not beside it');
    assert.equal(v.$('.work .claude-activity'), null, 'no live copy above the task list');
    // the row opens to the group's thought and the command's live output, and closes again
    const toggle = () => v.$('.turn-status-slot button.claude-activity.expandable') as HTMLButtonElement;
    assert.equal(toggle().getAttribute('aria-expanded'), 'false');
    await settle(() => toggle().click());
    assert.equal(toggle().getAttribute('aria-expanded'), 'true');
    assert.ok(v.$('.turn-status-slot .claude-step.open .step-list .step-row-hit'));
    assert.ok(v.$('.turn-status-slot .claude-step.open .step-list .shell-box'), 'the live output');
    // left open, the next command's output does not open by itself; reopening the row shows the one running then
    const next = { id: 'c2', type: 'commandExecution', command: 'npm test', status: 'inProgress', aggregatedOutput: 'x' };
    await settle(() => at([thought, { ...heredoc, status: 'completed' }, next]));
    assert.equal(text(row().querySelector('.claude-activity-label')), 'Running python3…', 'only the label waits out its dwell');
    clock += LABEL_DWELL_MS;
    await settle(() => t.mock.timers.tick(LABEL_DWELL_MS));
    assert.equal(text(row().querySelector('.claude-activity-label')), 'Running npm test');
    assert.equal(v.$('.turn-status-slot .claude-step.open .step-list .shell-box'), null);
    await settle(() => toggle().click());
    await settle(() => toggle().click());
    assert.ok(v.$('.turn-status-slot .claude-step.open .step-list .shell-box'));
    await settle(() => toggle().click());
    assert.equal(toggle().getAttribute('aria-expanded'), 'false');
    // a file read runs with nothing before it and no output: a plain row
    const read = { id: 'r1', type: 'commandExecution', command: 'Read /repo/a.ts', status: 'inProgress' };
    const actions = [{ type: 'read', command: 'Read', name: 'a.ts', path: '/repo/a.ts' }];
    await settle(() => at([{ ...read, commandActions: actions }]));
    assert.equal(text(v.$('.turn-status-slot .claude-activity-label')), 'Reading a.ts');
    assert.equal(v.$('.turn-status-slot button.claude-activity'), null);
    // between steps the model goes on: as Claude Desktop's row, it keeps the last step's words (never "Thinking…" for
    // the rest of the turn), the mark turns to thinking, and the row opens to the finished command
    await settle(() => at([{ ...heredoc, status: 'completed' }]));
    assert.equal(text(v.$('.turn-status-slot .claude-activity-label')), 'Running python3…');
    assert.equal(v.$('.turn-status-slot .claude-activity-thinking'), null);
    assert.equal(v.$('.turn-status-slot .working-mark')?.getAttribute('data-activity'), 'think');
    assert.ok(v.$('.turn-status-slot button.claude-activity.expandable'));
    assert.equal(v.$$('.claude-activity').length, 1, 'thinking between steps does not add a second line');
    await v.unmount();
  });

  test('the status stays below the task list through tools, commentary and agents', async () => {
    const plan = {
      steps: [
        { step: 'Find icon styling', status: 'inProgress' },
        { step: 'Fix alignment', status: 'pending' },
      ],
    };
    const at = (items: any[]) =>
      chat([turn('t1', [user('u1', 'Go'), ...items], { status: 'inProgress', startedAt: Date.now() / 1000 - 3, plan })], {
        activeTurnId: 't1',
      });
    at([]);
    const v = await render(view());
    const box = () => v.$('.turn-box.with-tasks')!;
    const below = (el: Element | null) => {
      assert.ok(el && box(), 'both the running line and the task list show');
      return Boolean(box().compareDocumentPosition(el) & window.Node.DOCUMENT_POSITION_FOLLOWING);
    };
    // nothing has run yet: the status slot's line
    assert.ok(below(v.$('.turn-status-slot .claude-activity')), 'the waiting line');
    // The running group takes over the same lower row and clock.
    await settle(() => at([{ id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed' }]));
    assert.ok(below(v.$('.turn-status-slot .claude-activity')), 'the running group row stays below the list');
    assert.equal(v.$('.work .claude-activity'), null);
    assert.equal(v.$$('.claude-activity').length, 1);
    // after commentary the slot's line again, in the same place
    await settle(() => at([reply('r1', 'Looking', { phase: 'commentary' })]));
    assert.ok(below(v.$('.turn-status-slot .claude-activity')), 'the waiting line after commentary');
    // only the turn's first wait holds back before it shows: after a step the line takes over at once, never blinking
    assert.ok(v.$('.turn-status-slot > .placeholder-reveal'), 'the first wait waits');
    const step = { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed' };
    await settle(() => at([step, reply('r1', 'Looking', { phase: 'commentary' })]));
    assert.ok(below(v.$('.turn-status-slot .claude-activity')));
    assert.equal(v.$('.turn-status-slot .placeholder-reveal'), null, 'after a step it shows at once');
    // a turn whose provider keeps failing: its stall banner sits with the line, under the list too
    await settle(() =>
      chat([turn('t1', [user('u1', 'Go')], { status: 'inProgress', startedAt: Date.now() / 1000 - 3, plan })], {
        activeTurnId: 't1',
        retry: 'Retrying in 3s',
      }),
    );
    assert.ok(below(v.$('.turn-stall')), 'the stall banner');
    // A running sub-agent takes over that same lower row.
    const agent = { key: 'A', description: 'Track A: fix it', status: 'running', prompt: null, model: null, toolUses: 0 };
    await settle(() => at([{ id: 'ag', type: 'dynamicToolCall', tool: 'Task', status: 'inProgress', agent }]));
    assert.ok(below(v.$('.turn-status-slot .claude-activity')), 'the running agent row stays below the list');
    assert.equal(v.$('.work .claude-activity'), null);
    // the line goes when the turn ends; the background tasks row stays under the list the turn was cut short on
    await settle(() => chat([turn('t1', [user('u1', 'Go'), reply('r2', 'Stopped')], { status: 'interrupted', plan })]));
    assert.equal(v.$('.claude-activity'), null);
    assert.ok(below(v.$('[data-stub="TasksStatusRow"]')), 'the background tasks row');
    await v.unmount();
  });

  test('the running-tasks count rides in the thinking row while the turn runs, then stands alone under the last turn', async () => {
    chat([turn('t1', [user('u1', 'Hi')], { status: 'inProgress' })], { activeTurnId: 't1' });
    const v = await render(view());
    const count = () => v.$('[data-stub="InlineTasksCount"]')?.dataset.chatid;
    assert.equal(count(), T);
    assert.equal(v.$('[data-stub="TasksStatusRow"]'), null);
    // The one activity line keeps it as ownership passes between a tool, a sub-agent's header and the footer.
    const at = (item: any) => chat([turn('t1', [user('u1', 'Hi'), item], { status: 'inProgress' })], { activeTurnId: 't1' });
    await settle(() => at({ id: 'c1', type: 'commandExecution', command: 'ls', status: 'inProgress' }));
    assert.equal(count(), T, 'while a step runs');
    const agent = { key: 'A', description: 'Track A: fix it', status: 'running', prompt: null, model: null, toolUses: 0 };
    await settle(() => at({ id: 'ag', type: 'dynamicToolCall', tool: 'Task', status: 'inProgress', agent }));
    assert.equal(count(), T, 'while a sub-agent runs');
    assert.ok(v.$('.turn-status-slot .claude-step-head > [data-stub="InlineTasksCount"]'), 'beside the single lower row');
    await settle(() =>
      at({ id: 'ag', type: 'dynamicToolCall', tool: 'Task', status: 'completed', agent: { ...agent, status: 'completed' } }),
    );
    assert.equal(count(), T, 'while the model thinks after it');
    assert.equal(v.$$('[data-stub="InlineTasksCount"]').length, 1);
    await settle(() => chat([turn('t0', [user('u0', 'Before')]), turn('t1', [user('u1', 'Hi')])]));
    const rows = v.$$('[data-stub="TasksStatusRow"]');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dataset.chatid, T);
    assert.ok(rows[0].closest('.turn-status-slot'), 'in the status slot, after the last turn');
    // a sub-agent's read-only thread has no status line of its own
    await v.rerender(view({ readOnly: true }));
    assert.equal(v.$('[data-stub="TasksStatusRow"]'), null);
    await v.unmount();
  });

  test('a running turn under a shimmer activity line says how long it has worked', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 12000 });
    const { TurnView } = await import('../../../src/components/thread/view/TurnView.tsx');
    const { createElement: h } = await import('react');
    const running = turn('t', [], { status: 'inProgress', startedAt: 10 });
    const props = { turn: running, cwd: '/repo', threadId: T, ux: 'shimmer' as const, isLast: true, live: true, readOnly: false };
    const v = await render(h(TurnView, { ...props, questionAnswers: new Map(), runningCalls: new Set<string>() }));
    assert.equal(text(v.$('.worked-for span')), 'Working for 2s');
    await v.unmount();
  });

  test('worked labels for stopped and untimed turns; hidden reasoning is no work', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 12000 });
    const v = await render(view());
    const label = async (extra: any, items: any[] = [{ id: 'c', type: 'commandExecution', command: 'ls', status: 'completed' }]) => {
      await settle(() => chat([turn('t', items, extra)]));
      return text(v.$('.worked-for span'));
    };
    assert.equal(await label({ status: 'interrupted' }), 'Stopped');
    assert.equal(await label({}), 'Worked');
    assert.equal(await label({ status: 'interrupted', startedAt: 10, completedAt: 12 }), 'Stopped after 2s');
    // its person stopped it (Stop, Esc, or Esc on the desktop): said so, as the Codex app does, even with no work to unfold
    assert.equal(await label({ status: 'interrupted', stoppedByYou: true, startedAt: 10, completedAt: 12 }), 'You stopped after 2s');
    assert.equal(await label({ status: 'interrupted', stoppedByYou: true }), 'You stopped');
    assert.equal(await label({ status: 'interrupted', stoppedByYou: true, startedAt: 10, completedAt: 12 }, []), 'You stopped after 2s');
    assert.ok(!v.$('.worked-for svg'), 'nothing to unfold');
    await settle(() => (v.$('.worked-for') as HTMLButtonElement).click());
    assert.ok(!v.$('.worked-for.open'));
    assert.equal(await label({ status: 'completed', stoppedByYou: true, startedAt: 10, completedAt: 12 }), 'Worked for 2s');
    assert.equal(await label({ startedAt: 10 }), 'Worked for 2s');
    assert.equal(await label({ durationMs: Infinity }), 'Worked for 0s');
    await settle(() => setStore({ prefs: { showReasoning: false } }));
    assert.equal(await label({}, [{ id: 'r', type: 'reasoning', summary: ['x'] }]), '');
    assert.ok(!v.$('.worked-for'));
    await settle(() => setStore({ prefs: { showReasoning: true } }));
    assert.equal(await label({}, [{ id: 'r', type: 'reasoning', summary: ['  '] }]), '');
    assert.equal(await label({}, [{ id: 'r', type: 'reasoning', summary: ['why'] }]), 'Worked');
    // unfolded, a timed thinking block says how long it thought
    await label({ itemTimes: { r: { start: 0, end: 2000 } } }, [{ id: 'r', type: 'reasoning', summary: ['why'] }]);
    await settle(() => (v.$('.worked-for') as HTMLButtonElement).click());
    assert.equal(text(v.$('.step .step-text')), 'Thought for 2s');
    await v.unmount();
  });

  test('the latest unanswered questions wait docked above the composer while the turn works on, not in the transcript', async () => {
    const question = { id: 'q1', type: 'agentMessage', text: '', questions: [{ title: 'Which?', options: ['a'] }] };
    const working = [user('u1', 'Ask me'), question, { id: 'c1', type: 'commandExecution', command: 'ls', status: 'inProgress' }];
    chat([turn('t1', working, { status: 'inProgress' })], { activeTurnId: 't1' });
    const v = await render(view());
    // above the composer, which stays to write instead, and not in the turn where status lines would push it up
    const dock = v.$('.thread-composer-area .docked-questions');
    assert.ok(dock?.querySelector('[data-stub="AsyncQuestions"][data-docked="true"]'));
    assert.ok(v.$('.thread-composer-area [data-stub="Composer"]'));
    assert.equal(v.$('.turn [data-stub="AsyncQuestions"]'), null);
    // the user wrote to the agent after it: the question goes back to where it was asked
    chat([turn('t1', [...working, user('u2', 'never mind')], { status: 'inProgress' })], { activeTurnId: 't1' });
    await flush();
    assert.equal(v.$('.thread-composer-area [data-stub="AsyncQuestions"]'), null);
    assert.ok(v.$('.turn [data-stub="AsyncQuestions"]'));
    await v.unmount();
  });

  test('notes, questions and later messages stay visible while the work is folded', async () => {
    const items = [
      { id: 'n0', type: 'statusNote', kind: 'model', text: 'Model changed' },
      { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed' },
      { id: 'q1', type: 'agentMessage', text: 'Which?', questions: [{ title: 'Which?', options: ['a'] }] },
      { id: 'n1', type: 'statusNote', kind: 'goal', text: 'Goal set' },
      user('u2', 'steered message'),
      { id: 'm1', type: 'agentMessage', text: 'progress update' },
      { id: 'c2', type: 'commandExecution', command: 'pwd', status: 'completed' },
    ];
    chat([turn('t1', items)], {}, { id: T, cwd: '/repo' });
    setStore({
      chatNotes: {
        [T]: [turn('note', [{ id: 'cc', type: 'contextCompaction' }]), turn('note2', [{ id: 'cc2', type: 'contextCompaction' }])],
      },
    });
    const v = await render(view());
    assert.equal(text(v.$('.turn .status-note')), 'Model changed');
    assert.ok(v.$('.work [data-stub="AsyncQuestions"]'));
    assert.equal(v.$$('.work .status-note').length, 1);
    assert.equal(v.$$('.work .user-message').length, 1);
    assert.equal(v.$$('.work .commentary').length, 0);
    await settle(() => v.$('.worked-for')!.click());
    assert.equal(v.$$('.work .commentary').length, 1);
    // a compaction the user asked for is just its divider
    assert.equal(text(v.$('.turn.last .divider-label')), ' Context compacted');
    assert.equal(v.$$('.turn:not(.last) .divider-label').length, 1);
    await v.unmount();
  });
}
