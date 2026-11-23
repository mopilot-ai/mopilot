// Live reasoning disclosures retain opt-in state as text streams and tools begin across harnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, settle, setStore, T, text, user, turn, chat, view } from './support/thread-view/fixture.ts';
const { StepGroup } = await import('../src/components/thread/items/StepGroups.tsx');
const thought = (id = 'thought', summary = ['First thought']) => ({ id, type: 'reasoning', summary, content: [] });
const command = { id: 'cmd', type: 'commandExecution', command: 'ls', status: 'inProgress' };

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`${harness}: active reasoning sits in the running row, expands, streams and stays open when a tool starts`, async (t) => {
    const update = (items: any[]) => chat([turn('t1', [user('u', 'Go'), ...items], { status: 'inProgress' })], { activeTurnId: 't1' });
    update([thought()]);
    setStore({ segments: { [T]: [{ nativeId: T, harness, start: 0 }] }, prefs: { showReasoning: true } });
    const v = await render(view());
    t.after(() => v.unmount());
    // Claude Desktop's running group: one row, "Thinking…", that opens to the group's thoughts
    const group = () => v.$('.turn-status-slot button.claude-activity.expandable') as HTMLButtonElement;
    const thoughts = () => v.$$('.turn-status-slot .claude-step .step-list .step-row-hit');
    assert.equal(text(v.$('.turn-status-slot .claude-activity-label')), 'Thinking…');
    assert.equal(group().getAttribute('aria-expanded'), 'false');
    await settle(() => group().click());
    assert.equal(text(v.$('.turn-status-slot .step-list .step-text')), 'Thinking');
    assert.equal(thoughts()[0].getAttribute('aria-expanded'), 'false');
    assert.equal(v.$('.reasoning-text'), null);
    await settle(() => thoughts()[0].click());
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'First thought');
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.streaming, 'true', 'a live thought parses only its tail');
    await settle(() => update([thought('thought', ['First thought extended'])]));
    assert.equal(thoughts()[0].getAttribute('aria-expanded'), 'true');
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'First thought extended');
    // a tool starts: the row names it, and the open thought stays open in it
    await settle(() => update([thought('thought', ['First thought extended']), command]));
    assert.equal(text(v.$('.turn-status-slot .claude-activity-label')), 'Running ls');
    assert.equal(text(v.$('.turn-status-slot .step-list .step-text')), 'Thought');
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.streaming, 'false', 'a thought that ended is parsed whole');
    assert.equal(thoughts()[0].getAttribute('aria-expanded'), 'true');
    // a thought after the tool is a row of its own; the first keeps its state
    await settle(() => update([thought('thought', ['First thought extended']), command, thought('next', ['Next thought'])]));
    assert.deepEqual(
      thoughts().map((el) => el.getAttribute('aria-expanded')),
      ['true', 'false'],
    );
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'First thought extended');
    const agent = {
      id: 'launch',
      type: 'dynamicToolCall',
      tool: 'Task',
      status: 'completed',
      agent: { key: 'a', description: 'Review', status: 'completed', toolUses: 0 },
    };
    // An agent launch changes the row's contents; the group and its open thought retain their disclosure state.
    await settle(() => update([thought('thought', ['First thought extended']), agent]));
    const row = () => v.$('.turn-status-slot .step-row-hit')!;
    assert.equal(row().getAttribute('aria-expanded'), 'true', 'agent launch preserves the existing disclosure');
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'First thought extended');
    // The settled agent group's same lower row says the model thinks again.
    assert.equal(text(v.$('.turn-status-slot .claude-activity-label')), 'Thinking…', 'the agent group draws the one running line');
    assert.equal(v.$('.work .claude-activity'), null);
    await settle(() => update([thought('closed'), agent]));
    assert.equal(group().getAttribute('aria-expanded'), 'false', 'a replacement group starts collapsed');
    assert.equal(v.$('.reasoning-text'), null, 'a replacement cannot reveal thoughts');
    await settle(() => group().click());
    assert.equal(row().getAttribute('aria-expanded'), 'false');
    assert.equal(v.$('.reasoning-text'), null, 'an agent launch cannot disclose a closed thought');
    await settle(() => setStore({ prefs: { showReasoning: false } }));
    assert.equal(v.$('.step-row-hit'), null);
    assert.equal(v.$('.reasoning-text'), null);
  });
}

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`${harness}: streaming reasoning shows up to where nothing shown changes form; finished reasoning shows whole`, async (t) => {
    const update = (summary: string, status: string) =>
      chat([turn('t1', [user('u', 'Go'), thought('thought', [summary])], { status })], {
        activeTurnId: status === 'inProgress' ? 't1' : null,
      });
    update('Checking **the pac', 'inProgress');
    setStore({ segments: { [T]: [{ nativeId: T, harness, start: 0 }] }, prefs: { showReasoning: true } });
    const v = await render(view());
    t.after(() => v.unmount());
    // the running row opens to the thought, and the thought to its text
    await settle(() => (v.$('.turn-status-slot button.claude-activity.expandable') as HTMLElement).click());
    await settle(() => v.$('.step-row-hit')!.click());
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'Checking ');
    await settle(() => update('Checking **the pacer**', 'inProgress'));
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'Checking **the pacer**');
    await settle(() => update('Checking **the pac', 'completed'));
    // a finished turn folds its work: open it, then the thought
    for (const toggle of ['.worked-for, .turn-work-toggle, [aria-expanded="false"]', '.step-row-hit[aria-expanded="false"]'])
      if (!v.$('.reasoning-text') && v.$(toggle)) await settle(() => (v.$(toggle) as HTMLElement).click());
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'Checking **the pac');
  });
}

for (const ux of ['dots', 'shimmer'] as const) {
  test(`${ux}: standalone groups expose reasoning through thinking and command states`, async (t) => {
    setStore({ prefs: { showReasoning: true } });
    const group = (items: any[]) => h(StepGroup, { items, cwd: '/repo', active: true, ux });
    const v = await render(group([thought()]));
    t.after(() => v.unmount());
    // the Claude look holds its thoughts in the running row: open it first
    const openRow = () => (ux === 'dots' ? settle(() => (v.$('button.claude-activity.expandable') as HTMLElement).click()) : undefined);
    await openRow();
    await settle(() => v.$('.step-row-hit')!.click());
    await v.rerender(group([thought(), command]));
    assert.equal(v.$('.step-row-hit')?.getAttribute('aria-expanded'), 'true');
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'First thought');
    await v.rerender(group([thought('replacement')]));
    assert.equal(v.$('.step-row-hit')?.getAttribute('aria-expanded'), 'false');
    await v.rerender(group([thought('empty', ['  '])]));
    assert.equal(v.$('.step-row-hit'), null);
    // a group with nothing to list has no row to open
    if (ux === 'dots') assert.equal(v.$('button.claude-activity'), null);
    await v.rerender(group([{ ...thought('raw', []), content: [{ text: 'Raw thought' }] }]));
    await settle(() => v.$('.step-row-hit')!.click());
    assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'Raw thought');
  });
}

test('dots: the running row carries the turn clock, except where no turn runs to time it (an agent page)', async (t) => {
  const group = (hideTime: boolean) =>
    h(StepGroup, { items: [command] as any[], cwd: '/repo', active: true, ux: 'dots', elapsedMs: 9_000, hideTime });
  const v = await render(group(false));
  t.after(() => v.unmount());
  assert.equal(text(v.$('.claude-activity-time')), '9s');
  await v.rerender(group(true));
  assert.equal(v.$('.claude-activity-time'), null);
  assert.equal(text(v.$('.claude-activity-label')), 'Running ls');
});

test('dots: between steps the row holds the last step (only a group with no step says "Thinking…"); quick steps each stay a moment', async (t) => {
  const group = (items: any[]) => h(StepGroup, { items, cwd: '/repo', active: true, ux: 'dots' });
  const cmd = (id: string, run: string, status = 'inProgress') => ({ id, type: 'commandExecution', command: run, status });
  const label = () => text(v.$('.claude-activity-label'));
  const v = await render(group([thought()]));
  t.after(() => v.unmount());
  assert.equal(label(), 'Thinking…');
  // the first step shows at once
  await v.rerender(group([thought(), cmd('a', 'ls')]));
  assert.equal(label(), 'Running ls');
  // the next arrives within the dwell: the first stays up a moment, then the next takes over
  await v.rerender(group([thought(), cmd('a', 'ls', 'completed'), cmd('b', 'pwd')]));
  assert.equal(label(), 'Running ls');
  await settle(() => new Promise((r) => setTimeout(r, 700)));
  assert.equal(label(), 'Running pwd');
  // it finished and the model thinks: still its words, the mark thinking
  await v.rerender(group([thought(), cmd('a', 'ls', 'completed'), cmd('b', 'pwd', 'completed'), thought('next', ['Next'])]));
  assert.equal(label(), 'Running pwd');
  assert.equal(v.$('.claude-activity-thinking'), null);
  assert.equal(v.$('.working-mark')?.getAttribute('data-activity'), 'think');
  // a tool still running beside a later finished one while the model thinks: the row names the one still running
  await settle(() => new Promise((r) => setTimeout(r, 700)));
  await v.rerender(group([cmd('a', 'ls'), cmd('b', 'pwd', 'completed'), { ...thought('next', ['Next']), status: 'inProgress' }]));
  await settle(() => new Promise((r) => setTimeout(r, 700)));
  assert.equal(label(), 'Running ls');
});
