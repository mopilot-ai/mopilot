// The sidebar row menu of a chat on a machine has the same items as one of this Mac (M47, M51): Open in says the folder is on the machine instead of opening this Mac's Finder, and the PR read goes by the machine's folder key.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { $$ as all, click, mount, fakeStore } from './support/composer-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
import type { Thread } from '../src/store/types.ts';
import { machineFolderKey } from '../src/lib/machineFolder.ts';

type Chats = { owners: Map<string, string>; status: 'unknown' | 'ready' | 'failed'; answered: boolean };
const THIS_MAC: Chats = { owners: new Map(), status: 'ready', answered: true };
const MACHINE_CHAT = 'acp:host-claude:7a1c0e52-3f0b-4f43-9d54-0d1f7f0e9a11';
const STUDIO = { id: 'ssh:me@studio', name: 'Studio', status: 'online' };
const ON_STUDIO: Chats = { owners: new Map([[MACHINE_CHAT, STUDIO.id]]), status: 'ready', answered: true };
let chats: Chats = THIS_MAC;
let machines: { id: string; name: string; status: string }[] = [];
const PR = { url: 'https://github.com/o/r/pull/3' };
let reading: () => Promise<unknown> = async () => PR;
// what the row's own read (by the chat's links, no folder) already settled
let knownByLinks: unknown;
mockSource('src/store/hostAgent.ts', {
  hostAgentOf: (id: string) => (id.startsWith('acp:host-codex:') ? 'codex' : id.startsWith('acp:host-claude:') ? 'claude' : 'kimi'),
});
mockSource('src/lib/hostChats.ts', {
  useHostChats: () => chats,
  machineOfChat: (c: Chats, id: string | null) => (!id ? '' : c.status === 'unknown' || !c.answered ? null : (c.owners.get(id) ?? '')),
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines, resolved: true }) });

const store = fakeStore<any>({ pinned: {}, unread: {}, runtime: {}, prefs: { openDestination: 'finder' } });
const calls: any[][] = [];
const record =
  (name: string) =>
  async (...args: any[]) =>
    void calls.push([name, ...args]);
stubStore({
  openPaneTab: record('pane'),
  useStore: store.useStore,
  setState: store.setState,
  nativeOf: (id: string) => id,
  archiveThread: record('archive'),
  forkThread: record('fork'),
  openInSplit: record('split'),
  toastFailure: () => () => undefined,
  toast: record('toast'),
});
installNativeStub({
  app: { installed: async () => ({ finder: true, cursor: true }), icon: async () => null },
  shell: { openPath: record('finder'), openIn: record('editor'), openExternal: record('link') },
  win: { open: record('window') },
});
mock.module('../src/session/pullRequestReader.ts', {
  namedExports: {
    readPullRequest: Object.assign((...args: unknown[]) => (calls.push(['read', ...args]), reading()), {
      known: (_id: string, folder: string) => (folder === '' ? knownByLinks : undefined),
    }),
  },
});
const { ThreadMenu } = await import('../src/components/sidebar/ThreadMenu.tsx');

const chat = (id: string, cwd: string) => ({ id, cwd, updatedAt: 1 }) as Thread;
const open = (thread: Thread) =>
  mount(h(ThreadMenu, { thread, open: true, pinned: false, anchor: { x: 1, y: 1 }, onClose: () => undefined, onRename: () => undefined }));
const menuEl = () => document.querySelector('[role="menu"]') as HTMLElement;
const labels = () => [...menuEl().querySelectorAll('.menu-label')].map((el) => el.textContent);
const item = (title: string) => all('.menu-item').find((el) => el.querySelector('.menu-label')?.textContent === title)!;
const readFolder = () => calls.find(([name]) => name === 'read')![2];

beforeEach(() => {
  reading = async () => PR;
  knownByLinks = undefined;
  chats = THIS_MAC;
  machines = [];
  calls.length = 0;
});

test('a chat on a machine has the same row menu as a chat of this Mac', async () => {
  const local = await open(chat('claude-local', '/work/app'));
  const expected = labels();
  await local.unmount();
  chats = ON_STUDIO;
  machines = [STUDIO];
  const remote = await open(chat(MACHINE_CHAT, '/srv/app'));
  assert.deepEqual(labels(), expected);
  await remote.unmount();
});

test('Open in on a machine chat keeps split and window, and greys one folder item naming the machine; nothing reaches this Mac', async () => {
  chats = ON_STUDIO;
  machines = [STUDIO];
  const view = await open(chat(MACHINE_CHAT, '/srv/app'));
  await click(item('Open in'));
  const folder = item('Open folder');
  assert.equal(folder.getAttribute('aria-disabled'), 'true');
  assert.equal(folder.querySelector('.menu-hint')?.textContent, 'On Studio');
  assert.equal(folder.getAttribute('title'), 'This folder is on Studio, not on this Mac');
  assert.equal(item('Finder'), undefined);
  assert.equal(item('Cursor'), undefined);
  await click(folder);
  await click(item('Split view'));
  assert.deepEqual(
    calls.filter(([name]) => name === 'finder' || name === 'editor'),
    [],
  );
  assert.ok(calls.some(([name]) => name === 'split'));
  await view.unmount();
});

test('the PR read of a machine chat goes by the machine folder key, so the reader asks that Host for the branch', async () => {
  chats = ON_STUDIO;
  machines = [STUDIO];
  const view = await open(chat(MACHINE_CHAT, '/srv/app'));
  assert.ok(item('Open PR'));
  assert.equal(readFolder(), machineFolderKey(STUDIO.id, '/srv/app'));
  await view.unmount();
});

test('an offline machine, or a chat whose machine is not known yet, reads by its own links only: no folder is given', async () => {
  chats = ON_STUDIO;
  machines = [{ ...STUDIO, status: 'offline' }];
  const offline = await open(chat(MACHINE_CHAT, '/srv/app'));
  assert.equal(readFolder(), '');
  await offline.unmount();
  calls.length = 0;
  chats = { owners: new Map(), status: 'unknown', answered: true };
  const unknown = await open(chat(MACHINE_CHAT, '/srv/app'));
  assert.equal(readFolder(), '');
  await unknown.unmount();
});

test('a chat of this Mac still reads and opens by its own folder', async () => {
  const view = await open(chat('claude-local', '/work/app'));
  assert.equal(readFolder(), '/work/app');
  await click(item('Open in'));
  await click(item('Finder'));
  assert.deepEqual(
    calls.find(([name]) => name === 'finder'),
    ['finder', '/work/app'],
  );
  assert.equal(item('Open folder'), undefined);
  await view.unmount();
});

test("until the menu's own read answers, the PR the row's badge already read by the chat's links shows in a machine chat's menu", async () => {
  chats = ON_STUDIO;
  machines = [STUDIO];
  reading = () => new Promise(() => undefined);
  knownByLinks = PR;
  const view = await open(chat(MACHINE_CHAT, '/srv/app'));
  assert.ok(item('Open PR'));
  await view.unmount();
  knownByLinks = undefined;
  const none = await open(chat(MACHINE_CHAT, '/srv/app'));
  assert.equal(item('Open PR'), undefined);
  await none.unmount();
});

test('Delete on a machine chat asks what it does there and what the machine’s agent keeps; a chat of this Mac asks as before', async () => {
  const asked: string[] = [];
  Object.defineProperty(globalThis, 'confirm', {
    configurable: true,
    value: (message: string) => (asked.push(message), false),
  });
  const CODEX_CHAT = 'acp:host-codex:7a1c0e52-3f0b-4f43-9d54-0d1f7f0e9a22';
  const BASIC_CHAT = 'acp:kimi:7a1c0e52-3f0b-4f43-9d54-0d1f7f0e9a33';
  machines = [STUDIO];
  for (const id of ['claude-local', MACHINE_CHAT, CODEX_CHAT, BASIC_CHAT]) {
    chats = id === 'claude-local' ? THIS_MAC : { owners: new Map([[id, STUDIO.id]]), status: 'ready', answered: true };
    const view = await open(chat(id, '/srv/app'));
    await click(item('Delete'));
    await view.unmount();
  }
  // the machines are not read yet, and the machine's row is gone: still a delete that goes to a machine
  machines = [];
  for (const state of [{ owners: new Map(), status: 'unknown' as const, answered: true }, ON_STUDIO]) {
    chats = state;
    const view = await open(chat(MACHINE_CHAT, '/srv/app'));
    await click(item('Delete'));
    await view.unmount();
  }
  assert.deepEqual(asked, [
    'Permanently delete this chat? This cannot be undone.',
    'Permanently delete this chat here and on Studio? This cannot be undone.',
    'Permanently delete this chat here and on Studio? This cannot be undone. Codex may keep a copy.',
    'Permanently delete this chat here and on Studio? This cannot be undone. The agent keeps its own history.',
    'Permanently delete this chat here and on its machine? This cannot be undone.',
    'Permanently delete this chat here and on its machine? This cannot be undone.',
  ]);
});
