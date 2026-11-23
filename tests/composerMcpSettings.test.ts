// The chat MCP menu opens the settings of its current harness, including an empty server list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $$, mouse } from './support/composer-kit.ts';
import { fx, last, mountComposer, reset, settle, store } from './support/composer-setup.ts';

const row = (title: string) => $$('.slash-panel .add-panel-item').find((x) => x.querySelector('.add-panel-title')?.textContent === title)!;
test('empty and populated MCP menus route to Claude settings after the chat switches harness', async () => {
  reset();
  store.set({ harnessOf: { t1: 'claude' } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    for (const populated of [false, true]) {
      fx.mcpRows = populated ? [{ name: 'Stripe', desc: 'Not signed in' }] : [];
      await m.type('/mcp');
      await mouse(row('MCP'), 'mousedown');
      await settle();
      await mouse(row(populated ? 'Stripe' : 'No MCP servers'), 'mousedown');
      assert.deepEqual(last('navigate'), ['navigate', { name: 'settings', section: 'claude', tab: 'extensions:mcps' }]);
    }
  } finally {
    await m.unmount();
  }
});
