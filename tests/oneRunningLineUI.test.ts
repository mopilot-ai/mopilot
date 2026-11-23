// A chat shows one running line however many of its turns the store still holds as running (two stacked clocks, "Thinking… 26s" over "51s · tokens").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, settle, setStore, T, text, user, reply, turn, chat, view } from './support/thread-view/fixture.ts';

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`${harness}: one activity row and clock through waiting, tools, thoughts, commentary and agents`, async (t) => {
    const startedAt = (Date.now() - 30_000) / 1000;
    const plan = { steps: [{ step: 'Read the instructions', status: 'inProgress' }] };
    const at = (items: any[], status = 'inProgress') =>
      chat([turn('active', [user('u', 'Go'), ...items], { status, startedAt, plan })], {
        activeTurnId: status === 'inProgress' ? 'active' : null,
      });
    at([]);
    setStore({ segments: { [T]: [{ nativeId: T, harness, start: 0 }] }, prefs: { showReasoning: true } });
    const v = await render(view());
    t.after(() => v.unmount());
    const one = () => {
      const place = '.turn-status-slot';
      assert.equal(v.$('.work .claude-activity'), null, 'no live transcript copy');
      assert.equal(v.$$('.claude-activity').length, 1, 'the whole chat has one activity row');
      assert.equal(v.$$('.claude-activity-time').length, 1, 'the whole chat has one turn clock');
      const row = v.$(`${place} .claude-activity`)!;
      assert.ok(row, `the activity belongs in ${place}`);
      assert.match(text(row.querySelector('.claude-activity-time')), /^3[01]s$/);
      assert.equal(v.$$('.claude-activity .working-mark').length, 1, 'the same turn never has two working marks');
      assert.equal(v.$$('[data-stub="InlineTasksCount"]').length, 1, 'the single row retains the task count');
      return row;
    };
    one();
    const read = (id: string, status = 'completed') => ({
      id,
      type: 'commandExecution',
      command: 'cat AGENTS.md',
      commandActions: [{ type: 'read', command: 'cat AGENTS.md', name: 'AGENTS.md', path: '/repo/AGENTS.md' }],
      status,
    });
    // The reported repro: a completed read while the model thinks still owns only one running row.
    await settle(() => at([read('read1')]));
    assert.equal(text(one().querySelector('.claude-activity-label')), 'Reading AGENTS.md');
    assert.equal(one().querySelector('.working-mark')?.getAttribute('data-activity'), 'think');
    // Several calls in the same stretch, including reversed parallel completion, never duplicate the footer.
    for (const states of [
      ['inProgress', 'inProgress'],
      ['inProgress', 'completed'],
      ['completed', 'inProgress'],
      ['completed', 'completed'],
    ]) {
      await settle(() => at([read('read1', states[0]), read('read2', states[1])]));
      assert.equal(one().querySelector('.working-mark')?.getAttribute('data-activity'), states.includes('inProgress') ? 'read' : 'think');
    }
    const thought = { id: 'thought', type: 'reasoning', summary: ['Checking the instructions'], content: [] };
    await settle(() => at([read('read1'), thought]));
    one();
    const toggle = v.$('.turn-status-slot button.claude-activity.expandable')!;
    await settle(() => toggle.click());
    assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the one row retains its tool/thought disclosure');
    await settle(() => at([read('read1'), thought, reply('r', 'Instructions checked', { phase: 'commentary' })]));
    one();
    // A new group after commentary takes over; an agent card's header then owns the one line.
    const previous = [read('read1'), thought, reply('r', 'Instructions checked', { phase: 'commentary' })];
    await settle(() => at([...previous, read('read3', 'inProgress')]));
    one();
    const agent = {
      id: 'agent',
      type: 'dynamicToolCall',
      tool: 'Task',
      status: 'inProgress',
      agent: { key: 'a', description: 'Check instructions', status: 'running', toolUses: 0 },
    };
    await settle(() => at([...previous, agent]));
    one();
    assert.equal(v.$('.agent-group-head.running'), null, 'the agent status also moves below the task list');
    // A foreground spawn may still be running when commentary and the next command take over.
    await settle(() => at([...previous, agent, reply('next', 'Checking next', { phase: 'commentary' }), read('read4', 'inProgress')]));
    one();
    assert.equal(v.$('.agent-group-head.running'), null, 'the historical foreground group immediately yields its live header');
    for (const status of ['completed', 'interrupted', 'failed']) {
      await settle(() => at([read('read1'), reply('done', 'Done')], status));
      assert.equal(v.$('.claude-activity'), null, `${status} retires the live row`);
    }
  });
}

test('a turn left running behind the chat’s active turn draws no second running line', async (t) => {
  const now = Date.now();
  // the earlier turn, never completed: its reply, then a message the user sent mid-turn (steered into it)
  const earlier = turn(
    't1',
    [
      user('u1', 'Go'),
      { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed' },
      reply('r1', 'Looking at it'),
      user('u2', 'Also check the tests'),
    ],
    { status: 'inProgress', startedAt: (now - 51_000) / 1000, itemTimes: { r1: { start: 1, end: 2 } } },
  );
  // the chat's active turn: its running group waits on the model after a tool ("Thinking…")
  const active = turn('t2', [user('u3', 'And the docs'), { id: 'c2', type: 'commandExecution', command: 'pwd', status: 'completed' }], {
    status: 'inProgress',
    startedAt: (now - 26_000) / 1000,
  });
  chat([earlier, active], { activeTurnId: 't2' });
  setStore({ segments: { [T]: [{ nativeId: T, harness: 'claude', start: 0 }] } });
  const v = await render(view());
  t.after(() => v.unmount());
  const rows = v.$$('.turn-status-slot .claude-activity');
  assert.equal(rows.length, 1, 'exactly one running row: the active turn’s running group');
  assert.equal(v.$('.turn-slot[data-turn-slot="t1"] .claude-activity'), null);
  assert.equal(text(rows[0].querySelector('.claude-activity-label')), 'Running pwd');
  // The lower row belongs to the active turn; the older turn has no live copy.
  assert.equal(v.$$('.claude-activity').length, 1);
  assert.match(text(rows[0].querySelector('.claude-activity-time')), /^2[67]s$/);
});

test('before the first tool one row below the task list says "Thinking…", with its clock', async (t) => {
  chat(
    [
      turn('t1', [user('u', 'Go'), { id: 'th', type: 'reasoning', summary: [], content: [] }], {
        status: 'inProgress',
        startedAt: (Date.now() - 6_000) / 1000,
      }),
    ],
    {
      activeTurnId: 't1',
    },
  );
  setStore({ segments: { [T]: [{ nativeId: T, harness: 'claude', start: 0 }] }, prefs: { showReasoning: false } });
  const v = await render(view());
  t.after(() => v.unmount());
  assert.equal(v.$$('.claude-activity').length, 1, 'one running line in the chat');
  assert.equal(text(v.$('.turn-status-slot .claude-activity-label')), 'Thinking…');
  assert.match(text(v.$('.turn-status-slot .claude-activity-time')), /^[67]s$/);
  assert.equal(v.$('.work .claude-activity'), null);
});

// the screenshot: "Reading how … is stored ›" over "5s · Thinking…" under the task list, far apart
const subagent = (status: 'running' | 'completed') => ({
  id: 'task',
  type: 'dynamicToolCall',
  tool: 'Task',
  status: status === 'running' ? 'inProgress' : 'completed',
  agent: {
    key: 'a1',
    description: 'Read how memory is stored',
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
  },
});

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`${harness}: an agent label held across the reply handoff cannot keep a second running line`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const at = (items: any[], status = 'inProgress') =>
      chat([turn('t1', [user('u', 'Go'), ...items], { status, startedAt: (Date.now() - 8_000) / 1000 })], {
        activeTurnId: status === 'inProgress' ? 't1' : null,
      });
    at([subagent('running')]);
    setStore({ segments: { [T]: [{ nativeId: T, harness, start: 0 }] } });
    const v = await render(view());
    t.after(() => v.unmount());
    assert.equal(v.$$('.turn-status-slot .claude-activity').length, 1, 'the agent starts in the single lower row');
    assert.equal(v.$('.work .claude-activity, .agent-group-head.running'), null);
    const done = subagent('completed');
    const commentary = reply('r', 'Instructions checked', { phase: 'commentary' });
    await settle(() => at([done, commentary]));
    assert.equal(v.$$('.agent-group-head.running').length, 0, 'the old label timer cannot retain live ownership');
    assert.equal(v.$$('.turn-status-slot .claude-activity').length, 1, 'the reply owns the waiting line');
    assert.equal(v.$$('.claude-activity-time, .agent-group-head [role="timer"]').length, 1);
    assert.equal(v.$$('[data-stub="InlineTasksCount"]').length, 1);
    // A new group takes over while the old agent label is still held, then the turn ends before that timer fires.
    await settle(() => at([done, commentary, { id: 'next', type: 'commandExecution', command: 'pwd', status: 'inProgress' }]));
    assert.equal(v.$$('.agent-group-head.running, .claude-activity').length, 1);
    assert.equal(v.$$('.turn-status-slot .claude-activity').length, 1, 'the next tool takes over the same lower row');
    assert.equal(v.$('.work .claude-activity'), null);
    await settle(() => at([done, commentary], 'completed'));
    assert.equal(v.$$('.agent-group-head.running, .claude-activity').length, 0);
  });
}

for (const status of ['running', 'completed'] as const) {
  test(`a ${status} sub-agent's group draws the turn's one running line below the task list, with its clock`, async (t) => {
    chat([turn('t1', [user('u', 'Go'), subagent(status)], { status: 'inProgress', startedAt: (Date.now() - 8_000) / 1000 })], {
      activeTurnId: 't1',
    });
    setStore({ segments: { [T]: [{ nativeId: T, harness: 'claude', start: 0 }] } });
    const v = await render(view());
    t.after(() => v.unmount());
    assert.equal(v.$('.work .claude-activity, .agent-group-head.running'), null, 'no live copy above the task list');
    assert.equal(v.$$('.turn-status-slot .claude-activity-time').length, 1, 'one clock, below the task list');
  });
}
