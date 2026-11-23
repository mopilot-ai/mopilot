// The mopilot://chat/new link (the macOS Quick Actions'): its parser (shared/deepLink.mjs), the inbox that holds links
// until the app can open them, what main does with one (electron/platform/quickActionLinks.cjs) and the window's new chat (src/session/newChatLink.ts).
import { APP_SCHEME } from '../shared/deepLink.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LINK_FILES_MAX, LINK_TEXT_MAX, parseNewChatLink } from '../shared/deepLink.mjs';
import { asNewChatLink, openNewChatLink, type NewChatLinkDeps } from '../src/session/newChatLink.ts';

const require = createRequire(import.meta.url);
const { createLinkInbox, listenForLinks, MAX_WAITING, inbox } = require('../electron/platform/openLinks.cjs');
const { newChatFor, createLinkOpener } = require('../electron/platform/quickActionLinks.cjs');

const link = (qs: string) => `${APP_SCHEME}://chat/new?${qs}`;

test('a link carries text, a folder and files', () => {
  assert.deepEqual(parseNewChatLink(link('q=hello%20world&source=services')), { text: 'hello world', folder: null, files: [] });
  assert.deepEqual(parseNewChatLink(link('folder=%2FUsers%2Fme%2Fproj')), { text: '', folder: '/Users/me/proj', files: [] });
  assert.deepEqual(parseNewChatLink(link('file=%2Fa%20b.txt&file=%2Fc.md')), { text: '', folder: null, files: ['/a b.txt', '/c.md'] });
});

test('anything else is no link: other schemes, hosts, paths, relative paths, empty requests', () => {
  for (const url of [
    'https://chat/new?q=x',
    'mopilot://other/new?q=x',
    `${APP_SCHEME}://chat/old?q=x`,
    `${APP_SCHEME}://chat/new`,
    `${APP_SCHEME}://chat/new?q=%20%20`,
    link('folder=relative'),
    link('file=..%2Fx'),
    link('file=%2Fa%00b'),
    link('file=%2Fa%0Ab'),
    'not a url',
    undefined,
  ]) {
    assert.equal(parseNewChatLink(url), null, String(url));
  }
});

test('text and files are capped', () => {
  const long = parseNewChatLink(link(`q=${'a'.repeat(LINK_TEXT_MAX + 50)}`));
  assert.equal(long?.text.length, LINK_TEXT_MAX);
  const many = parseNewChatLink(link(Array.from({ length: LINK_FILES_MAX + 5 }, (_, i) => `file=%2Ff${i}`).join('&')));
  assert.equal(many?.files.length, LINK_FILES_MAX);
});

test('the inbox keeps links until a handler is set, newest last and bounded, then passes each on', async () => {
  const errors: unknown[] = [];
  const box = createLinkInbox((e: unknown) => errors.push(e));
  for (let i = 0; i < MAX_WAITING + 2; i++) box.push(`u${i}`);
  const seen: string[] = [];
  box.setHandler((u: string) => seen.push(u));
  assert.equal(seen.length, MAX_WAITING);
  assert.equal(seen[0], 'u2');
  box.push('late');
  assert.equal(seen.at(-1), 'late');
  // a later handler replaces the first; nothing is replayed
  const second: string[] = [];
  box.setHandler((u: string) => second.push(u));
  box.push('x');
  assert.deepEqual(second, ['x']);
  // a handler that throws or rejects is reported, and the next link still arrives
  box.setHandler(() => {
    throw new Error('sync');
  });
  box.push('y');
  box.setHandler(async () => {
    throw new Error('async');
  });
  box.push('z');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    errors.map((e) => (e as Error).message),
    ['sync', 'async'],
  );
});

test('every open-url event goes to the inbox and is claimed', () => {
  const listeners: Record<string, (...a: any[]) => void> = {};
  listenForLinks({ on: (name: string, fn: (...a: any[]) => void) => (listeners[name] = fn) });
  let prevented = false;
  const seen: string[] = [];
  inbox.setHandler((u: string) => seen.push(u));
  listeners['open-url']({ preventDefault: () => (prevented = true) }, link('q=hi'));
  assert.equal(prevented, true);
  assert.deepEqual(seen, [link('q=hi')]);
  inbox.setHandler(() => {});
});

const kinds: Record<string, 'dir' | 'file'> = { '/proj': 'dir', '/proj/a.txt': 'file', '/b.md': 'file', '/other': 'dir' };
const kind = async (p: string) => kinds[p] ?? null;

test('a text link drafts the text; a folder link starts there; files are drafted as paths', async () => {
  assert.deepEqual(await newChatFor(link('q=fix%20it'), kind), { folder: null, text: 'fix it' });
  assert.deepEqual(await newChatFor(link('folder=%2Fproj'), kind), { folder: '/proj', text: '' });
  assert.deepEqual(await newChatFor(link('file=%2Fproj%2Fa.txt&file=%2Fb.md'), kind), { folder: null, text: '/proj/a.txt\n/b.md' });
  assert.deepEqual(await newChatFor(link('q=look&file=%2Fb.md'), kind), { folder: null, text: 'look\n/b.md' });
});

test('one folder sent alone starts the chat there; a folder among others stays a path; missing paths are dropped', async () => {
  assert.deepEqual(await newChatFor(link('file=%2Fother'), kind), { folder: '/other', text: '' });
  assert.deepEqual(await newChatFor(link('file=%2Fother&file=%2Fb.md'), kind), { folder: null, text: '/other\n/b.md' });
  assert.deepEqual(await newChatFor(link('folder=%2Fgone&q=hi'), kind), { folder: null, text: 'hi' });
  assert.deepEqual(await newChatFor(link('folder=%2Fb.md&q=hi'), kind), { folder: null, text: 'hi' });
  assert.equal(await newChatFor(link('file=%2Fgone'), kind), null);
  assert.equal(await newChatFor('https://example.com', kind), null);
});

test('the real file check tells folders, files and nothing', async () => {
  const { tmpdir } = await import('node:os');
  const dir = tmpdir();
  const url = link(`folder=${encodeURIComponent(dir)}&file=${encodeURIComponent('/definitely/not/here')}`);
  assert.deepEqual(await newChatFor(url), { folder: dir, text: '' });
  const file = link(`file=${encodeURIComponent(import.meta.filename)}`);
  assert.deepEqual(await newChatFor(file), { folder: null, text: import.meta.filename });
});

test('opening a link brings the window forward on the new chat command, and ignores what is no link', async () => {
  const log: unknown[][] = [];
  const win = (minimized: boolean) => ({
    webContents: { send: (...a: unknown[]) => log.push(['send', ...a]) },
    isMinimized: () => minimized,
    restore: () => log.push(['restore']),
    show: () => log.push(['show']),
    focus: () => log.push(['focus']),
  });
  let minimized = true;
  let on = false;
  const open = createLinkOpener({ readyMainWindow: async () => win(minimized), enabled: () => on, kind });
  // without the user's Quick Actions switch a link is ignored, however well formed
  assert.equal(await open(link('q=hi')), false);
  assert.deepEqual(log, []);
  on = true;
  assert.equal(await open('https://example.com'), false);
  assert.deepEqual(log, []);
  assert.equal(await open(link('q=hi')), true);
  assert.deepEqual(log, [['send', 'app:command', 'new-chat-link', { folder: null, text: 'hi' }], ['restore'], ['show'], ['focus']]);
  log.length = 0;
  minimized = false;
  await open(link('q=again'));
  assert.deepEqual(
    log.map((l) => l[0]),
    ['send', 'show', 'focus'],
  );
});

const fakeWindow = (staleAfterProject = false) => {
  const log: unknown[][] = [];
  let stale = false;
  const deps: NewChatLinkDeps = {
    createProject: async (p) => (log.push(['createProject', p]), (stale = staleAfterProject), p === '/nope' ? null : 'p1'),
    clearProject: () => log.push(['clearProject']),
    setProject: (id) => log.push(['setProject', id]),
    home: (cwd) => log.push(['home', cwd]),
    draft: (t) => log.push(['draft', t]),
    stale: () => stale,
  };
  return { log, deps };
};

test('the window reads only well-formed commands', () => {
  assert.equal(asNewChatLink(null), null);
  assert.equal(asNewChatLink('x'), null);
  assert.equal(asNewChatLink({ folder: 3, text: 4 }), null);
  assert.equal(asNewChatLink({ folder: '', text: '  ' }), null);
  assert.deepEqual(asNewChatLink({ folder: '/p', text: 7 }), { folder: '/p', text: '' });
  assert.deepEqual(asNewChatLink({ text: 'hi' }), { folder: null, text: 'hi' });
});

test('a text link opens an outside-project new chat with the draft', async () => {
  const { log, deps } = fakeWindow();
  await openNewChatLink({ folder: null, text: 'hi' }, deps);
  assert.deepEqual(log, [['clearProject'], ['home', undefined], ['draft', 'hi']]);
});

test('a folder link makes the project, opens its new chat and drafts the text when there is some', async () => {
  const { log, deps } = fakeWindow();
  await openNewChatLink({ folder: '/proj', text: '' }, deps);
  assert.deepEqual(log, [
    ['createProject', '/proj'],
    ['setProject', 'p1'],
    ['home', '/proj'],
  ]);
  const second = fakeWindow();
  await openNewChatLink({ folder: '/proj', text: 'x' }, second.deps);
  assert.deepEqual(second.log.at(-1), ['draft', 'x']);
});

test('a folder that can not become a project still opens a chat there; a view left meanwhile is left alone; no link does nothing', async () => {
  const { log, deps } = fakeWindow();
  await openNewChatLink({ folder: '/nope', text: '' }, deps);
  assert.deepEqual(log, [['createProject', '/nope'], ['clearProject'], ['home', '/nope']]);
  const left = fakeWindow(true);
  await openNewChatLink({ folder: '/proj', text: 'x' }, left.deps);
  assert.deepEqual(left.log, [['createProject', '/proj']]);
  const none = fakeWindow();
  await openNewChatLink('garbage', none.deps);
  assert.deepEqual(none.log, []);
});
