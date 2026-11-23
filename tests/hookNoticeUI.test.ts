// Native hook feedback renders its complete message, without MoPilot's synthetic Hook/status prefix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, render } from './support/thread-kit.ts';
import { hookItem } from './support/claude-translate.ts';

mockStore();
const { BlockItem } = await import('../src/components/thread/items/BlockItems.tsx');

test('a long native notice retains its explanation and line breaks in the actual chat item', async () => {
  const content = `${'plugin/'.repeat(30)}: Setup is missing.\nRun setup before retrying.`;
  const item = hookItem({ subtype: 'informational', level: 'warning', content, uuid: 'notice' });
  const view = await render(h(BlockItem, { item, cwd: '/repo', threadId: 'claude:chat' } as any));
  assert.equal(view.$('.hook-feedback')?.textContent, content);
  assert.doesNotMatch(view.host.textContent ?? '', /Hook ·|\(failed\)/);
  await view.unmount();
});
