// A line of MoMo's morning brief in a chat's turn (src/components/thread/items/BlockItems.tsx): a note of kind 'brief' draws as the brief's line or, with its suggestion, its card (src/components/momo/BriefLine.tsx, tested in momoBriefUI.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, render } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/momo/BriefLine.tsx', 'briefLine', {
  BriefLine: (p: any) => h('div', { 'data-stub': 'BriefLine', 'data-card': p.suggestion?.id ?? '' }, p.text),
});
const { BlockItem } = await import('../src/components/thread/Items.tsx');

test('a brief note is the brief line, with its suggestion when it has one', async () => {
  const item = (extra: object) => ({ type: 'statusNote', id: 'b1', kind: 'brief', text: 'Reply to Sam', ...extra });
  const v = await render(
    h(BlockItem, { item: item({ suggestion: { id: 's1', title: 'T', source: 'S' } }), cwd: '/', threadId: 'm' } as any),
  );
  assert.equal(v.$('[data-stub="BriefLine"]')!.dataset.card, 's1');
  await v.rerender(h(BlockItem, { item: item({}), cwd: '/', threadId: 'm' } as any));
  assert.equal(v.$('[data-stub="BriefLine"]')!.dataset.card, '');
});
