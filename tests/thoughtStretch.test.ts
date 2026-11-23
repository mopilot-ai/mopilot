// One "Thought for Ns" row per stretch of thinking (src/components/thread/items/stepModel.ts mergeThoughts): consecutive
// thinking blocks with nothing shown between them read as one row with their durations summed, as Claude Desktop shows
// them, in the running group and the settled one, live and read back, on every harness.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, settle, resetStore, setStore } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/ui/Presence.tsx', 'presence', {
  Collapse: ({ open, children }: any) => (open ? h('div', { className: 'collapse open' }, children) : null),
});
const { StepGroup } = await import('../src/components/thread/Items.tsx');
const { TurnTimingContext, thoughtLabel } = await import('../src/components/thread/items/turnTiming.ts');
const { mergeThoughts, mergeThoughtSteps, thoughtItems } = await import('../src/components/thread/items/stepModel.ts');

beforeEach(() => {
  resetStore();
  setStore({ prefs: { showReasoning: true } });
});

const thought = (id: string, text = id) => ({ id, type: 'reasoning', summary: [text], content: [] });
const command = (id: string, status = 'completed') => ({ id, type: 'commandExecution', command: 'ls', status, commandActions: [] });
const step = (item: any) => (item.type === 'reasoning' ? { kind: 'reasoning', item } : { kind: 'command', item, network: false }) as any;
const times: Record<string, { start: number; end?: number }> = {
  a: { start: 0, end: 1200 },
  b: { start: 2000, end: 3400 },
  c: { start: 4000, end: 4300 },
  d: { start: 5000, end: 5300 },
  open: { start: 6000 },
};
const timing = { timeOf: (id: string) => times[id], interrupted: false };
const texts = (v: any, sel: string) => v.$$(sel).map((el: Element) => el.textContent);
const inTurn = (items: any[], active = false, value: any = timing) =>
  h(TurnTimingContext.Provider, { value }, h(StepGroup, { items, cwd: '/repo', active, ux: 'shimmer' }));

test('mergeThoughts folds a run of thoughts into its first row and leaves every other row alone', () => {
  const steps = [thought('a'), thought('b'), command('x'), thought('c'), thought('d'), thought('e')].map(step);
  const merged = mergeThoughtSteps(steps);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    thoughtItems(merged[0] as any).map((t) => t.id),
    ['a', 'b'],
  );
  assert.equal(merged[1], steps[2], 'a step between thoughts stays the same object');
  assert.deepEqual(
    thoughtItems(merged[2] as any).map((t) => t.id),
    ['c', 'd', 'e'],
  );
  assert.equal(merged[0].item, steps[0].item, 'the merged row keeps its first thought, so its key');
  assert.equal(mergeThoughtSteps([steps[0]])[0], steps[0], 'a lone thought is untouched');
  // a row that is not a step (an agent in a card) ends a run, and the row's own fields are kept
  const rows = [
    { k: 1, s: steps[0] },
    { k: 2, s: null },
    { k: 3, s: steps[1] },
    { k: 4, s: steps[3] },
  ];
  const out = mergeThoughts(
    rows,
    (r) => r.s,
    (r, s) => ({ ...r, s }),
  );
  assert.deepEqual(
    out.map((r) => r.k),
    [1, 2, 3],
  );
  assert.deepEqual(
    thoughtItems(out[2].s as any).map((t) => t.id),
    ['b', 'c'],
  );
});

test('thoughtLabel sums the timed blocks and rounds as Claude Desktop does, dropping a sum under half a second', () => {
  assert.equal(thoughtLabel(timing, ['a', 'b']), 'Thought for 3s', '1.2s + 1.4s');
  assert.equal(thoughtLabel(timing, ['c', 'd']), 'Thought for 1s', '0.3s + 0.3s rounds to 1s');
  assert.equal(thoughtLabel(timing, ['c']), 'Thought', '0.3s alone');
  assert.equal(thoughtLabel(timing, ['a', 'open', 'none']), 'Thought for 1s', 'untimed and unfinished blocks add nothing');
  assert.equal(thoughtLabel(timing, ['none']), 'Thought', 'read back from history: no times');
});

test('settled: thoughts back to back are one "Thought for Ns" row with both bodies in order, not a group', async () => {
  const v = await render(inTurn([thought('a', 'First'), thought('b', 'Second'), thought('empty', '  ')]));
  assert.deepEqual(texts(v, '.step-text'), ['Thought for 3s']);
  assert.equal(v.$('.step-group'), null, 'one stretch of thinking is no "Thought" summary group');
  await settle(() => v.$('.step-row-hit')!.click());
  assert.equal(v.$('.reasoning-text [data-stub="Markdown"]')?.dataset.text, 'First\n\nSecond');
  // read back from history the same blocks carry no times
  await v.rerender(inTurn([thought('a', 'First'), thought('b', 'Second')], false, { timeOf: () => undefined, interrupted: false }));
  assert.deepEqual(texts(v, '.step-text'), ['Thought']);
  await v.unmount();
});

test('settled: a step between thoughts keeps them apart inside the group', async () => {
  const v = await render(inTurn([thought('a'), thought('b'), command('x'), thought('c'), thought('d')]));
  await settle(() => v.$('.step-group .summary > .step-row-hit')!.click());
  assert.deepEqual(texts(v, '.step-list .step-text'), ['Thought for 3s', 'Ran ls', 'Thought for 1s']);
  await v.unmount();
});

test('running: thoughts around finished tools are one row, "Thinking" while the last one runs, then summed', async () => {
  // the reported repro: several short thinking blocks with tool calls between them stacked "Thought for 2s" rows
  const v = await render(inTurn([thought('a'), command('x'), thought('b'), command('y'), thought('open')], true));
  assert.deepEqual(texts(v, '.step .step-text'), ['Thinking']);
  assert.equal(v.$$('.step-row-hit').length, 1, 'one thought row, not one per block');
  await v.rerender(inTurn([thought('a'), command('x'), thought('b'), command('y', 'inProgress')], true));
  assert.deepEqual(texts(v, '.step-row-hit ~ .step-text'), ['Thought for 3s']);
  await v.unmount();
});
