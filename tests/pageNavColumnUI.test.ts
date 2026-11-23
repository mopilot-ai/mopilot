// The column around a page's own nav (src/components/sidebar/PageNavColumn.tsx): a way back to the chats above it,
// the account footer below it, now that no rail leads home from Scheduled, Plugins or Code Review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { render, click } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';

const routes: unknown[] = [];
stubStore({ navigate: (route: unknown) => routes.push(route) });
mockSource('src/components/sidebar/SidebarFooter.tsx', { SidebarFooter: () => createElement('i', { 'data-footer': '' }) });

const { PageNavColumn } = await import('../src/components/sidebar/PageNavColumn.tsx');

test('a page nav sits between Back to chats and the account footer, and Back goes home', async () => {
  const { host, unmount } = await render(
    createElement(PageNavColumn, null, createElement('aside', { className: 'sidebar', 'data-nav': '' })),
  );
  const column = host.querySelector('.page-nav-column')!;
  assert.deepEqual(
    [...column.children].map((c) => (c.hasAttribute('data-nav') ? 'nav' : c.hasAttribute('data-footer') ? 'footer' : c.className)),
    ['sidebar-section page-nav-back', 'nav', 'footer'],
  );
  const back = column.querySelector('.page-nav-back button')!;
  assert.equal(back.textContent, 'Back to chats');
  await click(back);
  assert.deepEqual(routes, [{ name: 'home' }]);
  await unmount();
});
