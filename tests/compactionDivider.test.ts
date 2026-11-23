// A context compaction's divider in the thread (BlockItems CompactionDivider): never a message, its summary one click away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, settle } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
const { BlockItem } = await import('../src/components/thread/Items.tsx');

test('a compaction with a summary keeps it one click away; one without has no toggle', async () => {
  const v = await render(
    h(BlockItem, { item: { id: 'c', type: 'contextCompaction', trigger: 'auto', summary: '## Objective\n- x' } as any, cwd: '/r' }),
  );
  assert.match(v.$('.divider-label')!.textContent!, /^ Context automatically compacted/);
  assert.equal(v.$('.compaction-summary'), null, 'folded at first');
  const toggle = v.$('.compaction-toggle')!;
  assert.equal(toggle.textContent, 'View summary');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await settle(() => toggle.click());
  assert.equal(v.$('.compaction-summary [data-stub="Markdown"]')!.getAttribute('data-text'), '## Objective\n- x');
  assert.equal(v.$('.compaction-toggle')!.textContent, 'Hide summary');
  assert.equal(v.$('.compaction-toggle')!.getAttribute('aria-expanded'), 'true');
  await settle(() => (v.$('.compaction-toggle') as HTMLElement).click());
  assert.equal(v.$('.compaction-summary'), null);
  await v.rerender(h(BlockItem, { item: { id: 'd', type: 'contextCompaction', trigger: 'manual', summary: 42 } as any, cwd: '/r' }));
  assert.equal(v.$('.divider-label')!.textContent, ' Context compacted');
  assert.equal(v.$('.compaction-toggle'), null);
  await v.unmount();
});
