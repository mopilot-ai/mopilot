// Live thinking, tools and agents share one collapsed status row below the task list on every harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { autoMock, mockStore, render, settle, stubComponent } from './support/thread-kit.ts';

mockStore();
autoMock('src/store/session/useSession.ts', 'session', { useSessionField: () => [] });
autoMock('src/components/tasks/TasksPill.tsx', 'pill', { InlineTasksCount: stubComponent('InlineTasksCount') });
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/ui/Presence.tsx', 'presence', {
  Collapse: ({ open, children }: any) => (open ? h('div', { className: 'collapse open' }, children) : null),
});
const { StepGroup } = await import('../src/components/thread/items/StepGroups.tsx');
const { ThinkingLine } = await import('../src/components/thread/view/ThinkingLine.tsx');
const { StatusSlot } = await import('../src/components/thread/statusSlot.tsx');
const { AgentChatContext } = await import('../src/components/agents/AgentChatContext.ts');
const { activityUx } = await import('../src/session/activityUx.ts');
const { LABEL_DWELL_MS } = await import('../src/lib/minDwell.ts');

const thought = { id: 'thought', type: 'reasoning', summary: ['Inspecting the layout'], content: [] };
const command = { id: 'command', type: 'commandExecution', command: 'npm test', commandActions: [], status: 'inProgress' };
const agent = (status: string) => ({
  id: 'agent',
  type: 'dynamicToolCall',
  tool: 'Task',
  status: status === 'running' ? 'inProgress' : 'completed',
  agent: { key: 'a', description: 'Check the layout', status, background: false, transcript: 'full' },
});

function taskSlot(t: any) {
  const target = document.createElement('div');
  target.className = 'turn-status-slot';
  document.body.append(target);
  t.after(() => target.remove());
  return target;
}

for (const family of ['codex', 'claude', 'acp'] as const) {
  test(`${family}: waiting, executing, thinking and agents keep one collapsed row below the task list`, async (t) => {
    const slot = taskSlot(t);
    const ux = activityUx(family);
    const view = (items?: any[], active = true, elapsedMs: number | null = 12000, hideTime = false) =>
      h(
        StatusSlot.Provider,
        { value: slot },
        h(
          AgentChatContext.Provider,
          { value: 'chat' },
          items
            ? h(StepGroup, { items, active, elapsedMs, hideTime, ux, cwd: '/repo' })
            : h(ThinkingLine, { ux, elapsedMs, activity: 'think', chatId: 'chat', reveal: false }),
        ),
      );
    const v = await render(view());
    const oneBelow = () => {
      assert.equal(slot.querySelectorAll('.claude-activity').length, 1, 'exactly one status below the task list');
      assert.equal(v.$('.claude-activity, .agent-group-head.running, .step-row.active'), null, 'no transcript copy');
      assert.equal(slot.querySelectorAll('.claude-activity-time').length, 1, 'one clock');
    };
    oneBelow();
    await v.rerender(view([thought, command]));
    oneBelow();
    assert.match(slot.querySelector('.claude-activity-label')!.textContent!, /Running/);
    assert.equal(slot.querySelector('.step-list'), null, 'trace details start collapsed');
    await settle(() => (slot.querySelector('button.claude-activity') as HTMLElement).click());
    assert.ok(slot.querySelector('.step-list'), 'trace details open on request');
    await settle(() => (slot.querySelector('button.claude-activity') as HTMLElement).click());
    await v.rerender(view([thought]));
    oneBelow();
    await v.rerender(view([thought, agent('running')]));
    oneBelow();
    assert.match(slot.querySelector('.claude-activity-label')!.textContent!, /layout/);
    assert.equal(slot.querySelector('.agent-row'), null, 'agent traces also start collapsed');
    assert.equal(v.$('.step-row'), null, 'agent reasoning is inside the disclosure');
    await v.rerender(view([thought, agent('running'), { ...thought, id: 'tail' }]));
    await settle(() => (slot.querySelector('button.claude-activity') as HTMLElement).click());
    assert.ok(slot.querySelector('.agent-row'), 'agent page links remain accessible');
    assert.ok(slot.querySelector('.step-row-hit'), 'leading thoughts retain their disclosure');
    const thoughtRows = slot.querySelectorAll<HTMLElement>('.step-row-hit');
    assert.equal(thoughtRows.length, 2, 'thoughts before and after an agent stay separate');
    await settle(() => thoughtRows[1].click());
    assert.equal(slot.querySelector<HTMLElement>('.reasoning-text [data-stub="Markdown"]')?.dataset.streaming, 'true');
    await settle(() => (slot.querySelector('button.claude-activity') as HTMLElement).click());
    await v.rerender(view([agent('completed')]));
    await settle(() => new Promise((resolve) => setTimeout(resolve, LABEL_DWELL_MS + 30)));
    oneBelow();
    assert.match(slot.querySelector('.claude-activity-label')!.textContent!, /Thinking/);
    await v.rerender(view([agent('completed')], true, null));
    assert.equal(slot.querySelectorAll('.claude-activity').length, 1, 'unknown time still shows status');
    assert.equal(slot.querySelector('.claude-activity-time'), null);
    await v.rerender(view([agent('completed')], false));
    assert.equal(slot.childElementCount, 0, 'completion or stop removes the live line');
    await v.unmount();
  });
}

test('replacing or retiring a chat slot removes the old line without affecting another chat', async (t) => {
  const first = taskSlot(t);
  const second = taskSlot(t);
  const other = taskSlot(t);
  const view = (target: HTMLElement | null, hideTime = false) =>
    h(
      StatusSlot.Provider,
      { value: target },
      h(StepGroup, { items: [command] as any[], active: true, ux: 'dots', elapsedMs: 8000, hideTime, cwd: '/repo' }),
    );
  const v = await render(view(first));
  const peer = await render(
    h(StatusSlot.Provider, { value: other }, h(ThinkingLine, { ux: 'dots', elapsedMs: 8000, activity: 'think', chatId: 'other' })),
  );
  assert.equal(first.querySelectorAll('.claude-activity').length, 1);
  await v.rerender(view(second));
  assert.equal(first.childElementCount, 0);
  assert.equal(second.querySelectorAll('.claude-activity').length, 1);
  assert.equal(other.querySelectorAll('.claude-activity').length, 1);
  await v.rerender(view(second, true));
  assert.equal(second.childElementCount, 0, 'untimed agent-page work stays in its own view');
  assert.ok(v.$('.claude-activity'));
  await v.rerender(view(null));
  assert.ok(v.$('.claude-activity'), 'a view without a slot still renders its activity');
  await v.unmount();
  assert.equal(second.childElementCount, 0);
  assert.equal(other.querySelectorAll('.claude-activity').length, 1);
  await peer.unmount();
  assert.equal(other.childElementCount, 0);
});

test('opening a running chat keeps agent traces collapsed before and after the status target mounts', async (t) => {
  const slot = taskSlot(t);
  const view = (target: HTMLElement | null, hideTime = false) =>
    h(
      StatusSlot.Provider,
      { value: target },
      h(StepGroup, { items: [thought, agent('running')] as any[], active: true, ux: 'dots', elapsedMs: 8000, hideTime, cwd: '/repo' }),
    );
  const v = await render(view(null));
  assert.equal(v.$('.agent-row'), null, 'the not-yet-mounted target does not auto-open the trace');
  await v.rerender(view(slot));
  assert.equal(v.$('.claude-activity'), null);
  assert.equal(slot.querySelectorAll('.claude-activity').length, 1);
  assert.equal(slot.querySelector('.agent-row'), null);
  await v.rerender(view(slot, true));
  assert.equal(slot.childElementCount, 0, 'an untimed agent page never writes into its containing chat');
  assert.ok(v.$('.agent-group-head'));
  await v.unmount();
});

test('an inactive foreground agent yields immediately; an explicit background agent keeps its historical card', async (t) => {
  const slot = taskSlot(t);
  const view = (active: boolean, background = false) =>
    h(
      StatusSlot.Provider,
      { value: slot },
      h(StepGroup, {
        items: [{ ...agent('running'), agent: { ...agent('running').agent, background } }] as any[],
        active,
        ux: 'dots',
        elapsedMs: 8000,
        cwd: '/repo',
      }),
    );
  const v = await render(view(true));
  assert.equal(slot.querySelectorAll('.claude-activity').length, 1);
  await v.rerender(view(false));
  assert.equal(slot.childElementCount, 0);
  assert.equal(v.$('.agent-group-head.running'), null, 'no stale live header during label dwell');
  await v.rerender(view(false, true));
  assert.ok(v.$('.agent-group-head.running'), 'independently running background work keeps its card');
  assert.equal(slot.childElementCount, 0, 'historical background work does not compete for the foreground status');
  await v.unmount();
});

test('an inactive background header retires immediately on completion while its label dwell is pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slot = taskSlot(t);
  const view = (status: string) =>
    h(
      StatusSlot.Provider,
      { value: slot },
      h(StepGroup, {
        items: [{ ...agent(status), agent: { ...agent(status).agent, background: true } }] as any[],
        active: false,
        ux: 'dots',
        elapsedMs: 8000,
        cwd: '/repo',
      }),
    );
  const v = await render(view('running'));
  assert.ok(v.$('.agent-group-head.running'), 'the actual background agent runs independently');
  await v.rerender(view('completed'));
  assert.equal(v.$('.agent-group-head.running'), null, 'completed work cannot borrow a pending animation to stay live');
  assert.equal(slot.childElementCount, 0, 'historical completion never publishes foreground activity');
  await v.unmount();
});
