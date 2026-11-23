// A plan streaming in (PlanCard.tsx): it shows up to where nothing shown changes form, and whole once finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
const { BlockItem } = await import('../src/components/thread/items/BlockItems.tsx');

test('a plan still streaming in shows up to where nothing shown changes form; a finished one shows whole', async () => {
  const plan = (text: string, running: boolean) => h(BlockItem, { item: { id: 'p', type: 'plan', text }, cwd: '/r', running });
  const v = await render(plan('1. Add the **new t', true));
  try {
    assert.equal(v.$('.plan-card [data-stub="Markdown"]')!.dataset.text, '1. Add the ');
    assert.equal(v.$('.plan-card [data-stub="Markdown"]')!.dataset.streaming, 'true', 'a plan parses only its tail as it grows');
    await v.rerender(plan('1. Add the **new tests**', true));
    assert.equal(v.$('.plan-card [data-stub="Markdown"]')!.dataset.text, '1. Add the **new tests**');
    await v.rerender(plan('1. Add the **new t', false));
    assert.equal(v.$('.plan-card [data-stub="Markdown"]')!.dataset.text, '1. Add the **new t');
    assert.equal(v.$('.plan-card [data-stub="Markdown"]')!.dataset.streaming, 'false');
  } finally {
    await v.unmount();
  }
});
