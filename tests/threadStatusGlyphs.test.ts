// Where the status vocabulary (src/components/ui/icons.tsx) lands in a running group's row: the thinking glyph
// while the group has nothing concrete to report, the step's own icon as soon as it has.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, resetStore, moduleCalls } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/session/clipboard.ts', 'clip');
autoMock('src/components/diff/DiffView.tsx', 'diff', { InlineDiff: stubComponent('InlineDiff') });
autoMock('src/components/ui/ImageLightbox.tsx', 'img', { ZoomableImage: stubComponent('ZoomableImage') });
autoMock('src/components/ui/Presence.tsx', 'presence', {
  Collapse: ({ open, children }: any) => (open ? h('div', { className: 'collapse open' }, children) : null),
});
autoMock('src/session/open.ts', 'open');
const { StepGroup } = await import('../src/components/thread/Items.tsx');

beforeEach(() => {
  resetStore();
  moduleCalls.length = 0;
});

const group = (items: any[]) => h(StepGroup, { items, cwd: '/r', active: true });
const reading = {
  id: 'r',
  type: 'commandExecution',
  command: 'cat a.ts',
  status: 'inProgress',
  commandActions: [{ type: 'read', path: 'a.ts' }],
};

test('a running group with nothing concrete to report leads its label with the thinking glyph', async () => {
  const v = await render(group([]));
  const row = () => v.$('.step-row.active')!;
  // three dots of the same size, which the stylesheet staggers; no step icon, because there is no step to name
  assert.equal(v.$$('.step-row.active .thinking-dots > span').length, 3);
  assert.equal(v.$('.thinking-dots')!.getAttribute('style'), '--dot-size: 6px;');
  assert.ok(!v.$('.step-icon'));
  // the glyph is decorative: the row says "Thinking" in its own words beside it
  assert.equal(v.$('.thinking-dots')!.getAttribute('aria-hidden'), 'true');
  assert.equal(v.$('.step-row.active .shimmer')!.textContent, 'Thinking');
  // a thought is still thinking: its own label, the same glyph
  await v.rerender(group([{ id: 'th', type: 'reasoning', status: 'completed', summary: ['**Weighing options**'] }]));
  assert.equal(v.$('.step-row.active .shimmer')!.textContent, 'Weighing options');
  assert.ok(v.$('.step-row.active .thinking-dots'));
  // a step to name: its own icon says which kind of work, so the generic glyph gives way to it
  await v.rerender(group([reading]));
  assert.equal(v.$('.step-row.active .shimmer')!.textContent, 'Reading a.ts');
  assert.ok(v.$('.step-row.active .step-icon'));
  assert.ok(!v.$('.thinking-dots'));
  // and back, once that step has finished and the group is waiting again
  await v.rerender(group([{ ...reading, status: 'completed' }]));
  assert.ok(v.$('.step-row.active .thinking-dots'));
  assert.ok(!row().querySelector('.step-icon'));
  await v.unmount();
});
