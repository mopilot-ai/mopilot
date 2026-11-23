// The real sidebar chat menu: letter hints/actions, harness parity, opening destinations and PR read ownership.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { $, $$, click, key, mount, fakeStore } from './support/composer-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
import { controlledReads } from './support/async-scenarios.ts';
import type { Thread } from '../src/store/types.ts';
import type { ThreadPullRequest } from '../src/lib/threadPullRequest.ts';

const initial = () => ({ pinned: {}, unread: {}, runtime: {}, prefs: { openDestination: 'finder' } });
const store = fakeStore<any>(initial());
const calls: any[][] = [];
const failures: Record<string, boolean> = {};
let confirmed = false;
let nativeSuffix = '';
let read: () => Promise<ThreadPullRequest | null> = async () => null;
let known: (...args: unknown[]) => ThreadPullRequest | null | undefined = () => undefined;
const action =
  (name: string) =>
  async (...args: any[]) => {
    calls.push([name, ...args]);
    if (failures[name]) throw new Error('unavailable');
  };
mockSource('src/store/hostAgent.ts', { hostAgentOf: () => 'codex' });
stubStore({
  openPaneTab: action('pane'),
  useStore: store.useStore,
  setState: store.setState,
  nativeOf: (id: string) => id + nativeSuffix,
  archiveThread: action('archive'),
  deleteThread: action('delete'),
  forkThread: action('fork'),
  openInSplit: action('split'),
  toastFailure: (what: string) => (error: Error) => calls.push(['error', what, error.message]),
  toast: (...args: any[]) => calls.push(['toast', ...args]),
});
installNativeStub({
  app: { installed: async () => ({ finder: true, cursor: true }), icon: async () => null },
  shell: { openPath: action('finder'), openIn: action('editor'), openExternal: action('link') },
  win: { open: action('window') },
});
mock.module('../src/session/pullRequestReader.ts', {
  namedExports: {
    readPullRequest: Object.assign(
      (...args: unknown[]) => {
        calls.push(['read', ...args]);
        return read();
      },
      { known: (...args: unknown[]) => known(...args) },
    ),
  },
});
const { ThreadMenu } = await import('../src/components/sidebar/ThreadMenu.tsx');
const chat = (id = 'codex/chat', extra: Partial<Thread> = {}) => ({ id, cwd: '/work', updatedAt: 1, ...extra }) as Thread;
const menu = (thread = chat(), open = true, pinned = false) =>
  h(ThreadMenu, {
    thread,
    open,
    pinned,
    anchor: { x: 25, y: 40 },
    onClose: () => calls.push(['close']),
    onRename: () => calls.push(['rename']),
  });
const list = () => $('[role="menu"]');
const item = (title: string) => $$('.menu-item').find((el) => el.querySelector('.menu-label')?.textContent === title)!;
const labels = () => $$('.menu-label', list()).map((el) => el.textContent);
const pr = (n: number) => ({ url: `https://github.com/org/repo/pull/${n}` }) as ThreadPullRequest;
beforeEach(() => {
  store.reset(initial());
  calls.length = 0;
  for (const name of Object.keys(failures)) delete failures[name];
  confirmed = false;
  nativeSuffix = '';
  read = async () => null;
  known = () => undefined;
  Object.defineProperty(globalThis, 'confirm', {
    configurable: true,
    value: (message: string) => {
      calls.push(['confirm', message]);
      return confirmed;
    },
  });
});

test('all harnesses have the same concise actions and right-aligned menu-local letters', async () => {
  for (const id of ['codex/chat', 'claude-chat', 'acp:gemini:chat']) {
    calls.length = 0;
    read = async () => pr(1);
    const view = await mount(menu(chat(id)));
    assert.deepEqual(labels(), ['Open PR', 'Open in', 'Pin', 'Mark as unread', 'Rename', 'Fork', 'Archive', 'Delete']);
    assert.deepEqual(
      $$('.menu-shortcut', list()).map((hint) => hint.textContent),
      ['G', 'P', 'U', 'R', 'F', 'A', 'D'],
    );
    assert.ok($$('.menu-shortcut').every((hint) => hint.getAttribute('aria-hidden') === 'true'));
    assert.ok(item('Delete').classList.contains('danger'));
    list().focus();
    for (const letter of ['g', 'p', 'U', 'r', 'f', 'a', 'd']) await key(list(), letter);
    assert.equal(store.get().pinned[id], true);
    assert.equal(store.get().unread[id], true);
    assert.ok(calls.some(([name, value]) => name === 'link' && value.endsWith('/1')));
    assert.ok(calls.some(([name, value]) => name === 'fork' && value === id));
    assert.ok(calls.some(([name, value]) => name === 'archive' && value === id));
    assert.ok(calls.some(([name]) => name === 'rename'));
    assert.equal(calls.filter(([name]) => name === 'delete').length, 0, 'declining confirmation preserves the chat');
    confirmed = true;
    await key(list(), 'D');
    assert.ok(calls.some(([name, value]) => name === 'delete' && value === id));
    await view.render(menu(chat(id), true, true));
    assert.ok(item('Unpin'));
    await click(item('Unpin'));
    assert.equal(store.get().pinned[id], false);
    await view.unmount();
    confirmed = false;
  }
});

test('menu actions preserve independent state and report failures through the existing actions', async () => {
  const view = await mount(menu());
  await act(async () => store.set({ pinned: { other: true, 'codex/chat': true }, unread: { other: true } }));
  await click(item('Pin'));
  await click(item('Mark as unread'));
  assert.deepEqual(store.get().pinned, { other: true, 'codex/chat': false });
  assert.deepEqual(store.get().unread, { other: true, 'codex/chat': true });
  confirmed = true;
  for (const name of ['fork', 'archive', 'delete']) {
    failures[name] = true;
    await click(item(name[0].toUpperCase() + name.slice(1)));
  }
  assert.deepEqual(
    calls.filter(([name]) => name === 'error'),
    [
      ['error', "Couldn't fork the chat", 'unavailable'],
      ['error', "Couldn't archive the chat", 'unavailable'],
      ['error', "Couldn't delete the chat", 'unavailable'],
    ],
  );
  await view.unmount();
});

test('Open in groups split, window, Finder and installed editors in one submenu', async () => {
  const view = await mount(menu());
  assert.equal(labels().includes('Split view'), false);
  await click(item('Open in'));
  for (const title of ['Split view', 'New window', 'Finder', 'Cursor']) await click(item(title));
  assert.ok(calls.some(([name, id]) => name === 'split' && id === 'codex/chat'));
  assert.ok(calls.some(([name, hash]) => name === 'window' && hash.includes('codex')));
  assert.ok(calls.some(([name, path]) => name === 'finder' && path === '/work'));
  assert.ok(calls.some(([name, app, path]) => name === 'editor' && app === 'cursor' && path === '/work'));
  await view.unmount();
});

test('PR reads cannot publish after the chat, folder, version, harness, menu opening or mount retires', async () => {
  for (const settleOld of ['resolve', 'reject'] as const) {
    const reads = controlledReads<ThreadPullRequest | null>();
    read = reads.read;
    const original = chat('opaque:chat/"x');
    const view = await mount(menu(original, false));
    assert.equal(reads.requests.length, 0);
    await view.render(menu(original));
    await view.render(menu(chat('replacement')));
    assert.equal(item('Open PR'), undefined);
    await act(async () => reads.requests[1].resolve(pr(2)));
    await act(async () => (settleOld === 'resolve' ? reads.requests[0].resolve(pr(1)) : reads.requests[0].reject(new Error('old'))));
    await click(item('Open PR'));
    assert.deepEqual(calls.at(-2), ['link', pr(2).url]);
    // A same-chat folder or history change also retires the prior result immediately.
    await view.render(menu(chat('replacement', { cwd: '/other' })));
    assert.equal(item('Open PR'), undefined);
    await act(async () => reads.requests[2].reject(new Error('current')));
    assert.equal(item('Open PR'), undefined);
    await view.render(menu(chat('replacement', { cwd: '/other', updatedAt: 2 })));
    await view.render(menu(chat('replacement', { cwd: '/other', updatedAt: 2 }), false));
    await act(async () => reads.requests[3].resolve(pr(3)));
    assert.equal(document.querySelector('[role="menu"]'), null);
    await view.render(menu(chat('replacement', { cwd: '/other', updatedAt: 2 })));
    await act(async () => reads.requests[4].resolve(pr(4)));
    assert.ok(item('Open PR'), 'a fresh open still succeeds after retirement and failure');
    await view.render(menu(chat('last')));
    await view.unmount();
    await act(async () => reads.requests[5].reject(new Error('unmounted')));
  }
});

test('a completed turn and a switched native session retire PR reads while replacement work is pending', async () => {
  const reads = controlledReads<ThreadPullRequest | null>();
  read = reads.read;
  // the chat's known PR fills only the opening's first wait, never a retired one
  known = () => pr(9);
  const view = await mount(menu());
  assert.ok(item('Open PR'));
  await act(async () =>
    store.set({
      runtime: {
        'codex/chat': {
          turns: [
            { id: 'done', status: 'completed' },
            { id: 'working', status: 'inProgress' },
          ],
        },
      },
    }),
  );
  assert.equal(reads.requests.length, 2);
  await act(async () => reads.requests[0].resolve(pr(1)));
  // no read settled yet for this opening: the known PR stands in, never the retired read's
  await click(item('Open PR'));
  assert.deepEqual(calls.at(-2), ['link', pr(9).url], 'retired success cannot populate the pending replacement');
  await act(async () => reads.requests[1].resolve(pr(2)));
  assert.ok(item('Open PR'));
  nativeSuffix = '/switched';
  await act(async () => store.set({}));
  assert.equal(item('Open PR'), undefined, 'native session switches immediately hide the prior PR');
  await act(async () => reads.requests[2].resolve(pr(3)));
  await click(item('Open PR'));
  assert.deepEqual(calls.at(-2), ['link', pr(3).url]);
  await view.unmount();
});

test("Open PR shows at once from the chat's known PR, and the opening's cached read still decides", async () => {
  const reads = controlledReads<ThreadPullRequest | null>();
  read = reads.read;
  const version = JSON.stringify([1, 'codex/chat']);
  known = (id, cwd, v) => (id === 'codex/chat' && cwd === '/work' && v === version ? pr(7) : undefined);
  const view = await mount(menu());
  assert.ok(item('Open PR'), 'no wait for GitHub before the item shows');
  assert.deepEqual(
    calls.find(([name]) => name === 'read'),
    ['read', 'codex/chat', '/work', false, version],
    'the menu reuses the minute cache the row badge keeps warm',
  );
  await click(item('Open PR'));
  assert.deepEqual(calls.at(-2), ['link', pr(7).url]);
  await act(async () => reads.requests[0].resolve(null));
  assert.equal(item('Open PR'), undefined, "the opening's own settled read replaces the known PR");
  // a known PR of another folder or history version is not this chat's now
  await view.render(menu(chat('codex/chat', { cwd: '/other' })));
  assert.equal(item('Open PR'), undefined);
  await view.render(menu(chat('codex/chat', { updatedAt: 2 })));
  assert.equal(item('Open PR'), undefined);
  await view.unmount();
});
