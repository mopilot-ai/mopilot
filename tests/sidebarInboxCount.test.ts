// The sidebar badge reads only its own shared row status while visible; request ownership is exercised through real rows.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render } from './support/pages-kit.ts';

const { createElement: h } = await import('react');
let onScreen = true;
mock.module('../src/lib/onScreen.ts', { namedExports: { useOnScreen: () => onScreen } });
const counts: Record<string, number> = { parent: 0, child: 1, detached: 2 };
const reads: string[] = [];
mock.module('../src/session/useChatRowState.ts', {
  namedExports: { useChatRowState: (id: string) => (reads.push(id), id in counts ? { attentionCount: counts[id] } : null) },
});
const { SidebarInboxCount } = await import('../src/components/sidebar/SidebarInboxCount.tsx');

test('each visible row shows its own count, including leaves and detached chats; unknown or idle rows show nothing', async () => {
  const view = await render(h(SidebarInboxCount, { threadId: 'child', row: { current: null } }));
  const count = () => view.host.querySelector('[role="img"]');
  assert.equal(count()?.textContent, '1');
  assert.equal(count()?.getAttribute('title'), '1 request needs you');
  for (const id of ['parent', 'unknown', 'detached']) {
    await view.rerender(h(SidebarInboxCount, { threadId: id, row: { current: null } }));
    assert.equal(count()?.textContent ?? null, id === 'detached' ? '2' : null);
  }
  assert.equal(count()?.getAttribute('aria-label'), '2 requests need you');
  await view.unmount();
  onScreen = false;
  reads.length = 0;
  const off = await render(h(SidebarInboxCount, { threadId: 'child', row: { current: null } }));
  assert.equal(off.host.innerHTML, '');
  assert.deepEqual(reads, []);
  await off.unmount();
});
