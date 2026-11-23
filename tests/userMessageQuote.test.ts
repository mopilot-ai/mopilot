// A phone's Reply on a selection arrives as a quote ahead of the words (#4837): the Mac draws the quote as a quote block and the words under it, and a message that is not shaped so stays as it was.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, settle, setStore, resetStore, native, moduleCalls } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/ui/Popover.tsx', 'popover', {
  Tooltip: ({ children }: any) => children,
  MenuItem: ({ onSelect, children }: any) => h('button', { 'data-item': children, onClick: onSelect }, children),
});
autoMock('src/components/ui/FileMenu.tsx', 'menu', {
  useFileMenu: (path: string, { extra }: { extra?: unknown }) => ({
    target: { 'data-menu-for': path },
    menu: h('span', { 'data-menu': path }, extra as any),
  }),
});
autoMock('src/components/thread/PeerMessages.tsx', 'peer', { PeerContext: (await import('react')).createContext([]) });
autoMock('src/session/harness/claude.ts', 'claude', { useCommandProvider: () => null });
autoMock('src/session/open.ts', 'open');
const { UserMessage } = await import('../src/components/thread/view/UserMessage.tsx');
const { resetMessagePaths } = await import('../src/lib/messagePaths.ts');

beforeEach(() => {
  resetStore();
  resetMessagePaths();
  setStore({ threads: { c1: { id: 'c1', cwd: '/repo' } } });
  moduleCalls.length = 0;
  native.fs = { messagePath: async () => null };
});

const message = (text: string) =>
  h(UserMessage, {
    threadId: 'c1',
    turnId: 't1',
    userIndex: 0,
    canEdit: false,
    item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text }] },
  } as any);

test('a message that starts with a quote draws the quote as a quote block above the words', async () => {
  const v = await render(message('> first line\n> second line\n\nmy answer'));
  await settle();
  const quote = v.$('.user-bubble blockquote.user-quote')!;
  assert.ok(quote, 'a quote block, not raw ">" text');
  assert.equal(quote.textContent, 'first line\nsecond line');
  const bubble = v.$('.user-bubble')!.textContent!;
  assert.ok(bubble.endsWith('my answer'));
  assert.ok(!bubble.includes('>'), 'no ">" character is left in the bubble');
  await v.unmount();
});

test('a message that is not a quote followed by words is plain text as before', async () => {
  const v = await render(message('words > not a quote\n\n> later'));
  await settle();
  assert.equal(v.$('.user-bubble blockquote'), null);
  assert.equal(v.$('.user-bubble')!.textContent, 'words > not a quote\n\n> later');
  await v.unmount();
});
