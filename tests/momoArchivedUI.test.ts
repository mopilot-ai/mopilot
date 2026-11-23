// Settings → Archived chats never shows MoMo's chats (#2139), however they reach the window's archive: main archiving
// a previous MoMo chat (followArchive, every open window), a harness listing its archive, or a later native session of a
// MoMo chat that a harness lists under its own id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeStore, iconStubs, mockSource, popoverStubs, stubStore } from './support/stubs.ts';
import { installFakeRuntime } from './support/ports/runtime.ts';

const store = fakeStore<any>({});
const retired: string[] = [];
// The actual split layout is outside this settings list unit; keep its ordered retirement call observable.
mockSource('src/session/harness/claude/threads.ts', { rememberClaudeThread: () => undefined });
mockSource('src/harness/family.ts', { nativeFamily: () => 'codex' });
mockSource('src/session/harness/claude.ts', { loadClaudeThreads: async () => undefined });
mockSource('src/session/harness/acp.ts', { loadAcpThreads: async () => undefined });
// the store's reads of each harness go through the runtime main installs
installFakeRuntime({
  rememberClaudeThread: () => undefined,
  loadClaudeThreads: async () => undefined,
  loadAcpThreads: async () => undefined,
});
stubStore(
  {
    useStore: store.useStore,
    loadArchived: async () => [],
    unarchiveThread: async () => undefined,
    deleteThread: async () => undefined,
    threadTitle: (t: any) => t.name,
    toast: () => undefined,
    projectForThread: () => null,
  },
  {
    'src/store/splitView.ts': {
      retireChatFromView: (id: string) => {
        assert.equal(store.get().threads[id], undefined, 'the sidebar row retires before its view');
        assert.ok(store.get().archived.some((thread: any) => thread.id === id));
        retired.push(id);
      },
    },
    'src/store/core.ts': { get: store.get, set: store.set, upsertThread: () => undefined },
    'src/store/connection.ts': { loadThreads: async () => undefined },
  },
);
mockSource('src/components/ui/Popover.tsx', popoverStubs());
mockSource('src/components/pages/settings/Controls.tsx', {
  Row: ({ title, children }: any) => h('div', { className: 'row' }, title, children),
  Select: () => null,
});
mockSource('src/components/pages/settings/Rows.tsx', {
  groupBy: (arr: any[], key: (t: any) => string) => {
    const out: Record<string, any[]> = {};
    for (const a of arr) (out[key(a)] ??= []).push(a);
    return out;
  },
});
mockSource('src/components/ui/icons.tsx', iconStubs());
mockSource('src/store/hostAgent.ts', { hostAgentOf: (id: string) => (id.startsWith('acp:host-codex:') ? 'codex' : 'kimi') });
mockSource('src/lib/hostChats.ts', { hostOfChatNow: (id: string) => (id.startsWith('acp:host-') ? 'box' : '') });
const { followArchive } = await import('../src/store/remoteArchive.ts');
const { Archived } = await import('../src/components/pages/settings/Archived.tsx');

const thread = (id: string, name: string) => ({ id, name, updatedAt: 1, cwd: '/work' });
const view = (archived: number | null, momo: string | null = null) => ({ segments: null, kind: 'codex', meta: { archived, momo } }) as any;

test('a MoMo chat main archives joins the window’s archive but never shows in Archived chats; others still do', async () => {
  store.reset({
    threads: { a: thread('a', 'Fix the build'), m: thread('m', 'MoMo chat') },
    threadOrder: ['a', 'm'],
    // a later native session of MoMo's chat, listed by its harness under its own id
    archived: [thread('s9', 'MoMo on Claude')],
    claudeArchived: {},
    momoChats: { m: 'previous' },
    segments: { m: [{ nativeId: 'm' }, { nativeId: 's9' }] },
    savedProjects: [],
    prefs: {},
  });
  followArchive('m', view(10, 'previous'));
  followArchive('a', view(11));
  assert.deepEqual(retired, ['m', 'a']);
  assert.deepEqual(
    store.get().archived.map((t: any) => t.id),
    ['a', 'm', 's9'],
  );
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(h(Archived)));
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  assert.match(el.textContent!, /Fix the build/);
  assert.doesNotMatch(el.textContent!, /MoMo/);
  await act(async () => root.unmount());
  el.remove();
});

test('deleting an archived chat asks as the sidebar does: a chat on a machine says what happens there', async () => {
  store.reset({
    threads: {},
    threadOrder: [],
    archived: [thread('a', 'Local chat'), thread('acp:host-codex:u1', 'Codex on a machine')],
    claudeArchived: {},
    momoChats: {},
    segments: {},
    savedProjects: [],
    prefs: {},
  });
  const asked: string[] = [];
  Object.defineProperty(globalThis, 'confirm', { configurable: true, value: (m: string) => (asked.push(m), false) });
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(h(Archived)));
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  for (const button of el.querySelectorAll('button.icon-btn.xs')) await act(async () => (button as HTMLElement).click());
  assert.deepEqual(asked, [
    'Permanently delete this chat? This cannot be undone.',
    'Permanently delete this chat here and on its machine? This cannot be undone. Codex may keep a copy.',
  ]);
  await act(async () => root.unmount());
  el.remove();
});
