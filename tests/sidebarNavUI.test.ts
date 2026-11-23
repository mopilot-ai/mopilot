// The sidebar's app rows (src/components/sidebar/SidebarNav.tsx): New chat with Quick chat, Search, and the pages
// the left rail used to hold, each marked while it is open.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { fakeStore, popoverExports, render, click, press } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const store = fakeStore<any>({ route: { name: 'home' }, prefs: {}, newChatProjectId: null, newChatCwd: null });
const calls: unknown[][] = [];
let miniFails = false;
let momoOn = false;
let pushMomo: (allowed: boolean) => void = () => {};

stubStore({
  useStore: store.useStore,
  navigate: (route: any) => store.setState({ route }),
  setState: (p: any) => store.setState(p),
  toastFailure: (what: string) => (e: Error) => calls.push(['toast', what, e.message]),
});
installNativeStub({
  win: {
    mini: async () => {
      calls.push(['mini']);
      if (miniFails) throw new Error('no window');
    },
  },
  momo: {
    access: async () => momoOn,
    onAccess: (cb: (allowed: boolean) => void) => {
      pushMomo = cb;
      return () => {};
    },
  },
});
mockSource('src/components/sidebar/ChatLists.tsx', { newStandaloneChat: () => calls.push(['newChat']) });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });

const { SidebarNav } = await import('../src/components/sidebar/SidebarNav.tsx');
// the sidebar says whether it draws a row for the home page (Sidebar.tsx, from useProjectGroups' homeKey): `homeRow` in the test's state
const Nav = () => createElement(SidebarNav, { homeRow: store.useStore((s: any) => !!s.homeRow) });

const reset = (state: any = {}) => {
  store.reset({ route: { name: 'home' }, prefs: {}, newChatProjectId: null, newChatCwd: null, ...state });
  calls.length = 0;
  miniFails = false;
};
const rows = (host: Element) => [...host.querySelectorAll('.sidebar-nav > .side-row')] as HTMLElement[];
const label = (row: Element) => row.querySelector('.side-row-label')!.textContent;
const row = (host: Element, name: string) => rows(host).find((r) => label(r) === name)!;

test('New chat, Search and the four pages, in that order; New chat stays the first row button', async () => {
  reset();
  const { host, unmount } = await render(createElement(Nav));
  assert.deepEqual(rows(host).map(label), ['New chat', 'Search', 'Scheduled', 'Plugins', 'All projects', 'Code Review']);
  assert.equal(host.querySelector('.side-row[role=button]')!.getAttribute('aria-label'), 'New chat');
  // the shortcuts read beside their rows
  assert.ok(row(host, 'New chat').querySelector('.side-row-kbd')!.textContent);
  assert.ok(row(host, 'Search').querySelector('.side-row-kbd')!.textContent);
  await unmount();
});

test('each page row opens its page and is the one marked while it is open', async () => {
  reset({ route: { name: 'thread', id: 'codex:1' } });
  const { host, unmount } = await render(createElement(Nav));
  assert.equal(host.querySelectorAll('.selected, [aria-current]').length, 0, 'a chat marks no page');
  for (const [name, route] of [
    ['Scheduled', 'scheduled'],
    ['Plugins', 'plugins'],
    ['All projects', 'projects'],
    ['Code Review', 'review'],
  ]) {
    await click(row(host, name));
    assert.deepEqual(store.getState().route, { name: route });
    const marked = [...host.querySelectorAll('.side-row.selected')];
    assert.deepEqual(marked.map(label), [name]);
    assert.equal(marked[0].getAttribute('aria-current'), 'page');
  }
  await unmount();
});

test('Search opens the palette', async () => {
  reset();
  const { host, unmount } = await render(createElement(Nav));
  await click(host.querySelector('[aria-label="Search"]'));
  assert.equal(store.getState().searchOpen, true);
  await unmount();
});

test('New chat is marked on a home with no project, starts a chat by click or key, and Quick chat is its own button', async () => {
  reset();
  const { host, unmount } = await render(createElement(Nav));
  const newChat = () => row(host, 'New chat');
  assert.ok(newChat().classList.contains('selected-soft'));
  await click(newChat());
  await press(newChat(), 'Enter');
  assert.deepEqual(calls, [['newChat'], ['newChat']]);
  // a home page the sidebar draws a row for (its project or folder, picked or by default) is that row's
  await act(async () => store.setState({ homeRow: true }));
  assert.equal(newChat().classList.contains('selected-soft'), false);
  await act(async () => store.setState({ homeRow: false, route: { name: 'projects' } }));
  assert.equal(newChat().classList.contains('selected-soft'), false);
  // Quick chat opens the mini window without starting a chat, and says when it cannot
  calls.length = 0;
  await click(host.querySelector('[aria-label="Quick chat"]'));
  miniFails = true;
  await click(host.querySelector('[aria-label="Quick chat"]'));
  assert.deepEqual(calls, [['mini'], ['mini'], ['toast', "Couldn't open Quick Chat", 'no window']]);
  await unmount();
});

test('MoMo: no row for an account that was not invited; invited, its row sits between New chat and Search and opens MoMo', async () => {
  reset();
  const { host, unmount } = await render(createElement(Nav));
  assert.deepEqual(rows(host).map(label).slice(0, 3), ['New chat', 'Search', 'Scheduled']);
  await act(async () => pushMomo(true));
  assert.deepEqual(rows(host).map(label).slice(0, 3), ['New chat', 'MoMo', 'Search']);
  assert.ok(row(host, 'MoMo').querySelector('.momo-dot'));
  assert.ok(row(host, 'MoMo').querySelector('.side-row-kbd')!.textContent, 'its shortcut reads beside it');
  await click(row(host, 'MoMo'));
  assert.deepEqual(store.getState().route, { name: 'momo' });
  assert.equal(row(host, 'MoMo').getAttribute('aria-current'), 'page');
  await click(row(host, 'MoMo'));
  assert.deepEqual(store.getState().route, { name: 'momo' }, 'already there: nothing changes');
  await act(async () => pushMomo(false));
  assert.deepEqual(rows(host).map(label).slice(0, 2), ['New chat', 'Search'], 'revoked: the row goes');
  await unmount();
});
