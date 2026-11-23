// The Files pane of a chat on a machine (src/components/panels/files/RemoteFiles.tsx, #4104): the folder's tree read through the Host as folders open, the open file's text read-only, long and binary files said so, refusals in words.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import { fakeStore, render, one } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';
stubStore(fakeStore({ threads: { t1: { cwd: '/srv/app' }, root: { cwd: '/' }, bare: {} } }).exports);
// the diff pane's file glyph pulls in the whole Markdown stack: a stand-in glyph is enough here
mock.module('../src/components/panels/DiffPanel.tsx', { namedExports: { LangIcon: () => h('i', { className: 'lang' }) } });
const { RemoteFilePreview, RemoteFilesPanel } = await import('../src/components/panels/files/RemoteFiles.tsx');

const BOX = { id: 'ssh:me@box', name: 'box', away: false };
const entries = (...names: string[]) => names.map((n) => ({ name: n.replace(/\/$/, ''), isDirectory: n.endsWith('/') }));
let trees: Record<string, any>;
let files: Record<string, any>;
let fake: ReturnType<typeof fakeNative>;
beforeEach(() => {
  trees = {
    '/srv/app': { value: { path: '/srv/app', entries: entries('src/', 'empty/', 'README.md', 'logo.png'), truncated: false } },
    '/srv/app/src': { value: { path: '/srv/app/src', entries: entries('a.ts'), truncated: true } },
    '/srv/app/empty': { value: { path: '/srv/app/empty', entries: [], truncated: false } },
    '/': { value: { path: '/', entries: entries('etc/'), truncated: false } },
  };
  files = {
    '/srv/app/README.md': { value: { kind: 'text', text: '# app\n', size: 6, truncated: false } },
    '/srv/app/src/a.ts': { value: { kind: 'text', text: 'export {};', size: 3_000_000, truncated: true } },
    '/srv/app/logo.png': { value: { kind: 'binary', size: 2048 } },
  };
  fake = fakeNative({
    host: {
      fsTree: async (_id: string, q: { path: string }) => trees[q.path] ?? { error: { message: 'x', code: 'directory_missing' } },
      fsRead: async (_id: string, q: { path: string }) => files[q.path] ?? { error: { message: 'x', code: 'not_a_file' } },
    },
  });
  installNative(fake);
});
/** An action, then a turn of the event loop for the reads it started to answer. */
const settle = (fn?: () => void) =>
  act(async () => {
    fn?.();
    await new Promise((r) => setTimeout(r, 0));
  });
const names = (host: HTMLElement) => [...host.querySelectorAll('.files-tree .file-node-name')].map((n) => n.textContent);
const click = (host: HTMLElement, text: string) =>
  settle(() =>
    [...host.querySelectorAll('.file-node')].find((n) => n.textContent === text)!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );

test('the folder lists folders first and opens one on a click, with an empty folder and a cut listing said so', async () => {
  const v = await render(h(RemoteFilesPanel, { machine: BOX, threadId: 't1' }));
  await settle();
  assert.deepEqual(names(v.host), ['src', 'empty', 'README.md', 'logo.png']);
  assert.equal(one(v.host, '.files-tree-title').textContent, 'app');
  assert.deepEqual(fake.callsTo('host.fsTree'), [[BOX.id, { path: '/srv/app' }]], 'only the folder shown is read');
  await click(v.host, 'src');
  await settle();
  assert.deepEqual(names(v.host), ['src', 'a.ts', 'empty', 'README.md', 'logo.png']);
  assert.match(v.host.textContent!, /More files are not listed\./);
  await click(v.host, 'empty');
  await settle();
  assert.match(v.host.textContent!, /Empty folder/);
  // closing a folder hides its entries
  await click(v.host, 'src');
  assert.equal(names(v.host).includes('a.ts'), false);
  await v.unmount();
});

test('a file opens beside the tree as read-only text; a long one says it is the start; a binary one says its size; Read again reads both again', async () => {
  const v = await render(h(RemoteFilesPanel, { machine: BOX, threadId: 't1' }));
  await settle();
  assert.match(v.host.textContent!, /Pick a file to read it here\./);
  await click(v.host, 'README.md');
  await settle();
  assert.equal(one(v.host, '.remote-file-text').textContent, '# app\n');
  assert.equal(v.host.querySelector('.remote-file-note'), null);
  await click(v.host, 'src');
  await settle();
  await click(v.host, 'a.ts');
  await settle();
  assert.match(one(v.host, '.remote-file-note').textContent!, /Showing the start of the file \(2\.9 MB\)\./);
  await click(v.host, 'logo.png');
  await settle();
  assert.match(v.host.textContent!, /Binary file, 2 KB\./);
  const reads = fake.callsTo('host.fsRead').length;
  const lists = fake.callsTo('host.fsTree').length;
  await settle(() => (one(v.host, '[aria-label="Read again"]') as HTMLElement).click());
  assert.equal(fake.callsTo('host.fsRead').length, reads + 1);
  assert.equal(fake.callsTo('host.fsTree').length, lists + 2, 'the folders shown are read again');
  await v.unmount();
});

test('a folder or a file the machine refuses says why, and a very small file is in bytes', async () => {
  trees['/srv/app/src'] = { error: { message: 'x', code: 'outside_roots' } };
  files['/srv/app/README.md'] = { value: { kind: 'text', text: 'x', size: 1, truncated: false } };
  const v = await render(h(RemoteFilesPanel, { machine: BOX, threadId: 't1' }));
  await settle();
  await click(v.host, 'src');
  await settle();
  assert.match(v.host.textContent!, /That folder is outside what this machine shares\./);
  const gone = await render(h(RemoteFilePreview, { machineId: BOX.id, path: '/srv/app/missing.txt' }));
  await settle();
  assert.equal(one(gone.host, '.machine-folder-note').textContent, 'That is not a file.');
  assert.equal(one(gone.host, '.remote-file-head').textContent, 'missing.txt/srv/app');
  await gone.unmount();
  files['/srv/app/tiny.bin'] = { value: { kind: 'binary', size: 5 } };
  const tiny = await render(h(RemoteFilePreview, { machineId: BOX.id, path: '/srv/app/tiny.bin' }));
  await settle();
  assert.match(tiny.host.textContent!, /Binary file, 5 B\./);
  await tiny.unmount();
  files['/srv/app/huge.bin'] = { value: { kind: 'binary', size: 5 * 1024 * 1024 } };
  const huge = await render(h(RemoteFilePreview, { machineId: BOX.id, path: '/srv/app/huge.bin' }));
  await settle();
  assert.match(huge.host.textContent!, /Binary file, 5\.0 MB\./);
  await huge.unmount();
  await v.unmount();
});

test('a link’s line is marked and scrolled to, a range marks its lines, and a line past the end marks nothing', async () => {
  const scrolled: string[] = [];
  (window as any).HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.textContent);
  };
  files['/srv/app/lines.txt'] = { value: { kind: 'text', text: 'one\ntwo\nthree\nfour', size: 18, truncated: false } };
  const hit = async (props: object) => {
    const v = await render(h(RemoteFilePreview, { machineId: BOX.id, path: '/srv/app/lines.txt', ...props }));
    await settle();
    const marked = v.host.querySelector('.remote-file-hit')?.textContent ?? null;
    const whole = one(v.host, '.remote-file-text').textContent;
    await v.unmount();
    return [marked, whole];
  };
  // the marked line is a block of its own; the lines before and after it stay as they were
  assert.deepEqual(await hit({ line: 2 }), ['two', 'onetwothree\nfour']);
  assert.deepEqual(await hit({ line: 1 }), ['one', 'onetwo\nthree\nfour']);
  assert.equal((await hit({ line: 2, endLine: 3 }))[0], 'two\nthree');
  assert.equal((await hit({ line: 4, endLine: 99 }))[0], 'four');
  assert.equal((await hit({ line: 9 }))[0], null);
  assert.equal((await hit({}))[0], null);
  assert.deepEqual(scrolled.slice(0, 2), ['two', 'one']);
});

test('a chat whose folder is the machine’s root shows the folder itself, and a chat with no folder or no id reads none', async () => {
  const root = await render(h(RemoteFilesPanel, { machine: BOX, threadId: 'root' }));
  await settle();
  assert.equal(one(root.host, '.files-tree-title').textContent, '/');
  assert.deepEqual(names(root.host), ['etc']);
  await root.unmount();
  for (const threadId of ['bare', null, 'missing']) {
    const v = await render(h(RemoteFilesPanel, { machine: BOX, threadId }));
    await settle();
    assert.equal(one(v.host, '.files-tree-title').textContent, '', String(threadId));
    await v.unmount();
  }
});
