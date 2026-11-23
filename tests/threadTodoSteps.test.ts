// A task list's steps (TodoSteps, which the pinned task box shows for the agent's list and for a turn's native plan):
// what each step's status marker says, live and once its turn has stopped.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, resetStore, moduleCalls } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/session/clipboard.ts', 'clip');
const { fileChangeToDiff, parseUnifiedDiff } = await import('../src/lib/diff.ts');
autoMock('src/components/diff/DiffView.tsx', 'diff', { InlineDiff: stubComponent('InlineDiff'), fileChangeToDiff, parseUnifiedDiff });
autoMock('src/components/ui/ImageLightbox.tsx', 'img', { ZoomableImage: stubComponent('ZoomableImage') });
autoMock('src/components/ui/Presence.tsx', 'presence', {
  Collapse: ({ open, children }: any) => (open ? h('div', { className: 'collapse open' }, children) : null),
});
autoMock('src/session/open.ts', 'open');
autoMock('src/components/thread/ScheduledTaskCard.tsx', 'schedCard', { ScheduledTaskCard: stubComponent('ScheduledTaskCard') });
autoMock('src/components/tasks/TaskEventCard.tsx', 'taskEvent', {
  TaskEventCard: (p: any) =>
    h('div', { 'data-stub': 'TaskEventCard', 'data-events': JSON.stringify(p.events), 'data-chat': p.chatId ?? '' }),
});
const { TodoSteps } = await import('../src/components/thread/Items.tsx');

beforeEach(() => {
  resetStore();
  moduleCalls.length = 0;
});
const list = (...statuses: string[]) => statuses.map((status, i) => ({ step: `s${i}`, status })) as any;

test('a todo step marks its status: a check done, the spinner running, a dotted ring waiting', async () => {
  const v = await render(h(TodoSteps, { steps: list('completed', 'inProgress', 'pending'), active: true }));
  const steps = v.$$('.todo-step');
  assert.equal(steps.length, 3);
  assert.ok(steps[0].querySelector('.todo-check svg'));
  assert.ok(!steps[0].querySelector('svg.spinner, svg.dotted-ring'));
  assert.ok(steps[1].querySelector('svg.spinner'));
  assert.ok(steps[2].querySelector('svg.dotted-ring'));
  // only the running step animates, whatever else the list holds
  assert.equal(v.$$('svg.spinner:not(.still)').length, 1);
  // the glyph is decorative; the marker names the status, so a reader hears it beside the step
  for (const svg of v.$$('.todo-check svg')) assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(
    v.$$('.todo-check').map((c) => c.getAttribute('aria-label')),
    ['Done', 'In progress', 'Waiting'],
  );
  // CD replaces an inactive in-progress spinner with a static status glyph, including an old plan.
  await v.rerender(h(TodoSteps, { steps: list('inProgress'), active: false }));
  assert.ok(v.$('svg.dotted-ring'));
  assert.equal(v.$$('svg.spinner').length, 0, 'an inactive plan must not look like a frozen loading animation');
  assert.equal(v.$('.todo-check')!.getAttribute('aria-label'), 'In progress');
  // Updating or resuming the same plan restores motion; stopping it again replaces the glyph again.
  for (const active of [true, false, true]) {
    await v.rerender(h(TodoSteps, { steps: list('completed', 'inProgress', 'pending'), active }));
    const step = v.$$('.todo-step')[1];
    assert.equal(!!step.querySelector('svg.spinner:not(.still)'), active);
    assert.equal(!!step.querySelector('svg.dotted-ring'), !active);
    assert.equal(v.$$('svg.spinner.still').length, 0);
    assert.ok(v.$$('.todo-step')[2].querySelector('svg.dotted-ring'), 'pending steps stay still while the plan runs');
  }
  await v.rerender(h(TodoSteps, { steps: list('completed'), active: false }));
  assert.equal(v.$$('.todo-check')[0].getAttribute('aria-label'), 'Done');
  assert.equal(v.$$('svg.spinner, svg.dotted-ring').length, 0, 'completion replaces the open marker');
  // a harness reporting a status outside the union waits rather than claiming to run
  await v.rerender(h(TodoSteps, { steps: list('skipped'), active: true }));
  assert.ok(v.$('svg.dotted-ring'));
  assert.ok(!v.$('svg.spinner'));
  assert.equal(v.$('.todo-check')!.getAttribute('aria-label'), 'Waiting');
  await v.unmount();
});
