// A sent message's `@path` (the composer's @ menu pick), as the thread draws it: accent link text with its `@`, opened in
// the chat's folder on a click (Cmd-click: the file's app), with the path menu; plain text while nothing is there.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import {
  mockStore,
  autoMock,
  stubComponent,
  render,
  settle,
  setStore,
  resetStore,
  native,
  callsTo,
  moduleCalls,
} from './support/thread-kit.ts';

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
const { UserMessage, linkify } = await import('../src/components/thread/view/UserMessage.tsx');
const { resetMessagePaths } = await import('../src/lib/messagePaths.ts');
const { RemoteFolderContext } = await import('../src/lib/remoteFolder.ts');

const MENU_ITEM = 'Open with default app';
const asked: [string, string | null][] = [];
const answers: Record<string, any> = {
  'Design1_MenggeWang.pdf': { path: '/repo/Design1_MenggeWang.pdf', kind: 'file' },
  'src/a.ts': { path: '/repo/src/a.ts', kind: 'file' },
};
beforeEach(() => {
  resetStore();
  resetMessagePaths();
  setStore({ threads: { c1: { id: 'c1', cwd: '/repo' } } });
  moduleCalls.length = 0;
  asked.length = 0;
  native.fs = {
    messagePath: async (p: string, cwd: string | null) => {
      asked.push([p, cwd]);
      return answers[p] ?? null;
    },
  };
});

const message = (text: string) =>
  h(UserMessage, {
    threadId: 'c1',
    turnId: 't1',
    userIndex: 0,
    canEdit: false,
    item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text }] },
  } as any);

test('the reported message: the file reads as a link with its @, opens in the chat folder, Cmd-click in its app', async () => {
  const v = await render(message('@Design1_MenggeWang.pdf 看看这个'));
  await settle();
  const link = v.$('.user-bubble a.bubble-file-link') as HTMLAnchorElement;
  assert.ok(link, 'a link, not plain text');
  assert.equal(link.textContent, '@Design1_MenggeWang.pdf');
  assert.equal(link.getAttribute('href'), 'Design1_MenggeWang.pdf');
  assert.equal(link.title, '/repo/Design1_MenggeWang.pdf');
  assert.equal(link.getAttribute('data-menu-for'), '/repo/Design1_MenggeWang.pdf', 'right-click: the path menu');
  // the stubbed menu draws its item inline; the bubble's own text reads as sent
  assert.equal(v.$('.user-bubble')!.textContent!.replace(MENU_ITEM, ''), '@Design1_MenggeWang.pdf 看看这个');
  assert.deepEqual(asked, [['Design1_MenggeWang.pdf', '/repo']]);
  await settle(() => link.click());
  assert.deepEqual(callsTo('open:openMessagePath'), [['Design1_MenggeWang.pdf', '/repo', { line: undefined, endLine: undefined }, false]]);
  await settle(() =>
    link.dispatchEvent(new (link.ownerDocument.defaultView as any).MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })),
  );
  assert.equal(callsTo('open:openMessagePath').at(-1)![3], true);
  await settle(() => v.$('[data-item="Open with default app"]')!.click());
  assert.deepEqual(callsTo('open:openFile'), [['/repo/Design1_MenggeWang.pdf']]);
  await v.unmount();
});

test('a mention of nothing there stays text; a name or mail is never looked up', async () => {
  const v = await render(message('@gone.pdf and @john.doe at me@x.com'));
  await settle();
  assert.equal(v.$('a.bubble-file-link'), null);
  assert.equal(v.$('.user-bubble')!.textContent, '@gone.pdf and @john.doe at me@x.com');
  assert.deepEqual(asked, [['gone.pdf', '/repo']]);
  await v.unmount();
});

test('files, web links and chat tokens in one bubble each keep their own link', async () => {
  const v = await render(h('p', null, linkify('fix @src/a.ts per https://x.test/a, ask [Chat](session://c2) about @src/a.ts.', '/repo')));
  await settle();
  const files = v.$$('a.bubble-file-link');
  assert.deepEqual(
    files.map((a) => a.textContent),
    ['@src/a.ts', '@src/a.ts'],
  );
  assert.equal(v.$('a.bubble-link[href="https://x.test/a"]')!.textContent, 'https://x.test/a');
  assert.equal(v.$('a.composer-session-token')!.textContent, 'Chat');
  assert.ok(v.$('p')!.textContent!.replaceAll(MENU_ITEM, '').endsWith('about @src/a.ts.'), 'the full stop stays text after the link');
  await v.unmount();
});

test('a chat whose folder is not known asks main nothing: its mentions stay text', async () => {
  setStore({ threads: {} });
  const v = await render(message('@src/a.ts'));
  await settle();
  assert.equal(v.$('a.bubble-file-link'), null);
  assert.equal(v.$('.user-bubble')!.textContent, '@src/a.ts');
  assert.deepEqual(asked, []);
  await v.unmount();
});

test('a chat on a machine leaves its mentions as text: this Mac is not asked about that folder', async () => {
  const v = await render(h(RemoteFolderContext.Provider, { value: { machineId: 'm1', folder: '/srv/app' } }, message('@src/a.ts')));
  await settle();
  assert.equal(v.$('a.bubble-file-link'), null);
  assert.deepEqual(asked, []);
  await v.unmount();
});
