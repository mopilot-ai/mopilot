// A MoMo draft note in a chat's turn (src/components/thread/items/BlockItems.tsx): a note of kind 'draft' with its words draws as MoMo's draft card (src/components/momo/MomoDraftCard.tsx, tested in momoDraftCardUI.test.ts); one without them stays a plain note with its text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, render } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/momo/MomoDraftCard.tsx', 'momoDraftCard', {
  MomoDraftCard: (p: any) => h('div', { 'data-stub': 'MomoDraftCard', 'data-subject': p.draft.subject }, p.draft.body),
});
const { BlockItem } = await import('../src/components/thread/Items.tsx');

const draft = { to: ['sam@example.com'], subject: 'Re: lunch', body: 'Friday works.' };

test('a draft note with its words is the draft card; without them, a plain note', async () => {
  const v = await render(
    h(BlockItem, {
      item: { type: 'statusNote', id: 'd1', kind: 'draft', text: 'Draft · Re: lunch', draft },
      cwd: '/',
      threadId: 'm',
    } as any),
  );
  const card = v.$('[data-stub="MomoDraftCard"]')!;
  assert.equal(card.dataset.subject, 'Re: lunch');
  assert.equal(card.textContent, 'Friday works.');
  await v.rerender(
    h(BlockItem, { item: { type: 'statusNote', id: 'd2', kind: 'draft', text: 'Draft · none' }, cwd: '/', threadId: 'm' } as any),
  );
  assert.equal(v.$('[data-stub="MomoDraftCard"]'), null);
  assert.ok(v.$('.status-note.draft')!.textContent!.includes('Draft · none'));
});
