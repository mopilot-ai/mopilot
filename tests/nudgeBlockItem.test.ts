// A MoMo nudge note in a chat's turn (src/components/thread/items/BlockItems.tsx): a note of kind 'nudge' with its why draws as MoMo's nudge card (src/components/momo/NudgeCard.tsx, tested in momoOpenLoopsUI.test.ts); one without its why stays a plain note with its text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, render } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/momo/NudgeCard.tsx', 'nudgeCard', {
  NudgeCard: (p: any) => h('div', { 'data-stub': 'NudgeCard', 'data-loop': p.nudge.loopId }, p.text),
});
const { BlockItem } = await import('../src/components/thread/Items.tsx');

const why = { loopId: 'L1', title: 'Renew the lease', quote: 'renew the lease', saidAt: 1, trigger: 'due', why: 'due' };

test('a nudge note with its why is the nudge card; without it, a plain note', async () => {
  const v = await render(
    h(BlockItem, { item: { type: 'statusNote', id: 'n1', kind: 'nudge', text: 'Lease?', nudge: why }, cwd: '/', threadId: 'm' } as any),
  );
  const card = v.$('[data-stub="NudgeCard"]')!;
  assert.equal(card.dataset.loop, 'L1');
  assert.equal(card.textContent, 'Lease?');
  await v.rerender(h(BlockItem, { item: { type: 'statusNote', id: 'n2', kind: 'nudge', text: 'No why' }, cwd: '/', threadId: 'm' } as any));
  assert.equal(v.$('[data-stub="NudgeCard"]'), null);
  assert.ok(v.$('.status-note.nudge')!.textContent!.includes('No why'));
});
