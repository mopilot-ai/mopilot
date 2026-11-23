// The address bar's suggestions (src/lib/browserSuggest.ts, BrowserSuggestions.tsx), the bookmark star and the Bookmarks menu (BrowserBookmarks.tsx).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as React from 'react';
import { mockSource, popoverStubs, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const { act, createElement } = React;
const f: any = {
  calls: [] as any[][],
  handlers: {} as Record<string, (...a: any[]) => any>,
  bookmarkListeners: new Set<() => void>(),
  flags: { 'shared.browser.import': true },
};
const call =
  (name: string) =>
  (...a: any[]) => (f.calls.push([name, ...a]), f.handlers[name](...a));
installNativeStub({
  browser: {
    suggest: call('suggest'),
    removeHistory: call('removeHistory'),
    bookmarks: call('bookmarks'),
    bookmarked: call('bookmarked'),
    toggleBookmark: call('toggleBookmark'),
    removeBookmark: call('removeBookmark'),
    onBookmarksChanged: (cb: () => void) => (f.bookmarkListeners.add(cb), () => f.bookmarkListeners.delete(cb)),
  },
});
mockSource('src/lib/flags.ts', { isEnabled: (k: string) => !!f.flags[k] });
stubStore({ toast: (...a: unknown[]) => f.calls.push(['toast', ...a]) });
mockSource('src/components/ui/Popover.tsx', popoverStubs({ item: 'div' }));
const { createRoot } = await import('react-dom/client');
const { useSuggestions, SUGGEST_DELAY_MS } = await import('../src/lib/browserSuggest.ts');
const { SuggestionList } = await import('../src/components/panels/BrowserSuggestions.tsx');
const { BookmarkStar, BookmarksMenu, bookmarkTree, searchBookmarks, SEARCH_LIMIT } = await import(
  '../src/components/panels/BrowserBookmarks.tsx'
);

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;
async function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(el));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  f.calls = [];
  f.bookmarkListeners.clear();
  f.flags = { 'shared.browser.import': true };
});
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const click = (el: Element) => act(async () => void el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any));
const rows = [
  { kind: 'bookmark', url: 'https://docs.test/', title: 'Docs' },
  { kind: 'history', url: 'https://www.news.test/a', title: '' },
];

test('SuggestionList: nothing for no rows; bookmarks and visited pages with their addresses; a click picks, hovering highlights, a press keeps the address bar focused', async () => {
  const picked: string[] = [];
  const hovered: number[] = [];
  await render(createElement(SuggestionList, { items: [], index: -1, onPick: () => {}, onHover: () => {} }));
  assert.equal(container.querySelector('.browser-suggest'), null);
  await act(async () =>
    root!.render(
      createElement(SuggestionList, {
        items: rows as any,
        index: 1,
        onPick: (u: string) => picked.push(u),
        onHover: (i: number) => hovered.push(i),
      }),
    ),
  );
  const list = container.querySelector('.menu.browser-suggest')!;
  assert.equal(list.getAttribute('role'), 'listbox');
  const options = [...list.querySelectorAll('[role=option]')];
  assert.deepEqual(
    options.map((o) => o.getAttribute('aria-selected')),
    ['false', 'true'],
  );
  assert.equal(options[0].querySelector('.browser-suggest-title')!.textContent, 'Docs');
  assert.equal(options[1].querySelector('.browser-suggest-title')!.textContent, 'https://www.news.test/a', 'no title: the address');
  assert.equal(options[1].querySelector('.browser-suggest-url')!.textContent, 'news.test/a');
  const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  options[0].dispatchEvent(press as any);
  assert.equal(press.defaultPrevented, true);
  await act(async () => void options[1].dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }) as any));
  await click(options[0]);
  assert.deepEqual(picked, ['https://docs.test/']);
  assert.deepEqual(hovered, [1]);
});

function Probe({ text, active }: { text: string; active: boolean }) {
  const s = useSuggestions(text, active);
  f.hook = s;
  return createElement('div', { 'data-count': s.items.length, 'data-index': s.index });
}

test('useSuggestions: asks after a pause, keeps only the newest answer, wraps the highlight through "none", and drops a forgotten row', async () => {
  const answers: Record<string, any[]> = { a: [rows[0]], ab: rows };
  let release: (v: any[]) => void = () => {};
  f.handlers.suggest = (text: string) => (text === 'slow' ? new Promise((r) => (release = r)) : Promise.resolve(answers[text] ?? []));
  await render(createElement(Probe, { text: '', active: true }));
  await wait(SUGGEST_DELAY_MS + 40);
  assert.deepEqual(f.calls, [], 'no text, no question');
  await act(async () => root!.render(createElement(Probe, { text: 'a', active: false })));
  await wait(SUGGEST_DELAY_MS + 40);
  assert.deepEqual(f.calls, [], 'not typing, no question');
  await act(async () => root!.render(createElement(Probe, { text: 'ab', active: true })));
  await wait(SUGGEST_DELAY_MS + 40);
  assert.deepEqual(f.calls, [['suggest', 'ab']]);
  assert.equal(f.hook.items.length, 2);
  // the highlight: none → 0 → 1 → none → 1 (up from none wraps to the last)
  await act(async () => f.hook.move(1));
  assert.equal(f.hook.index, 0);
  await act(async () => f.hook.move(1));
  assert.equal(f.hook.index, 1);
  await act(async () => f.hook.move(1));
  assert.equal(f.hook.index, -1);
  await act(async () => f.hook.move(-1));
  assert.equal(f.hook.index, 1);
  await act(async () => f.hook.setIndex(0));
  assert.equal(f.hook.index, 0);
  await act(async () => f.hook.drop('https://docs.test/'));
  assert.deepEqual(
    f.hook.items.map((r: any) => r.url),
    ['https://www.news.test/a'],
  );
  // an answer that arrives after the user typed on is ignored
  await act(async () => root!.render(createElement(Probe, { text: 'slow', active: true })));
  await wait(SUGGEST_DELAY_MS + 40);
  await act(async () => root!.render(createElement(Probe, { text: 'a', active: true })));
  await wait(SUGGEST_DELAY_MS + 40);
  assert.deepEqual(
    f.hook.items.map((r: any) => r.url),
    ['https://docs.test/'],
  );
  await act(async () => release(rows));
  assert.deepEqual(
    f.hook.items.map((r: any) => r.url),
    ['https://docs.test/'],
  );
  // clearing the text clears the list; a failed question is an empty list
  await act(async () => root!.render(createElement(Probe, { text: '  ', active: true })));
  assert.equal(f.hook.items.length, 0);
  f.handlers.suggest = () => Promise.reject(new Error('main is busy'));
  await act(async () => root!.render(createElement(Probe, { text: 'z', active: true })));
  await wait(SUGGEST_DELAY_MS + 40);
  assert.equal(f.hook.items.length, 0);
});

test('BookmarkStar: shows whether the page is bookmarked, toggles it, follows changes from other windows, and is off for pages that cannot be bookmarked', async () => {
  let marked = false;
  f.handlers.bookmarked = async () => marked;
  f.handlers.toggleBookmark = async () => ((marked = !marked), { bookmarked: marked, ok: true });
  await render(createElement(BookmarkStar, { url: 'https://a.test/', title: 'A' }));
  const star = () => container.querySelector('.browser-star') as HTMLButtonElement;
  assert.equal(star().getAttribute('aria-pressed'), 'false');
  assert.equal(star().getAttribute('aria-label'), 'Bookmark this page');
  await click(star());
  assert.deepEqual(
    f.calls.find((c: any[]) => c[0] === 'toggleBookmark'),
    ['toggleBookmark', { url: 'https://a.test/', title: 'A' }],
  );
  // main tells every window; this one reads the new state
  await act(async () => f.bookmarkListeners.forEach((cb: () => void) => cb()));
  assert.equal(star().getAttribute('aria-pressed'), 'true');
  assert.equal(star().getAttribute('aria-label'), 'Remove bookmark');
  // a page that is not http(s) cannot be bookmarked
  await act(async () => root!.render(createElement(BookmarkStar, { url: 'about:blank', title: '' })));
  assert.equal(star().disabled, true);
  assert.equal(star().getAttribute('aria-pressed'), 'false');
  // a refused or failed toggle says so
  await act(async () => root!.render(createElement(BookmarkStar, { url: 'https://b.test/', title: 'B' })));
  f.handlers.toggleBookmark = async () => ({ bookmarked: false, ok: false });
  await click(star());
  f.handlers.toggleBookmark = async () => {
    throw new Error('no');
  };
  await click(star());
  assert.equal(f.calls.filter((c: any[]) => c[0] === 'toast').length, 2);
  // reading the state can fail without a trace in the page
  f.handlers.bookmarked = async () => {
    throw new Error('main is busy');
  };
  await act(async () => f.bookmarkListeners.forEach((cb: () => void) => cb()));
  // an old answer never overwrites a newer one
  let late: (v: boolean) => void = () => {};
  f.handlers.bookmarked = (url: string) =>
    url === 'https://slow.test/' ? new Promise<boolean>((r) => (late = r)) : Promise.resolve(false);
  await act(async () => root!.render(createElement(BookmarkStar, { url: 'https://slow.test/', title: '' })));
  await act(async () => root!.render(createElement(BookmarkStar, { url: 'https://fast.test/', title: '' })));
  await act(async () => late(true));
  assert.equal(star().getAttribute('aria-pressed'), 'false');
});

test('bookmarkTree and searchBookmarks: folders nest by path in the order they first appear; search matches titles, addresses and folders', () => {
  const b = (id: string, folderPath: string[], title = id) => ({
    id,
    title,
    url: `https://${id}.test/`,
    folderPath,
    addedAt: 0,
    source: 'local',
  });
  const tree = bookmarkTree([
    b('a', []),
    b('b', ['Imported from Chrome', 'Work']),
    b('c', ['Imported from Chrome']),
    b('d', ['Imported from Chrome', 'Work']),
  ]);
  assert.deepEqual(
    tree.items.map((i) => i.id),
    ['a'],
  );
  assert.deepEqual(
    tree.folders.map((f) => f.name),
    ['Imported from Chrome'],
  );
  const imported = tree.folders[0];
  assert.deepEqual(
    imported.items.map((i) => i.id),
    ['c'],
  );
  assert.deepEqual(
    imported.folders[0].items.map((i) => i.id),
    ['b', 'd'],
  );
  const all = [b('docs', [], 'API Docs'), b('mongo', ['SQL'], 'MongoDB tutorial'), b('x', [], 'Other')];
  assert.deepEqual(
    searchBookmarks(all, ' MONGO ').map((i) => i.id),
    ['mongo'],
  );
  assert.deepEqual(
    searchBookmarks(all, 'docs.test').map((i) => i.id),
    ['docs'],
  );
  assert.deepEqual(searchBookmarks(all, '  '), []);
  assert.deepEqual(
    searchBookmarks(all, 'sql').map((i) => i.id),
    ['mongo'],
    'a folder name finds the bookmarks inside it',
  );
});

test('BookmarksMenu: folders as submenus, a search over every bookmark, opening one, the import entry, and an empty list', async () => {
  const items = [
    { id: '1', title: 'Docs', url: 'https://docs.test/', folderPath: [], addedAt: 1, source: 'local' },
    {
      id: '2',
      title: 'Wiki',
      url: 'https://wiki.test/',
      folderPath: ['Imported from Chrome', 'Work'],
      addedAt: 2,
      source: 'import:chrome',
    },
    {
      id: '3',
      title: 'Mongo',
      url: 'https://mongo.test/',
      folderPath: ['Imported from Chrome', 'Empty?'],
      addedAt: 3,
      source: 'import:chrome',
    },
  ];
  let list: any[] = items;
  f.handlers.bookmarks = async () => list;
  const opened: string[] = [];
  const events: string[] = [];
  const onImport = (e: any) => {
    events.push(String(e.detail));
  };
  window.addEventListener('open-browser-import', onImport);
  await render(createElement(BookmarksMenu, { onOpen: (u: string) => opened.push(u) }));
  assert.equal(container.querySelector('[role=menu]'), null, 'closed until clicked');
  await act(async () => f.bookmarkListeners.forEach((cb: () => void) => cb()));
  assert.equal(f.calls.length, 0, 'nothing is read while it is closed');
  const button = () => container.querySelector('button[aria-label=Bookmarks]')!;
  await click(button());
  await wait(10);
  assert.equal(button().getAttribute('aria-expanded'), 'true');
  // the root: the folder as a submenu, then the user's own bookmark, then the import entry
  assert.deepEqual(
    [...container.querySelectorAll('[data-submenu]')].map((s) => s.getAttribute('data-submenu')),
    ['Imported from Chrome', 'Work', 'Empty?'],
  );
  const labels = () => [...container.querySelectorAll('[role=menuitem]:not(.browser-bookmark-remove)')].map((m) => m.textContent);
  assert.deepEqual(labels(), ['Wiki', 'Mongo', 'Docs', 'Import from another browser…']);
  await click([...container.querySelectorAll('[role=menuitem]:not(.browser-bookmark-remove)')][0]);
  assert.deepEqual(opened, ['https://wiki.test/']);
  // search: every bookmark, flat, with its folder
  await click(button());
  await wait(10);
  const search = container.querySelector('input[aria-label="Search bookmarks"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'mon');
    search.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
  assert.deepEqual(labels(), ['MongoImported from Chrome › Empty?', 'Import from another browser…']);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'docs');
    search.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
  assert.deepEqual(labels(), ['Docs', 'Import from another browser…'], 'an unfiled bookmark has no folder line');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'nothing like it');
    search.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
  assert.match(container.querySelector('.menu-empty')!.textContent!, /No bookmark matches/);
  const type = (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, text);
      search.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
    });
  const key = (k: string, init: Record<string, unknown> = {}) =>
    act(async () => void search.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...init }) as any));
  // Enter opens the first match, unless nothing matches, another key, IME composition or an arrow-highlighted row
  await key('Enter');
  await type('wiki');
  await key('a');
  await key('Enter', { isComposing: true });
  // the arrows chose a row of this menu (the list names it): Enter is that row's
  const menuList = search.closest('[role=menu]')!;
  menuList.setAttribute('aria-activedescendant', 'row');
  await key('Enter');
  menuList.removeAttribute('aria-activedescendant');
  assert.deepEqual(opened, ['https://wiki.test/']);
  // another menu's highlighted row is not this one's
  const other = document.createElement('div');
  other.className = 'menu';
  other.innerHTML = '<div class="kbd-active"></div>';
  document.body.append(other);
  await key('Enter');
  other.remove();
  assert.deepEqual(opened, ['https://wiki.test/', 'https://wiki.test/']);
  assert.equal(button().getAttribute('aria-expanded'), 'false', 'opening a match closes the menu');
  await click(button());
  await wait(10);
  // a row's remove button removes that bookmark without opening it
  f.handlers.removeBookmark = async () => {
    throw new Error('gone');
  };
  // the remove action sits beside its row, not inside the row's button
  const remove = container.querySelector('button[aria-label="Remove Docs"]')!;
  assert.equal(remove.getAttribute('role'), 'menuitem');
  assert.equal(remove.parentElement!.closest('button'), null);
  assert.ok(remove.parentElement!.querySelector('[role=menuitem]:not(.browser-bookmark-remove)')!.textContent!.includes('Docs'));
  await click(remove);
  await wait(10);
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'removeBookmark'),
    [['removeBookmark', '1']],
  );
  assert.deepEqual(opened, ['https://wiki.test/', 'https://wiki.test/']);
  const search2 = container.querySelector('input[aria-label="Search bookmarks"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search2, 'nothing like it');
    search2.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
  await click([...container.querySelectorAll('[role=menuitem]:not(.browser-bookmark-remove)')].at(-1)!);
  assert.deepEqual(events, ['null']);
  window.removeEventListener('open-browser-import', onImport);
  // reopening clears the search; a change made elsewhere refreshes the open menu
  await click(button());
  await wait(10);
  assert.equal((container.querySelector('input[aria-label="Search bookmarks"]') as HTMLInputElement).value, '');
  list = [items[0]];
  await act(async () => f.bookmarkListeners.forEach((cb: () => void) => cb()));
  await wait(10);
  assert.deepEqual(labels(), ['Docs', 'Import from another browser…']);
  await click([...container.querySelectorAll('[role=menuitem]:not(.browser-bookmark-remove)')][0]);
  // no bookmarks and the import off: only the hint, no search box
  f.flags['shared.browser.import'] = false;
  list = [];
  await click(button());
  await wait(10);
  assert.match(container.querySelector('.menu-empty')!.textContent!, /No bookmarks yet/);
  assert.equal(container.querySelector('input[aria-label="Search bookmarks"]'), null);
  assert.equal(container.querySelectorAll('[role=menuitem]:not(.browser-bookmark-remove)').length, 0);
  f.handlers.bookmarks = async () => {
    throw new Error('busy');
  };
  await act(async () => f.bookmarkListeners.forEach((cb: () => void) => cb()));
  await wait(10);
});

test('BookmarksMenu: past the search limit it says how many more match', async () => {
  const many = Array.from({ length: SEARCH_LIMIT + 3 }, (_, i) => ({
    id: String(i),
    title: `Page ${i}`,
    url: `https://p${i}.test/`,
    folderPath: [],
    addedAt: i,
    source: 'local',
  }));
  f.handlers.bookmarks = async () => many;
  await render(createElement(BookmarksMenu, { onOpen: () => {} }));
  await click(container.querySelector('button[aria-label=Bookmarks]')!);
  await wait(10);
  const search = container.querySelector('input[aria-label="Search bookmarks"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'page');
    search.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
  assert.equal(container.querySelectorAll('[role=menuitem]:not(.browser-bookmark-remove)').length, SEARCH_LIMIT + 1);
  assert.match(container.querySelector('.menu-empty')!.textContent!, /^3 more match/);
});
