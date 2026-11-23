// Issue 1367 in a window: a chat archived or restored elsewhere (another window, or main archiving inactive chats with
// no window open) leaves or rejoins this window's sidebar and Archived chats; Settings offers Never or a number of days.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { act, createElement as h } from 'react';
import { fakeStore, iconStubs, mockSource, popoverStubs, stubStore } from './support/stubs.ts';
import { installFakeRuntime } from './support/ports/runtime.ts';

const store = fakeStore<any>({});
const remembered: any[] = [];
const prefs: any[] = [];
const retired: any[] = [];
// This unit observes the ordered archive-to-view boundary; actual split closure is covered by split-view store tests.
mockSource('src/session/harness/claude/threads.ts', { rememberClaudeThread: (t: any) => remembered.push(t) });
const reloads: string[] = [];
let reloadFails = false;
const reload = (family: string) => async () => {
  reloads.push(family);
  if (reloadFails) throw new Error('offline');
};
mockSource('src/harness/family.ts', {
  nativeFamily: (id: string) => (id.startsWith('claude:') ? 'claude' : id.startsWith('acp:') ? 'acp' : 'codex'),
});
mockSource('src/session/harness/claude.ts', { loadClaudeThreads: reload('claude') });
mockSource('src/session/harness/acp.ts', { loadAcpThreads: reload('acp') });
// the store's reads of each harness go through the runtime main installs
installFakeRuntime({
  rememberClaudeThread: (t: any) => void remembered.push(t),
  loadClaudeThreads: reload('claude'),
  loadAcpThreads: reload('acp'),
});
stubStore(
  {
    useStore: store.useStore,
    setPrefs: (p: any) => (prefs.push(p), store.set((s: any) => ({ prefs: { ...s.prefs, ...p } }))),
  },
  {
    'src/store/splitView.ts': {
      retireChatFromView: (id: string) =>
        retired.push({
          id,
          listed: !!store.get().threads[id],
          order: [...store.get().threadOrder],
          archived: store.get().archived.map((thread: any) => thread.id),
        }),
    },
    'src/store/core.ts': {
      get: store.get,
      set: store.set,
      upsertThread: (t: any) =>
        store.set((s: any) => ({
          threads: { ...s.threads, [t.id]: t },
          threadOrder: [t.id, ...s.threadOrder.filter((x: string) => x !== t.id)],
        })),
    },
    'src/store/connection.ts': { loadThreads: reload('codex') },
  },
);
mockSource('src/components/ui/Popover.tsx', popoverStubs());
mockSource('src/components/ui/icons.tsx', iconStubs());
const { followArchive } = await import('../src/store/remoteArchive.ts');
const { AutoArchiveRow } = await import('../src/components/pages/settings/AutoArchiveRow.tsx');
const { createRoot } = await import('react-dom/client');

const chat = (archived: number | null) => ({ segments: null, kind: 'codex', meta: { archived } }) as any;
const thread = (id: string) => ({ id, name: id, updatedAt: 1 });
const reset = () => {
  remembered.length = 0;
  retired.length = 0;
  store.reset({
    threads: { a: thread('a'), b: thread('b') },
    threadOrder: ['a', 'b'],
    archived: [thread('z')],
    claudeArchived: { z: 5 },
    prefs: { autoArchiveDays: null },
  });
};

test('a chat archived elsewhere leaves the sidebar and joins Archived chats', () => {
  reset();
  followArchive('a', chat(10));
  assert.deepEqual(Object.keys(store.get().threads), ['b']);
  assert.deepEqual(store.get().threadOrder, ['b']);
  assert.deepEqual(
    store.get().archived.map((t: any) => t.id),
    ['a', 'z'],
  );
  assert.deepEqual(
    remembered.map((t) => t.id),
    ['a'],
  );
  assert.deepEqual(retired, [{ id: 'a', listed: false, order: ['b'], archived: ['a', 'z'] }]);
});

test('a chat this window never listed is archived without inventing a row', () => {
  reset();
  followArchive('unknown', chat(10));
  assert.deepEqual(
    store.get().archived.map((t: any) => t.id),
    ['z'],
  );
  assert.deepEqual(store.get().threadOrder, ['a', 'b']);
  assert.deepEqual(
    retired.map((call) => call.id),
    ['unknown'],
  );
});

test('a chat restored elsewhere rejoins the sidebar; an unknown or deleted one changes nothing', () => {
  reset();
  followArchive('z', chat(null));
  assert.deepEqual(store.get().archived, []);
  assert.deepEqual(store.get().threadOrder, ['z', 'a', 'b']);
  reset();
  store.set({ claudeArchived: { z: 5, gone: 6 } });
  followArchive('gone', chat(null));
  followArchive('z', null);
  assert.deepEqual(
    store.get().archived.map((t: any) => t.id),
    ['z'],
  );
  assert.deepEqual(store.get().threadOrder, ['a', 'b']);
  assert.deepEqual(retired, [], 'restores and deletion receipts do not reapply an archive effect');
});

test('a chat restored elsewhere that this window had no row for comes back with its harness list', async () => {
  reset();
  reloads.length = 0;
  store.set({ claudeArchived: { cx: 1, 'claude:s': 2, 'acp:x:1': 3 } });
  for (const id of ['cx', 'claude:s', 'acp:x:1']) followArchive(id, chat(null));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(reloads, ['codex', 'claude', 'acp']);
  reloadFails = true;
  store.set({ claudeArchived: { cx: 1 } });
  followArchive('cx', chat(null));
  await new Promise((r) => setImmediate(r));
  reloadFails = false;
  assert.deepEqual(reloads.at(-1), 'codex');
});

test('changes this window made itself, or that change nothing about the archive, are left alone', () => {
  reset();
  const before = store.get();
  followArchive('z', chat(7));
  followArchive('a', chat(null));
  assert.equal(store.get(), before);
});

let root: any = null;
let el: HTMLElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  el?.remove();
});

test('Settings shows Never by default and saves the chosen number of days, or Never', async () => {
  reset();
  prefs.length = 0;
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(h(AutoArchiveRow)));
  assert.match(el.textContent!, /Automatically archive inactive chats/);
  const button = () => el.querySelector('button.select-btn') as HTMLButtonElement;
  assert.equal(button().textContent, 'Never');
  const pick = async (label: string) => {
    await act(async () => button().dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any));
    const item = [...el.querySelectorAll('button')].find((b) => b.textContent === label)!;
    await act(async () => item.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any));
  };
  await pick('14 days');
  assert.deepEqual(prefs, [{ autoArchiveDays: 14 }]);
  assert.equal(button().textContent, '14 days');
  await pick('Never');
  assert.deepEqual(prefs.at(-1), { autoArchiveDays: null });
  // a value Settings doesn't offer reads as Never
  await act(async () => store.set({ prefs: { autoArchiveDays: 5 } }));
  assert.equal(button().textContent, 'Never');
});
