// MoMo's tool steps in the transcript (#2280): the row reads as what the call did ("Searched memory"), the running label
// says what it is doing, and the expanded card names the tool without MoPilot's server nonce, on every harness's form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/ui/Presence.tsx', 'presence', {
  Collapse: ({ open, children }: any) => (open ? h('div', { className: 'collapse open' }, children) : null),
});
const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
const { activeStepLabel } = await import('../src/components/thread/items/presentation.tsx');
const { ToolIO } = await import('../src/components/thread/items/output.tsx');
const text = (el: Element | null | undefined) => el?.textContent ?? '';
const step = (item: Record<string, unknown>) => ({ kind: 'tool', item: { id: 't', type: 'mcpToolCall', arguments: {}, ...item } }) as any;

test('a MoMo tool’s row reads as what it did on opencode’s joined name; another server’s tool stays “Called”', async () => {
  let v = await render(h(StepRow, { step: step({ tool: 'sage_3f880302123f_momo_memory_search', status: 'completed' }), cwd: '/r' }));
  assert.equal(text(v.$('.step-text')), 'Searched memory');
  await v.unmount();
  v = await render(
    h(StepRow, { step: step({ server: 'sage_3f880302123f', tool: 'momo_calendar_events', status: 'completed' }), cwd: '/r' }),
  );
  assert.equal(text(v.$('.step-text')), 'Read Calendar');
  await v.unmount();
  v = await render(h(StepRow, { step: step({ server: 'sage_3f880302123f', tool: 'brand_new', status: 'completed' }), cwd: '/r' }));
  assert.equal(text(v.$('.step-text')), 'Called brand_new', 'an own tool not in the table: its name, without the nonce');
  await v.unmount();
  v = await render(
    h(StepRow, { step: step({ server: 'github', tool: 'create_issue', status: 'completed', durationMs: 1200 }), cwd: '/r' }),
  );
  assert.match(text(v.$('.step-text')), /^Called github create_issue · /);
  await v.unmount();
});

test('the running label and the card head name the call without MoPilot’s server nonce', async () => {
  assert.equal(activeStepLabel(step({ tool: 'sage_3f880302123f_momo_memory_save', status: 'inProgress' })), 'Remembering');
  assert.equal(activeStepLabel(step({ server: 'github', tool: 'create_issue', status: 'inProgress' })), 'Calling create_issue');
  assert.equal(activeStepLabel(step({ tool: 'sage_3f880302123f_brand_new', status: 'inProgress' })), 'Calling brand_new');
  assert.equal(activeStepLabel(step({ status: 'inProgress' })), 'Calling a tool', 'a call with no name yet');
  const v = await render(
    h(ToolIO, { item: { id: 't', type: 'mcpToolCall', tool: 'sage_3f880302123f_momo_memory_search', arguments: {} } as any }),
  );
  assert.equal(text(v.$('.shell-head')), 'momo_memory_search');
  await v.unmount();
});
