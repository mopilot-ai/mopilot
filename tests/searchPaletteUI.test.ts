// SearchPalette interactions, keyboard navigation and query results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement, Profiler } from 'react';
import { click, type, press, flush, render } from './support/shell-chrome-kit.ts';
import { searchPaletteKit, thread, THREADS } from './support/search-palette-kit.ts';
import { shortcutLabel } from '../src/lib/platform.ts';

const kit = await searchPaletteKit({ dynamicCwd: false, captureFileHits: false });
const { store, calls, reset, open, debounce, input, items, item, alert, mount, sections, selected, SearchPalette } = kit;

test('closed renders nothing; opened lists recent chats with catalog shortcuts, then quick actions and settings, and focuses the search', async () => {
  reset();
  const { host, unmount } = await mount();
  assert.equal(host.innerHTML, '');
  await open();
  await flush();
  assert.equal(input(host).placeholder, 'Search chats');
  assert.equal(document.activeElement, input(host));
  assert.deepEqual(sections(host), ['Chats', 'Quick actions', 'Settings']);
  assert.deepEqual(items(host), [
    'Alpha fix',
    'Beta work',
    'New chat',
    'Open folder',
    'Search files',
    'General',
    'Plugins',
    'Documentation',
  ]);
  const alpha = item(host, 'Alpha fix');
  assert.equal(alpha.querySelector('.palette-sub')!.textContent, 'Proj One');
  assert.equal(alpha.querySelector('.palette-right'), null, 'chat navigation follows sidebar order, not palette ranking');
  assert.equal(item(host, 'Beta work').querySelector('.palette-sub'), null);
  assert.equal(item(host, 'New chat').querySelector('.palette-right')!.textContent, shortcutLabel('⌘N'));
  assert.equal(item(host, 'General').querySelector('.palette-right'), null);
  assert.equal(selected(host), 'Alpha fix');
  await unmount();
});

test('typing filters actions and settings and merges remote chat hits after a pause; a failed search keeps only local results', async () => {
  reset();
  const { host, unmount } = await mount();
  await open();
  kit.searchFails = true;
  await type(input(host), 'alpha');
  await debounce();
  assert.deepEqual(items(host), ['Alpha fix']);
  assert.equal(alert(host), "Couldn't search older chats: offline", 'the local hits show, and the failed search says so');
  kit.searchFails = false;
  calls.length = 0;
  kit.remote = { codex: [thread('r', 'Remote general notes', { updatedAt: 5 })], claude: [], sage: [] };
  await type(input(host), 'gen');
  await type(input(host), 'gener');
  assert.deepEqual(items(host), ['General'], 'remote hits wait for the debounce');
  await debounce();
  assert.deepEqual(calls, [['searchThreads', 'gener']], 'the earlier keystroke was debounced away');
  assert.deepEqual(items(host), ['Remote general notes', 'General']);
  assert.equal(item(host, 'Remote general notes').querySelector('.palette-right'), null, 'no ⌃n shortcuts while searching');
  // a failed search drops the previous query's remote hits instead of showing them for this one
  kit.searchFails = true;
  await type(input(host), 'genera');
  await debounce();
  assert.deepEqual(items(host), ['General']);
  kit.searchFails = false;
  kit.remote = { codex: [], claude: [], sage: [] };
  await type(input(host), 'zzz');
  await debounce();
  assert.equal(alert(host), undefined, 'a search that ran clears the failure');
  assert.equal(host.querySelector('.palette-empty')!.textContent, 'No results');
  // clearing the query drops remote hits without searching
  calls.length = 0;
  await type(input(host), '  ');
  await debounce();
  assert.deepEqual(calls, []);
  assert.deepEqual(items(host).slice(0, 2), ['Alpha fix', 'Beta work']);
  await unmount();
});

test('choosing a chat the window has not loaded adds it before navigating; a loaded one just navigates', async () => {
  reset();
  const { host, unmount } = await mount();
  await open();
  const far = thread('far', 'Far away chat');
  kit.remote = { codex: [], claude: [far], sage: [] };
  await type(input(host), 'far');
  await debounce();
  await click(item(host, 'Far away chat'));
  assert.equal(store.getState().searchOpen, false);
  assert.equal(store.getState().searchMode, 'all');
  assert.deepEqual(store.getState().route, { name: 'thread', id: 'far' });
  assert.deepEqual(store.getState().threads.far, far);
  const before = store.getState().threads;
  await open();
  await click(item(host, 'Beta work'));
  assert.deepEqual(store.getState().route, { name: 'thread', id: 'b' });
  assert.equal(store.getState().threads, before, 'threads untouched');
  await unmount();
});

test('the keyboard moves the selection within bounds, Enter runs it, Escape closes', async () => {
  reset();
  const { host, unmount, scrolled } = await mount();
  await open();
  await press(input(host), 'ArrowUp');
  assert.equal(selected(host), 'Alpha fix');
  for (let i = 0; i < 9; i++) await press(input(host), 'ArrowDown');
  assert.equal(selected(host), 'Documentation');
  await press(input(host), 'ArrowUp');
  assert.equal(selected(host), 'Plugins');
  assert.equal(scrolled.at(-1), 'Plugins');
  await press(input(host), 'x');
  assert.equal(selected(host), 'Plugins');
  await act(async () => item(host, 'General').dispatchEvent(new (globalThis as any).window.MouseEvent('mousemove', { bubbles: true })));
  assert.equal(selected(host), 'General');
  await press(input(host), 'Enter');
  assert.equal(store.getState().searchOpen, false);
  assert.deepEqual(store.getState().route, { name: 'settings', section: 'general' });
  await open();
  await press(input(host), 'Escape');
  assert.equal(host.innerHTML, '');
  // Enter with no results does nothing
  await open();
  await type(input(host), 'qqqq');
  await press(input(host), 'Enter');
  assert.equal(store.getState().searchOpen, true);
  await unmount();
});

test('a click on the backdrop closes the palette, a click inside it does not', async () => {
  reset();
  const { host, unmount } = await mount();
  await open();
  const down = (el: Element) =>
    act(async () => el.dispatchEvent(new (globalThis as any).window.MouseEvent('mousedown', { bubbles: true })));
  await down(input(host));
  assert.equal(store.getState().searchOpen, true);
  await down(host.querySelector('.palette-backdrop')!);
  assert.equal(store.getState().searchOpen, false);
  await unmount();
});

test('quick actions: new chat, open folder (cancelled, uncreated, created), search files, and the plugins page', async () => {
  reset();
  const { host, unmount } = await mount();
  await open();
  await click(item(host, 'New chat'));
  assert.deepEqual(calls, [['clearProject', true]]);
  assert.deepEqual(store.getState().route, { name: 'home' });

  await act(async () => store.setState({ newChatProjectId: 'p0', route: null }));
  for (const [f, id] of [
    [null, null],
    ['/work/x', null],
    ['/work/y', 'p7'],
  ] as const) {
    kit.folder = f;
    kit.created = id;
    await open();
    await click(item(host, 'Open folder'));
  }
  assert.deepEqual(calls.slice(1), [['openFolder'], ['openFolder'], ['create', '/work/x'], ['openFolder'], ['create', '/work/y']]);
  assert.deepEqual(store.getState().route, { name: 'home', cwd: '/work/y' });
  assert.equal(store.getState().newChatProjectId, 'p7');
  assert.equal(store.getState().newChatCwd, null);

  await open();
  await click(item(host, 'Plugins'));
  assert.deepEqual(store.getState().route, { name: 'plugins' });

  await open();
  await click(item(host, 'Search files'));
  assert.equal(store.getState().searchOpen, true);
  assert.equal(store.getState().searchMode, 'files');
  assert.equal(input(host).placeholder, 'Search files');
  assert.equal(host.querySelector('.palette-empty')!.textContent, 'Type to search files');
  await unmount();
});

test('file search lists matches in the project and opens the chosen file; a failed search lists nothing', async () => {
  reset();
  const { host, unmount } = await mount();
  await open('files');
  kit.fileHits = { files: [{ path: 'src/a.ts', file_name: 'a.ts', root: '/cwd' }] };
  await type(input(host), 'a.ts');
  await debounce();
  assert.deepEqual(calls, [['files', '/cwd', 'a.ts', { limit: 40, dirs: false }]]);
  assert.deepEqual(sections(host), ['Files']);
  assert.equal(item(host, 'a.ts').querySelector('.palette-sub')!.textContent, 'src/a.ts');
  await click(item(host, 'a.ts'));
  assert.deepEqual(calls.at(-1), ['openFile', '/cwd/src/a.ts']);
  await open('files');
  await type(input(host), 'a.ts');
  await debounce();
  assert.deepEqual(items(host), ['a.ts']);
  // a failed search shows no files rather than the previous query's
  kit.filesFail = true;
  await type(input(host), 'a.tsx');
  await debounce();
  assert.deepEqual(items(host), []);
  assert.equal(alert(host), "Couldn't search files: no index", 'a failed search is not "No results"');
  assert.equal(host.querySelectorAll('.palette-empty').length, 1);
  kit.filesFail = false;
  // clearing the query clears the list too
  await type(input(host), 'a.ts');
  await debounce();
  assert.deepEqual(items(host), ['a.ts']);
  await type(input(host), '');
  assert.equal(host.querySelector('.palette-empty')!.textContent, 'Type to search files');
  // reopening (or switching mode) starts over with an empty list
  await open('files');
  assert.equal(host.querySelector('.palette-empty')!.textContent, 'Type to search files');
  await type(input(host), 'none');
  assert.equal(host.querySelector('.palette-empty')!.textContent, 'No results');
  await unmount();
});

test('an answer for an earlier query that arrives late does not replace the current results', async () => {
  reset();
  const { host, unmount } = await mount();
  await open();
  let release!: () => void;
  kit.held.alpha = new Promise<void>((r) => (release = r));
  kit.byQuery.alpha = { codex: [thread('old', 'Stale alpha hit', { updatedAt: 9 })], claude: [], sage: [] };
  kit.byQuery.beta = { codex: [thread('new', 'Fresh beta hit', { updatedAt: 9 })], claude: [], sage: [] };
  await type(input(host), 'alpha');
  await debounce(); // the alpha search is still in flight
  await type(input(host), 'beta');
  await debounce();
  assert.deepEqual(items(host), ['Fresh beta hit', 'Beta work']);
  await act(async () => release());
  await flush();
  assert.deepEqual(items(host), ['Fresh beta hit', 'Beta work']);
  await unmount();
});

test('a file search that answers after the query changed is dropped, even when it failed', async () => {
  reset();
  const { host, unmount } = await mount();
  await open('files');
  let release!: () => void;
  kit.filesHeld = new Promise<void>((r) => (release = r));
  kit.filesFail = true;
  await type(input(host), 'old');
  await debounce(); // the old search waits on filesHeld
  kit.filesHeld = null;
  kit.filesFail = false;
  kit.fileHits = { files: [{ path: 'src/new.ts', file_name: 'new.ts', root: '/cwd' }] };
  await type(input(host), 'new');
  await debounce();
  assert.deepEqual(items(host), ['new.ts']);
  await act(async () => release());
  await flush();
  assert.deepEqual(items(host), ['new.ts']);
  assert.equal(alert(host), undefined, "the old query's failure is not shown for the new one");
  await unmount();
});

test('switching the open palette to files mode starts over: no query, selection or results from the chat search', async () => {
  reset();
  const { host, unmount, scrolled, frames } = await mount();
  await open();
  kit.byQuery.beta = { codex: [thread('remote', 'Remote beta', { updatedAt: 9 })], claude: [], sage: [] };
  await type(input(host), 'beta');
  await debounce();
  await press(input(host), 'ArrowDown');
  assert.equal(selected(host), 'Beta work');
  assert.equal(scrolled.at(-1), 'Beta work', 'the highlighted row is scrolled into view');
  frames.length = 0;
  await act(async () => store.setState({ searchMode: 'files' }));
  assert.ok(frames.length > 0);
  assert.deepEqual(
    frames.filter(([, value]) => value === 'beta'),
    [],
    'no frame shows the chat query in files mode',
  );
  await flush();
  assert.equal(input(host).value, '');
  assert.equal(input(host).placeholder, 'Search files');
  assert.equal(host.querySelector('.palette-empty')!.textContent, 'Type to search files');
  assert.equal(document.activeElement, input(host));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'files'),
    [],
    'the chat query is never searched as a file name',
  );
  kit.fileHits = { files: [{ path: 'src/a.ts', file_name: 'a.ts', root: '/cwd' }] };
  await type(input(host), 'a');
  await debounce();
  assert.deepEqual(items(host), ['a.ts']);
  // closing and opening again (in chat mode) starts over too
  await press(input(host), 'Escape');
  await open();
  assert.equal(input(host).value, '');
  assert.equal(selected(host), 'Alpha fix');
  await unmount();
});

test('closed, the palette renders nothing for chat-list writes (before: it merged every chat on each); open, it follows them', async () => {
  reset();
  let commits = 0;
  const r = await render(createElement(Profiler, { id: 'closed', onRender: () => void (commits += 1) }, createElement(SearchPalette)));
  const base = commits;
  for (let n = 0; n < 20; n++)
    await act(async () =>
      store.setState({ threads: { ...THREADS, [`x${n}`]: thread(`x${n}`, `Chat ${n}`) }, threadOrder: ['a', `x${n}`] }),
    );
  assert.equal(commits - base, 0);
  await open();
  await flush();
  assert.deepEqual(items(r.host).slice(0, 2), ['Alpha fix', 'Chat 19']);
  await r.unmount();
});
