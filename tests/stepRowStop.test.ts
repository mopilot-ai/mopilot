// A step row in its turn (src/components/thread/items/turnTiming.ts): "Thought for 4s" on a timed thinking block, and
// "Interrupted" on a step Stop cut off, on every harness (Claude Code, ACP and a command a Codex Stop ended mark it; Codex leaves others running).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
const { fileChangeToDiff, parseUnifiedDiff } = await import('../src/lib/diff.ts');
autoMock('src/components/diff/DiffView.tsx', 'diff', { InlineDiff: stubComponent('InlineDiff'), fileChangeToDiff, parseUnifiedDiff });
autoMock('src/components/ui/Presence.tsx', 'presence', {
  Collapse: ({ open, children }: any) => (open ? h('div', { className: 'collapse open' }, children) : null),
});
const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
const text = (el: Element | null | undefined) => el?.textContent ?? '';

test('in its turn: "Thought for 4s" when the block was timed; "Interrupted" on a step Stop cut off, not a failure', async () => {
  const { TurnTimingContext } = await import('../src/components/thread/items/turnTiming.ts');
  const inTurn = (step: any, timing: any) => render(h(TurnTimingContext.Provider, { value: timing }, h(StepRow, { step, cwd: '/r' })));
  const times = { th: { start: 1000, end: 5200 }, quick: { start: 0, end: 400 }, open: { start: 0 } };
  const timeOf = (id: string) => (times as any)[id];
  const stopped = { timeOf, interrupted: true };
  let v = await inTurn({ kind: 'reasoning', item: { id: 'th', summary: ['why'] } }, stopped);
  assert.equal(text(v.$('.step-text')), 'Thought for 4s');
  for (const id of ['quick', 'open', 'none']) {
    await v.rerender(
      h(TurnTimingContext.Provider, { value: stopped }, h(StepRow, { step: { kind: 'reasoning', item: { id } } as any, cwd: '/r' })),
    );
    assert.equal(text(v.$('.step-text')), 'Thought', id);
  }
  await v.unmount();
  // Claude Code and ACP mark the step Stop cut off; Codex leaves it running
  v = await inTurn({ kind: 'command', item: { id: 'c', command: 'make', status: 'failed', cutOff: true } }, stopped);
  assert.equal(text(v.$('.step-text')), 'Ran make · Interrupted');
  assert.ok(!v.$('.step.failed'));
  await v.unmount();
  // a command Stop killed (Codex, #1940) reads "Interrupted", not the kill's exit code
  v = await inTurn({ kind: 'command', item: { id: 'c', command: 'make', status: 'failed', cutOff: true, exitCode: -1 } }, stopped);
  assert.equal(text(v.$('.step-text')), 'Ran make · Interrupted');
  await v.unmount();
  v = await inTurn({ kind: 'command', item: { id: 'c', command: 'make', status: 'inProgress' } }, stopped);
  assert.equal(text(v.$('.step-text')), 'Ran make · Interrupted');
  await v.unmount();
  // a command sent to the background outlives the stopped turn
  v = await inTurn({ kind: 'command', item: { id: 'c', command: 'serve', status: 'inProgress', background: true } }, stopped);
  assert.ok(!text(v.$('.step-text')).includes('Interrupted'));
  await v.unmount();
  // a turn that was not stopped: a real failure stays one
  v = await inTurn({ kind: 'command', item: { id: 'c', command: 'make', status: 'failed', cutOff: true } }, { timeOf, interrupted: false });
  assert.equal(text(v.$('.step-text')), 'Ran make · exit code unknown');
  assert.ok(v.$('.step.failed'));
  await v.unmount();
});
